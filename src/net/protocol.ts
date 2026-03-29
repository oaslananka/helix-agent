import { z } from 'zod';

// ===== Message Types =====

// Shared schemas
const ContentItemSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export type ContentItem = z.infer<typeof ContentItemSchema>;

const CallErrorSchema = z.object({
  code: z.enum(['TOOL_ERROR', 'INVALID_ARGUMENTS', 'TIMEOUT', 'NOT_FOUND', 'POLICY_DENIED']),
  message: z.string(),
});

export type CallError = z.infer<typeof CallErrorSchema>;

// Register message
const RegisterMessageSchema = z.object({
  type: z.literal('register'),
  protocolVersion: z.literal(1),
  agentId: z.string(),
  agentName: z.string(),
  meta: z.object({
    os: z.string(),
    arch: z.string(),
    agentVersion: z.string(),
    repoRoots: z.array(z.string()),
    features: z.record(z.boolean()),
  }),
  capabilities: z.object({
    tools: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        inputSchema: z.record(z.unknown()),
      })
    ),
    resources: z.array(z.unknown()).default([]),
    prompts: z.array(z.unknown()).default([]),
  }),
});

export type RegisterMessage = z.infer<typeof RegisterMessageSchema>;

// Ping/Pong
const PingMessageSchema = z.object({
  type: z.literal('ping'),
  ts: z.number(),
});

const PongMessageSchema = z.object({
  type: z.literal('pong'),
  ts: z.number(),
});

export type PingMessage = z.infer<typeof PingMessageSchema>;
export type PongMessage = z.infer<typeof PongMessageSchema>;

// Registered confirmation from gateway
const RegisteredMessageSchema = z.object({
  type: z.literal('registered'),
  protocolVersion: z.number(),
  gatewayVersion: z.string(),
});

export type RegisteredMessage = z.infer<typeof RegisteredMessageSchema>;

// Capabilities update
const CapabilitiesUpdateMessageSchema = z.object({
  type: z.literal('capabilities_update'),
  protocolVersion: z.literal(1),
  capabilities: z.object({
    tools: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        inputSchema: z.record(z.unknown()),
      })
    ),
    resources: z.array(z.unknown()).optional(),
    prompts: z.array(z.unknown()).optional(),
  }),
});

export type CapabilitiesUpdateMessage = z.infer<typeof CapabilitiesUpdateMessageSchema>;

// Stream chunk
export const StreamChunkMessageSchema = z.object({
  type: z.literal('stream_chunk'),
  callId: z.string(),
  index: z.number().int().min(0),
  content: z.string(),
  isFinal: z.boolean(),
});

export type StreamChunkMessage = z.infer<typeof StreamChunkMessageSchema>;


// Incoming call
const CallMessageSchema = z.object({
  type: z.literal('call'),
  requestId: z.string(),
  domain: z.literal('tools'),
  name: z.string(),
  arguments: z.record(z.unknown()).default({}),
  timeoutMs: z.number().int().positive().optional().default(30000),
});

export type CallMessage = z.infer<typeof CallMessageSchema>;

// Call result (success)
const CallResultSuccessSchema = z.object({
  type: z.literal('call_result'),
  requestId: z.string(),
  ok: z.literal(true),
  result: z.object({
    content: z.array(ContentItemSchema),
  }),
});

// Call result (error)
const CallResultErrorSchema = z.object({
  type: z.literal('call_result'),
  requestId: z.string(),
  ok: z.literal(false),
  error: CallErrorSchema,
});

export type CallResultSuccess = z.infer<typeof CallResultSuccessSchema>;
export type CallResultError = z.infer<typeof CallResultErrorSchema>;
export type CallResult = CallResultSuccess | CallResultError;

// All outgoing message types (use union instead of discriminatedUnion for call_result variants)
const CallResultSchema = z.union([CallResultSuccessSchema, CallResultErrorSchema]);
const OutgoingMessageSchema = z.union([
  StreamChunkMessageSchema,
  RegisterMessageSchema,
  PongMessageSchema,
  CapabilitiesUpdateMessageSchema,
  CallResultSchema,
]);

export type OutgoingMessage = z.infer<typeof OutgoingMessageSchema>;

// All incoming message types
const IncomingMessageSchema = z.discriminatedUnion('type', [
  PingMessageSchema,
  CallMessageSchema,
  RegisteredMessageSchema,
]);

export type IncomingMessage = z.infer<typeof IncomingMessageSchema>;

// ===== Validators =====

export function parseIncomingMessage(data: string): IncomingMessage {
  const parsed = JSON.parse(data);
  return IncomingMessageSchema.parse(parsed);
}

export function validateOutgoingMessage(msg: unknown): OutgoingMessage {
  return OutgoingMessageSchema.parse(msg);
}

export function isCallMessage(msg: IncomingMessage): msg is CallMessage {
  return msg.type === 'call';
}

export function isPingMessage(msg: IncomingMessage): msg is PingMessage {
  return msg.type === 'ping';
}

export function isRegisteredMessage(msg: IncomingMessage): msg is RegisteredMessage {
  return msg.type === 'registered';
}

// ===== Helpers =====

export function createRegisterMessage(
  agentId: string,
  agentName: string,
  repoRoots: string[],
  tools: RegisterMessage['capabilities']['tools'],
  features: Record<string, boolean>,
  agentVersion: string,
  os: string,
  arch: string
): RegisterMessage {
  return {
    type: 'register',
    protocolVersion: 1,
    agentId,
    agentName,
    meta: {
      os,
      arch,
      agentVersion,
      repoRoots,
      features,
    },
    capabilities: {
      tools,
      resources: [],
      prompts: [],
    },
  };
}

export function createPongMessage(ts: number): PongMessage {
  return {
    type: 'pong',
    ts,
  };
}

export function createCallResultSuccess(
  requestId: string,
  content: ContentItem[]
): CallResultSuccess {
  return {
    type: 'call_result',
    requestId,
    ok: true,
    result: {
      content,
    },
  };
}

export function createCallResultError(
  requestId: string,
  code: CallError['code'],
  message: string
): CallResultError {
  return {
    type: 'call_result',
    requestId,
    ok: false,
    error: {
      code,
      message,
    },
  };
}

export function createCapabilitiesUpdateMessage(
  tools: CapabilitiesUpdateMessage['capabilities']['tools']
): CapabilitiesUpdateMessage {
  return {
    type: 'capabilities_update',
    protocolVersion: 1,
    capabilities: {
      tools,
    },
  };
}
