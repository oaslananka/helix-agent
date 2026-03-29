import { getTracer, withSpan } from '../observability/tracing.js';
import { Tool, zodToJsonSchema } from './types.js';
import { logger } from '../security/logger.js';
import { auditLogger } from '../security/auditLogger.js';
import { ToolNotFoundError, ToolExecutionError, ToolValidationError } from '../errors/index.js';

const tracer = getTracer('helix-agent.registry');

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    if (this.tools.has(tool.definition.name)) {
      logger.warn(
        { toolName: tool.definition.name },
        'Tool already registered, overwriting'
      );
    }
    this.tools.set(tool.definition.name, tool);
    logger.info({ toolName: tool.definition.name }, 'Tool registered');
  }

  registerMany(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Call a tool and audit log the execution
   */
  async callTool(name: string, args: unknown): Promise<any> {
    return withSpan(
      tracer,
      'agent.tool_call',
      { 'tool.name': name },
      async (span) => {
        const tool = this.getTool(name);
        if (!tool) {
          auditLogger.securityViolation('tool_not_found', { toolName: name, args });
          throw new ToolNotFoundError(name);
        }

        // validate args
        const parsedArgs = tool.definition.inputSchema.safeParse(args);
        if (!parsedArgs.success) {
          throw new ToolValidationError(name, parsedArgs.error.issues.map(i => i.message));
        }

        span.setAttribute('tool.args_valid', true);

        const startTime = Date.now();

        try {
          const response = await tool.handler(parsedArgs.data);
          const duration = Date.now() - startTime;
          span.setAttribute('tool.duration_ms', duration);

          auditLogger.toolCall(name, args, 'success', duration);

          return response;
        } catch (e: unknown) {
          const duration = Date.now() - startTime;
          span.setAttribute('tool.duration_ms', duration);

          auditLogger.toolCall(name, args, 'failure', duration, String(e));

          throw new ToolExecutionError(name, e, duration);
        }
      }
    );
  }

  exportCapabilities() {
    return this.getAll().map((tool) => ({
      name: tool.definition.name,
      description: tool.definition.description,
      inputSchema: zodToJsonSchema(tool.definition.inputSchema),
    }));
  }

  getNames(): string[] {
    return Array.from(this.tools.keys());
  }
}

export function createRegistry(): ToolRegistry {
  return new ToolRegistry();
}
