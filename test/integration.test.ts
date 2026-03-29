import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { createServer } from 'http';
import {
  createRegisterMessage,
  parseIncomingMessage,
} from '../src/net/protocol.js';

describe('WebSocket Integration', () => {
  let server: ReturnType<typeof createServer>;
  let wsServer: WebSocketServer;
  let serverUrl: string;
  let client: WebSocket | null = null;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = createServer();
        wsServer = new WebSocketServer({ server });

        wsServer.on('connection', (ws) => {
          ws.on('message', (data) => {
            try {
              const raw = JSON.parse(data.toString()) as { type?: string };

              if (raw.type === 'register') {
                ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
                return;
              }

              parseIncomingMessage(data.toString());
            } catch (error) {
              throw error;
            }
          });
        });

        server.listen(0, 'localhost', () => {
          const addr = server.address();
          if (!addr || typeof addr === 'string') {
            throw new Error('Failed to bind test server');
          }
          serverUrl = `ws://localhost:${addr.port}`;
          resolve();
        });
      })
  );

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        const closeServer = () => {
          wsServer.close(() => {
            server.close(() => resolve());
          });
        };

        if (client && client.readyState === WebSocket.OPEN) {
          client.once('close', closeServer);
          client.close();
          return;
        }

        closeServer();
      })
  );

  it('should connect and send registration', async () => {
    await new Promise<void>((resolve, reject) => {
      client = new WebSocket(serverUrl, {
        headers: { 'X-Agent-Key': 'test-key' },
      });

      client.on('open', () => {
        const regMsg = createRegisterMessage(
          'test-agent',
          'Test Agent',
          ['/repo'],
          [
            {
              name: 'test.tool',
              description: 'Test tool',
              inputSchema: { type: 'object' },
            },
          ],
          { test: true },
          '1.0.0',
          'linux',
          'x64'
        );

        client.send(JSON.stringify(regMsg));
      });

      client.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        expect(msg.type).toBe('ping');
        client?.once('close', () => resolve());
        client?.close();
      });

      client.on('error', (error) => {
        reject(error);
      });
    });
  });
});
