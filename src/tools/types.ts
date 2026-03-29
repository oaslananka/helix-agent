import { z } from 'zod';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodSchema<any>;
}

export interface ToolHandler {
  (args: unknown): Promise<{
    content: Array<{ type: 'text'; text: string }>;
  }>;
}

export interface Tool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export function createTool(
  name: string,
  description: string,
  inputSchema: z.ZodSchema<any>,
  handler: ToolHandler
): Tool {
  return {
    definition: {
      name,
      description,
      inputSchema,
    },
    handler,
  };
}

/**
 * Convert zod schema to JSON Schema for protocol
 */
export function zodToJsonSchema(schema: z.ZodSchema<any>): Record<string, unknown> {
  // Check if this is a ZodObject by looking for shape property
  const schemaAny = schema as any;
  if (schemaAny._def?.typeName === 'ZodObject' || schemaAny.shape) {
    const shape = schemaAny.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    if (!shape) {
      return { type: 'object', additionalProperties: true };
    }

    for (const [key, value] of Object.entries(shape)) {
      const field = value as z.ZodTypeAny;
      properties[key] = zodFieldToJsonSchema(field);

      // Check if field is required (not optional, not has default)
      const fieldAny = field as any;
      const typeName = fieldAny._def?.typeName;
      if (typeName !== 'ZodOptional' && typeName !== 'ZodDefault') {
        required.push(key);
      }
    }

    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  // Fallback for non-object schemas - use empty object to avoid validation errors
  return { type: 'object', additionalProperties: true };
}

function zodFieldToJsonSchema(field: z.ZodTypeAny): Record<string, unknown> {
  const fieldAny = field as any;
  const typeName = fieldAny._def?.typeName;

  // Handle ZodDefault first - unwrap and add default value
  if (typeName === 'ZodDefault') {
    const innerSchema = zodFieldToJsonSchema(fieldAny._def.innerType);
    return {
      ...innerSchema,
      default: fieldAny._def.defaultValue(),
    };
  }
  
  // Handle ZodOptional - unwrap the inner schema
  if (typeName === 'ZodOptional') {
    return zodFieldToJsonSchema(fieldAny._def.innerType);
  }

  if (typeName === 'ZodString') {
    return { type: 'string' };
  }
  if (typeName === 'ZodNumber') {
    const def = fieldAny._def;
    const schema: Record<string, unknown> = { type: 'number' };
    // Check for integer constraint
    if (def.checks) {
      for (const check of def.checks) {
        if (check.kind === 'int') {
          schema.type = 'integer';
        }
      }
    }
    return schema;
  }
  if (typeName === 'ZodBoolean') {
    return { type: 'boolean' };
  }
  if (typeName === 'ZodArray') {
    return {
      type: 'array',
      items: zodFieldToJsonSchema(fieldAny._def.type),
    };
  }
  if (typeName === 'ZodEnum') {
    return {
      type: 'string',
      enum: fieldAny._def.values,
    };
  }
  if (typeName === 'ZodLiteral') {
    return {
      type: typeof fieldAny._def.value,
      const: fieldAny._def.value,
    };
  }
  // Fallback to string type for unsupported Zod types
  return { type: 'string' };
}
