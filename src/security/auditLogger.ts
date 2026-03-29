import pino from 'pino';
import { createStream } from 'rotating-file-stream';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';

export interface AuditEvent {
  eventType: 'tool_call' | 'security_violation' | 'system_operation' | 'auth' | 'error';
  toolName?: string;
  operation?: string;
  args?: unknown;
  result?: 'success' | 'failure' | 'denied';
  duration?: number;
  error?: string;
  user?: string;
  agentId?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  metadata?: Record<string, any>;
}

class AuditLogger {
  private logger: pino.Logger;
  private initialized = false;

  constructor() {
    // Initialize with console logger initially
    this.logger = pino({
      level: 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }

  async initialize(logDir: string, agentId: string): Promise<void> {
    if (this.initialized) return;

    try {
      // Ensure log directory exists
      await mkdir(logDir, { recursive: true });

      // Create rotating file stream for audit logs
      const auditStream = createStream('audit.log', {
        path: logDir,
        size: '10M', // Rotate every 10MB
        interval: '1d', // Rotate daily
        compress: 'gzip', // Compress rotated files
        maxFiles: 30, // Keep 30 days of logs
      });

      // Create rotating file stream for all logs
      const generalStream = createStream('agent.log', {
        path: logDir,
        size: '10M',
        interval: '1d',
        compress: 'gzip',
        maxFiles: 7, // Keep 7 days
      });

      // Multi-stream logger
      this.logger = pino(
        {
          level: process.env.LOG_LEVEL || 'info',
          timestamp: pino.stdTimeFunctions.isoTime,
          formatters: {
            level: (label) => {
              return { level: label };
            },
          },
          base: {
            agentId,
            pid: process.pid,
            hostname: process.env.AGENT_NAME || 'unknown',
          },
        },
        pino.multistream([
          { stream: process.stdout }, // Console
          { stream: generalStream }, // General logs
          {
            level: 'info',
            stream: auditStream, // Audit-specific logs
          },
        ])
      );

      this.initialized = true;
      this.logger.info({ logDir }, 'Audit logger initialized');
    } catch (e) {
      console.error('Failed to initialize audit logger:', e);
      // Fallback to console-only logging
    }
  }

  /**
   * Log an audit event for security-sensitive operations
   */
  audit(event: AuditEvent): void {
    const logEntry = {
      audit: true,
      timestamp: new Date().toISOString(),
      ...event,
    };

    // Determine log level based on event type and result
    if (event.result === 'failure' || event.result === 'denied') {
      this.logger.warn(logEntry, `Audit: ${event.eventType} - ${event.result}`);
    } else if (event.severity === 'critical' || event.severity === 'high') {
      this.logger.warn(logEntry, `Audit: ${event.eventType}`);
    } else {
      this.logger.info(logEntry, `Audit: ${event.eventType}`);
    }
  }

  /**
   * Log tool execution
   */
  toolCall(
    toolName: string,
    args: unknown,
    result: 'success' | 'failure',
    duration: number,
    error?: string
  ): void {
    this.audit({
      eventType: 'tool_call',
      toolName,
      args: this.sanitizeArgs(args),
      result,
      duration,
      error,
      severity: this.getToolSeverity(toolName),
    });
  }

  /**
   * Log system operations (file ops, process, service)
   */
  systemOperation(
    operation: string,
    details: Record<string, unknown>,
    result: 'success' | 'failure',
    error?: string
  ): void {
    this.audit({
      eventType: 'system_operation',
      operation,
      args: this.sanitizeArgs(details),
      result,
      error,
      severity: 'high', // System operations are always high severity
    });
  }

  /**
   * Log security violations
   */
  securityViolation(violation: string, details: Record<string, unknown>): void {
    this.audit({
      eventType: 'security_violation',
      operation: violation,
      args: details,
      result: 'denied',
      severity: 'critical',
    });
  }

  /**
   * Log authentication events
   */
  authEvent(event: string, result: 'success' | 'failure', details?: Record<string, unknown>): void {
    this.audit({
      eventType: 'auth',
      operation: event,
      result,
      args: details,
      severity: result === 'failure' ? 'high' : 'medium',
    });
  }

  /**
   * Sanitize sensitive data from args
   */
  private sanitizeArgs(args: unknown): unknown {
    if (!args) return args;

    if (typeof args !== 'object' || args === null) return args;
    const sanitized: Record<string, any> = { ...args };

    // Redact sensitive fields
    const sensitiveKeys = ['password', 'token', 'key', 'secret', 'apiKey', 'apiSecret'];

    for (const key of sensitiveKeys) {
      if (key in sanitized) {
        sanitized[key] = '[REDACTED]';
      }
    }

    // Truncate large content
    if (sanitized.content && typeof sanitized.content === 'string' && sanitized.content.length > 200) {
      sanitized.content = sanitized.content.substring(0, 200) + '... [TRUNCATED]';
    }

    return sanitized;
  }

  /**
   * Determine severity based on tool name
   */
  private getToolSeverity(toolName: string): AuditEvent['severity'] {
    if (toolName.startsWith('system.')) return 'high';
    if (toolName === 'runner.exec') return 'high';
    if (toolName.startsWith('docker.')) return 'medium';
    if (toolName.startsWith('git.')) return 'low';
    return 'low';
  }

  /**
   * Get the underlying logger for general use
   */
  getLogger(): pino.Logger {
    return this.logger;
  }
}

// Singleton instance
export const auditLogger = new AuditLogger();
