import { ToolNotFoundError, ToolValidationError, ToolExecutionError, ToolTimeoutError, GatewayConnectionError, isHelixAgentError, toMcpErrorCode } from '../errors/index.js';
import WebSocket from 'ws';
import { logger } from '../security/logger.js';
import { Config } from '../config/env.js';
import {
  parseIncomingMessage,
  createPongMessage,
  createRegisterMessage,
  createCallResultSuccess,
  createCallResultError,
  isPingMessage,
  isCallMessage,
  isRegisteredMessage,
  CallMessage,
  OutgoingMessage,
  ContentItem,
} from './protocol.js';
import { ToolRegistry } from '../tools/registry.js';
import { ConcurrencyController } from '../security/policy.js';
import { z } from 'zod';

interface WSClientConfig {
  url: string;
  agentId: string;
  agentKey: string;
  pingInterval: number;
  reconnectMaxMs: number;
}

type MessageHandler = (msg: OutgoingMessage) => Promise<void>;

export class WSClient {
  private ws: WebSocket | null = null;
  private config: WSClientConfig;
  private toolRegistry: ToolRegistry;
  private concurrency: ConcurrencyController;
  private messageHandler: MessageHandler;
  private connected = false;
  private reconnectAttempt = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private pendingRequests = new Map<string, { timer: NodeJS.Timeout }>();
  private registeredTools: ToolRegistry | null = null;

  constructor(
    config: WSClientConfig,
    toolRegistry: ToolRegistry,
    concurrency: ConcurrencyController,
    messageHandler: MessageHandler
  ) {
    this.config = config;
    this.toolRegistry = toolRegistry;
    this.concurrency = concurrency;
    this.messageHandler = messageHandler;
  }

  async connect(agentConfig: Config): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let registered = false;

      try {
        // Gateway expects token in URL query parameter, not agentId
        // AgentId is sent in the register message after connection
        const url = this.config.url;

        logger.info({ url }, 'Connecting to gateway');

        this.ws = new WebSocket(url, {
          headers: {
            'X-Agent-Key': this.config.agentKey,
          },
        });

        this.ws.on('open', () => {
          logger.info('Connected to gateway');
          this.connected = true;
          this.reconnectAttempt = 0;
          this.startHeartbeat();

          // Send registration
          this.register(agentConfig).catch((e) => {
            logger.error({ error: String(e) }, 'Registration failed');
            this.disconnect();
            if (!settled) {
              settled = true;
              reject(e instanceof Error ? e : new Error(String(e)));
            }
          });
        });

        this.ws.on('message', (data: WebSocket.RawData) => {
          let text: string;
          if (typeof data === 'string') {
            text = data;
          } else if (Array.isArray(data)) {
            text = Buffer.concat(data).toString('utf-8');
          } else if (data instanceof ArrayBuffer) {
            text = Buffer.from(data).toString('utf-8');
          } else {
            text = Buffer.from(data as unknown as Uint8Array).toString('utf-8');
          }

          try {
            const raw = JSON.parse(text) as { type?: string; error?: string };
            if (!registered && raw.type === 'registered' && !settled) {
              registered = true;
              settled = true;
              resolve();
            } else if (!registered && raw.type === 'error' && !settled) {
              settled = true;
              reject(new GatewayConnectionError(this.config.url, raw.error || 'Gateway rejected registration'));
              this.disconnect().catch(() => {
                logger.warn('Failed to disconnect after registration error');
              });
            }
          } catch {
            // Fall through to protocol parsing below.
          }

          this.handleMessage(text).catch((e) => {
            logger.error({ error: String(e) }, 'Message handling failed');
          });
        });

        this.ws.on('error', (error: Error) => {
          logger.error({ error: String(error) }, 'WebSocket error');
        });

        this.ws.on('close', () => {
          logger.info('Disconnected from gateway');
          this.connected = false;
          this.stopHeartbeat();
          this.concurrency.rejectAll('WebSocket disconnected');
          this.pendingRequests.clear();

          if (!settled) {
            settled = true;
            reject(new GatewayConnectionError(this.config.url, 'WebSocket closed before registration completed'));
          }

          // Attempt reconnect
          this.scheduleReconnect(agentConfig);
        });
      } catch (e) {
        logger.error({ error: String(e) }, 'Connection error');
        if (!settled) {
          settled = true;
          reject(new GatewayConnectionError(this.config.url, e));
        }
      }
    });
  }

  private scheduleReconnect(agentConfig: Config): void {
    this.reconnectAttempt++;
    const backoffMs = Math.min(
      1000 * Math.pow(2, this.reconnectAttempt - 1),
      this.config.reconnectMaxMs
    );
    const jitter = Math.random() * backoffMs * 0.1;
    const delayMs = backoffMs + jitter;

    logger.info(
      { attempt: this.reconnectAttempt, delayMs },
      'Scheduling reconnect'
    );

    setTimeout(() => {
      this.connect(agentConfig).catch((e) => {
        logger.error({ error: String(e) }, 'Reconnect failed, will retry');
      });
    }, delayMs);
  }

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      if (this.connected && this.ws) {
        this.ws.ping();
      }
    }, this.config.pingInterval);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private async handleMessage(data: string): Promise<void> {
    logger.info({ messageType: data.substring(0, 100) }, "📨 Message received from gateway");
    try {
      const msg = parseIncomingMessage(data);

      if (isPingMessage(msg)) {
        // Gateway uses WebSocket frame-level ping/pong
        // No need to respond with application-level pong message
        // logger.debug('Received application-level ping (ignoring, using WS frames)');
        return;
      }

      if (isRegisteredMessage(msg)) {
        logger.info({ gatewayVersion: msg.gatewayVersion }, 'Registration confirmed by gateway');
        return;
      }

      if (isCallMessage(msg)) {
        await this.handleCall(msg);
        return;
      }

      logger.warn({ msg }, 'Unknown message type');
    } catch (e) {
      logger.error({ error: String(e), data }, 'Failed to parse message');
    }
  }

  private async handleCall(call: CallMessage): Promise<void> {
    const { requestId, name, arguments: args, timeoutMs } = call;

    try {
      // Check concurrency
      await this.concurrency.acquire(requestId);

      // Get tool
      const tool = this.toolRegistry.getTool(name);
      if (!tool) {
        await this.sendMessage(
          createCallResultError(requestId, 'NOT_FOUND', `Tool not found: ${name}`)
        );
        this.concurrency.release(requestId);
        return;
      }

      // Validate arguments
      let parsedArgs: unknown;
      try {
        parsedArgs = tool.definition.inputSchema.parse(args);
      } catch (e) {
        if (e instanceof z.ZodError) {
          await this.sendMessage(
            createCallResultError(
              requestId,
              'INVALID_ARGUMENTS',
              `Invalid arguments: ${e.message}`
            )
          );
          this.concurrency.release(requestId);
          return;
        }
        throw e;
      }

      // Execute with timeout
      try {
        const startTime = Date.now();
        const result = await this.executeWithTimeout(
          () => tool.handler(parsedArgs),
          timeoutMs,
          requestId
        );
        const duration = Date.now() - startTime;

        // Audit log successful execution
        const { auditLogger } = await import('../security/auditLogger.js');
        auditLogger.toolCall(name, parsedArgs, 'success', duration);

        await this.sendMessage(createCallResultSuccess(requestId, result.content));
      } catch (e) {
        const duration = Date.now() - (Date.now() - timeoutMs);
        const errorMsg = String(e);
        const code = errorMsg.includes('timeout') ? 'TIMEOUT' : 'TOOL_ERROR';

        // Audit log failed execution
        const { auditLogger } = await import('../security/auditLogger.js');
        auditLogger.toolCall(name, parsedArgs, 'failure', duration, errorMsg);

        await this.sendMessage(createCallResultError(requestId, code, errorMsg));
      } finally {
        this.concurrency.release(requestId);
      }
    } catch (e) {
      logger.error({ requestId, error: String(e) }, 'Call handling failed');
      try {
        await this.sendMessage(
          createCallResultError(requestId, 'TOOL_ERROR', String(e))
        );
      } catch {
        logger.error({ requestId }, 'Failed to send error response');
      }
    }
  }

  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    requestId: string
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let completed = false;

      const timer = setTimeout(() => {
        if (!completed) {
          completed = true;
          this.pendingRequests.delete(requestId);
          reject(new ToolTimeoutError('unknown', timeoutMs));
        }
      }, timeoutMs);

      this.pendingRequests.set(requestId, { timer });

      fn()
        .then((result) => {
          if (!completed) {
            completed = true;
            clearTimeout(timer);
            this.pendingRequests.delete(requestId);
            resolve(result);
          }
        })
        .catch((error) => {
          if (!completed) {
            completed = true;
            clearTimeout(timer);
            this.pendingRequests.delete(requestId);
            reject(error);
          }
        });
    });
  }

  private async register(config: Config): Promise<void> {
    const tools = this.toolRegistry.exportCapabilities();

    const msg = createRegisterMessage(
      config.AGENT_ID,
      config.AGENT_NAME,
      config.REPO_ROOTS_JSON,
      tools,
      {
        enableRunner: config.ENABLE_RUNNER,
        enableGit: config.ENABLE_GIT,
        enableDocker: config.ENABLE_DOCKER,
        enableHttpFetch: config.ENABLE_HTTP_FETCH,
      },
      config.AGENT_VERSION,
      process.platform,
      process.arch
    );

    await this.sendMessage(msg);
    logger.info({ tools: tools.length }, 'Registered with gateway');
  }

  async sendCallResult(requestId: string, content: ContentItem[]): Promise<void> {
    await this.sendMessage(createCallResultSuccess(requestId, content));
  }

  async sendStreamChunk(chunk: import('./streaming.js').StreamChunk): Promise<void> {
    await this.sendMessage({
      type: 'stream_chunk',
      ...chunk,
    });
  }

  private async sendMessage(msg: OutgoingMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const data = JSON.stringify(msg);
      this.ws.send(data, (error?: Error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat();
    if (this.ws) {
      return new Promise((resolve) => {
        if (this.ws) {
          this.ws.close();
          this.ws.on('close', resolve);
          setTimeout(resolve, 5000); // Force close after 5s
        }
      });
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}
