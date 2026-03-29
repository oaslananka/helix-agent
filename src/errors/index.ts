/**
 * Helix Agent — Typed Error Hierarchy
 *
 * Tüm runtime hataları bu class'lardan türemelidir.
 * Bu sayede catch bloklarında `instanceof` ile tip güvenli hata yönetimi yapılır.
 */
export abstract class HelixAgentError extends Error {
  abstract get _tag(): string;

  get name(): string {
    return this._tag;
  }

  constructor(
    message: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      _tag: this._tag,
      message: this.message,
      context: this.context,
    };
  }
}

// Tool Errors
export class ToolNotFoundError extends HelixAgentError {
  get _tag() { return 'ToolNotFoundError'; }
  constructor(public readonly toolName: string) {
    super(`Tool not found: ${toolName}`, { toolName });
  }
}

export class ToolExecutionError extends HelixAgentError {
  get _tag() { return 'ToolExecutionError'; }
  constructor(
    public readonly toolName: string,
    cause: unknown,
    public readonly duration?: number
  ) {
    super(`Tool execution failed: ${toolName}`, {
      toolName,
      cause: cause instanceof Error ? cause.message : String(cause),
      duration,
    });
  }
}

export class ToolTimeoutError extends HelixAgentError {
  get _tag() { return 'ToolTimeoutError'; }
  constructor(public readonly toolName: string, public readonly timeoutMs: number) {
    super(`Tool timed out after ${timeoutMs}ms: ${toolName}`, { toolName, timeoutMs });
  }
}

export class ToolValidationError extends HelixAgentError {
  get _tag() { return 'ToolValidationError'; }
  constructor(
    public readonly toolName: string,
    public readonly validationIssues: string[]
  ) {
    super(`Invalid arguments for tool: ${toolName}`, { toolName, validationIssues });
  }
}

// Security Errors
export class PathTraversalError extends HelixAgentError {
  get _tag() { return 'PathTraversalError'; }
  constructor(public readonly attemptedPath: string) {
    super(`Path traversal attempt blocked: ${attemptedPath}`, {
      attemptedPath: '[REDACTED]', // Don't log the actual path
    });
  }
}

export class PolicyDeniedError extends HelixAgentError {
  get _tag() { return 'PolicyDeniedError'; }
  constructor(public readonly reason: string, public readonly toolName?: string) {
    super(`Policy denied: ${reason}`, { reason, toolName });
  }
}

export class OutputLimitExceededError extends HelixAgentError {
  get _tag() { return 'OutputLimitExceededError'; }
  constructor(public readonly bytes: number, public readonly limitBytes: number) {
    super(`Output exceeds limit: ${bytes} > ${limitBytes} bytes`, { bytes, limitBytes });
  }
}

// Network / Connection Errors
export class GatewayConnectionError extends HelixAgentError {
  get _tag() { return 'GatewayConnectionError'; }
  constructor(public readonly url: string, cause?: unknown) {
    super(`Failed to connect to gateway: ${url}`, {
      url,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

export class GatewayAuthError extends HelixAgentError {
  get _tag() { return 'GatewayAuthError'; }
  constructor(public readonly reason: string) {
    super(`Gateway authentication failed: ${reason}`, { reason });
  }
}

export class MessageParseError extends HelixAgentError {
  get _tag() { return 'MessageParseError'; }
  constructor(cause: unknown) {
    super(`Failed to parse gateway message`, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

// Config Errors
export class ConfigurationError extends HelixAgentError {
  get _tag() { return 'ConfigurationError'; }
  constructor(message: string, public readonly field?: string) {
    super(message, { field });
  }
}

// Plugin Errors
export class PluginLoadError extends HelixAgentError {
  get _tag() { return 'PluginLoadError'; }
  constructor(public readonly pluginPath: string, cause: unknown) {
    super(`Failed to load plugin: ${pluginPath}`, {
      pluginPath,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

// Type Guards
export function isHelixAgentError(err: unknown): err is HelixAgentError {
  return err instanceof HelixAgentError;
}

export function isSecurityError(err: unknown): err is PathTraversalError | PolicyDeniedError {
  return err instanceof PathTraversalError || err instanceof PolicyDeniedError;
}

/**
 * Map HelixAgentError to MCP error code for protocol response
 */
export function toMcpErrorCode(err: HelixAgentError): string {
  const mapping: Record<string, string> = {
    ToolNotFoundError: 'NOT_FOUND',
    ToolExecutionError: 'TOOL_ERROR',
    ToolTimeoutError: 'TIMEOUT',
    ToolValidationError: 'INVALID_ARGS',
    PathTraversalError: 'POLICY_DENIED',
    PolicyDeniedError: 'POLICY_DENIED',
    OutputLimitExceededError: 'TOOL_ERROR',
    GatewayConnectionError: 'CONNECTION_ERROR',
    GatewayAuthError: 'AUTH_ERROR',
    MessageParseError: 'PARSE_ERROR',
    ConfigurationError: 'CONFIG_ERROR',
    PluginLoadError: 'PLUGIN_ERROR',
  };
  return mapping[err._tag] ?? 'UNKNOWN_ERROR';
}
