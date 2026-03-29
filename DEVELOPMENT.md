# Development Guide

This guide helps you understand the agent architecture and extend it with new tools.

## Project Structure

```
helix-agent/
├── src/
│   ├── index.ts                    # Agent bootstrap & main loop
│   ├── config/
│   │   └── env.ts                 # Environment validation (Zod)
│   ├── net/
│   │   ├── protocol.ts            # Agent Protocol v1 types & validators
│   │   └── wsClient.ts            # WebSocket client with reconnection
│   ├── tools/
│   │   ├── registry.ts            # Tool registry & capability export
│   │   ├── types.ts               # Tool interface & JSON Schema conversion
│   │   ├── repo/                  # Repository inspection tools
│   │   │   ├── listTree.ts
│   │   │   ├── readFile.ts
│   │   │   └── searchRg.ts
│   │   ├── git/                   # Git tools
│   │   │   ├── status.ts
│   │   │   ├── diff.ts
│   │   │   └── show.ts
│   │   ├── runner/                # Command execution
│   │   │   └── exec.ts
│   │   ├── logs/                  # Log utilities
│   │   │   └── tailFile.ts
│   │   ├── docker/                # Docker integration
│   │   │   └── docker.ts
│   │   └── http/                  # HTTP utilities
│   │       └── fetchLocal.ts
│   └── security/
│       ├── pathPolicy.ts          # Path validation & redaction
│       ├── policy.ts              # Concurrency control
│       └── logger.ts              # Structured logging
├── test/
│   ├── protocol.test.ts           # Protocol & tool tests
│   └── integration.test.ts        # WebSocket integration tests
├── Dockerfile                      # Docker image
├── docker-compose.yml              # Compose example
├── package.json                    # Dependencies
├── tsconfig.json                   # TypeScript config
├── vitest.config.ts               # Test config
├── .eslintrc.json                 # Linting rules
└── README.md                       # User documentation
```

## Core Concepts

### 1. Tool Interface

All tools follow this pattern:

```typescript
interface Tool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

interface ToolDefinition {
  name: string;                    // Unique identifier: "domain.action"
  description: string;             // For gateway documentation
  inputSchema: z.ZodSchema<any>;  // Zod validator for arguments
}

type ToolHandler = (args: unknown) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
}>;
```

### 2. Tool Creation

Use the factory pattern:

```typescript
export function createMyTool(
  allowedRoots: string[],
  maxOutputBytes: number,
  // ... other config
) {
  return createTool(
    'domain.myTool',
    'Description',
    InputArgsSchema,
    async (args) => {
      // Implementation
      return { content: [{ type: 'text', text: result }] };
    }
  );
}
```

### 3. Tool Registry

Tools are registered in `src/index.ts`:

```typescript
const registry = createRegistry();
registry.register(createMyTool(config.REPO_ROOTS_JSON, config.MAX_OUTPUT_BYTES));
```

The registry automatically:
- Exports tool capabilities to gateway
- Routes incoming calls to correct tool
- Validates arguments against schema

### 4. Security Layers

Each tool has access to security utilities:

```typescript
// Path validation (prevents traversal)
const resolvedPath = resolvePath(userPath, allowedRoots);

// Output limits (prevents memory bombs)
const truncated = truncateOutput(result, config.MAX_OUTPUT_BYTES);

// Redaction (removes sensitive data)
const redacted = redactSensitive(result, config.REDACT_REGEXES_JSON);
```

## Adding a New Tool

### Step 1: Create Tool Module

Create `src/tools/domain/myTool.ts`:

```typescript
import { z } from 'zod';
import { createTool } from '../types.js';
import { resolvePath, truncateOutput } from '../../security/pathPolicy.js';
import { logger } from '../../security/logger.js';

// Define input schema (Zod)
const MyToolArgsSchema = z.object({
  param1: z.string(),
  param2: z.number().int().optional().default(100),
});

// Create factory function
export function createMyTool(
  allowedRoots: string[],
  maxOutputBytes: number
) {
  return createTool(
    'domain.myTool',                          // Unique name
    'Description of what tool does',          // User documentation
    MyToolArgsSchema,                         // Input validation
    async (args) => {
      // Parse & validate arguments
      const parsed = MyToolArgsSchema.parse(args);

      try {
        // Implement tool logic
        // Example: use security utilities
        if (parsed.param1.includes('/')) {
          const resolved = resolvePath(parsed.param1, allowedRoots);
          // ... read file at resolved path
        }

        // Get your result
        const result = `Output: ${parsed.param1}`;

        // Apply output limit
        const truncated = truncateOutput(result, maxOutputBytes);

        // Return in standard format
        return {
          content: [{ type: 'text', text: truncated }],
        };
      } catch (e) {
        // Log but don't expose internals
        logger.warn({ error: String(e) }, 'Tool failed');
        throw e; // Will be caught by WS client
      }
    }
  );
}
```

### Step 2: Register Tool

In `src/index.ts`, add import and registration:

```typescript
import { createMyTool } from './tools/domain/myTool.js';

// In main():
if (config.ENABLE_MY_FEATURE) {
  registry.register(
    createMyTool(config.REPO_ROOTS_JSON, config.MAX_OUTPUT_BYTES)
  );
}
```

### Step 3: Add Config (Optional)

If tool needs configuration, add to `src/config/env.ts`:

```typescript
// In EnvSchema:
ENABLE_MY_FEATURE: z.coerce.boolean().default(false),
MY_FEATURE_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
```

And to `.env.example`:

```
ENABLE_MY_FEATURE=false
MY_FEATURE_TIMEOUT_MS=10000
```

### Step 4: Test

Create test in `test/myTool.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createMyTool } from '../src/tools/domain/myTool.js';

describe('domain.myTool', () => {
  it('should execute successfully', async () => {
    const tool = createMyTool(['/tmp'], 100000);
    const result = await tool.handler({
      param1: 'test',
      param2: 50,
    });

    expect(result.content[0].text).toContain('test');
  });

  it('should validate arguments', async () => {
    const tool = createMyTool(['/tmp'], 100000);
    
    // Should throw validation error
    await expect(() => 
      tool.handler({ param1: 123 }) // Wrong type
    ).rejects.toThrow();
  });
});
```

Run tests:

```bash
npm test
```

### Step 5: Document

Add to README.md under "Available Tools":

```markdown
### domain.myTool
Description of what it does.
```json
{
  "param1": "some value",
  "param2": 50
}
```
```

That's it! The tool is now:
- Automatically validated (Zod)
- Exposed to gateway via capabilities
- Protected by timeout & output limits
- Routable via WebSocket protocol

## Best Practices

### 1. Input Validation

Always use Zod schemas. They provide:
- Type safety
- Runtime validation
- Error messages
- JSON Schema export

```typescript
const SchemaSchema = z.object({
  path: z.string().min(1).max(1000),
  limit: z.number().int().positive().max(10000),
});
```

### 2. Error Handling

Be specific about errors:

```typescript
try {
  // Operation
} catch (e) {
  // For user: specific error
  if (e.code === 'ENOENT') {
    throw new Error('File not found: ...');
  }
  
  // For logs: full details
  logger.warn({ path, error: String(e) }, 'Operation failed');
  throw new Error('Operation failed');
}
```

### 3. Security

Always apply security layers:

```typescript
// Path validation
const resolved = resolvePath(userPath, allowedRoots);

// Output limits
const result = truncateOutput(output, maxOutputBytes);

// Redaction
const safe = redactSensitive(result, redactionPatterns);

// Timeouts (handled by WS client automatically)
// Just don't do infinite loops
```

### 4. Logging

Use structured logging:

```typescript
logger.info({ toolName: 'my.tool', duration: 100 }, 'Tool executed');
logger.warn({ param: value, error: e }, 'Tool failed');
logger.debug({ details: ... }, 'Debug info');
```

### 5. Performance

Keep tools fast:

- Set reasonable timeouts (default 30s)
- Respect output limits
- Don't process whole large files
- Use streaming where possible
- Cache if appropriate

## Protocol Deep Dive

### Register Message

When agent connects, it sends:

```typescript
{
  type: 'register',
  protocolVersion: 1,
  agentId: 'home-pc-1',
  agentName: 'Home Dev PC',
  meta: {
    os: 'linux',
    arch: 'x64',
    agentVersion: '1.0.0',
    repoRoots: ['/repo'],
    features: {
      enableRunner: false,
      enableGit: true,
      enableDocker: false,
      enableHttpFetch: false
    }
  },
  capabilities: {
    tools: [
      {
        name: 'repo.read_file',
        description: 'Read a file from the repository',
        inputSchema: { type: 'object', properties: { ... } }
      },
      // ... more tools
    ]
  }
}
```

This is built by the registry:

```typescript
// src/index.ts
const capabilities = registry.exportCapabilities();
const register = createRegisterMessage(..., capabilities, ...);
```

### Call Message

Gateway sends a tool call:

```typescript
{
  type: 'call',
  requestId: 'uuid-123',
  domain: 'tools',
  name: 'repo.read_file',
  arguments: { path: 'README.md' },
  timeoutMs: 30000
}
```

The WS client:
1. Acquires a concurrency permit
2. Finds the tool in registry
3. Validates arguments with schema
4. Executes with timeout
5. Returns result or error

### Call Result Message

Agent responds:

```typescript
// Success
{
  type: 'call_result',
  requestId: 'uuid-123',
  ok: true,
  result: {
    content: [
      { type: 'text', text: 'file content...' }
    ]
  }
}

// Error
{
  type: 'call_result',
  requestId: 'uuid-123',
  ok: false,
  error: {
    code: 'TIMEOUT',  // TOOL_ERROR, INVALID_ARGUMENTS, TIMEOUT, NOT_FOUND, POLICY_DENIED
    message: 'Operation timed out after 30000ms'
  }
}
```

## Testing

### Unit Tests

Test individual tools:

```typescript
import { createMyTool } from '../src/tools/domain/myTool.js';

describe('myTool', () => {
  it('should work', async () => {
    const tool = createMyTool(['/tmp'], 100000);
    const result = await tool.handler({ param: 'value' });
    expect(result.content[0].text).toBe('expected');
  });
});
```

### Integration Tests

Test protocol round-trips:

```typescript
// Uses mock gateway
const client = new WSClient(...);
await client.connect(config);
// Gateway sends call, verify response
```

### Manual Testing

```bash
# Start agent
npm run dev

# In another terminal, send WebSocket message
wscat -c ws://localhost:8080

# > {"type": "ping", "ts": 123}
# < {"type": "pong", "ts": 123}
```

## Debugging

### Logs

```bash
# Real-time logs
npm run dev

# With debug level
LOG_LEVEL=debug npm run dev

# Filter by tool
npm run dev | grep "repo.read_file"
```

### VS Code Debug

Add to `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Agent",
      "program": "${workspaceFolder}/dist/index.js",
      "preLaunchTask": "npm: build",
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "env": {
        "LOG_LEVEL": "debug",
        "REPO_ROOTS_JSON": "[\"${workspaceFolder}\"]"
      }
    }
  ]
}
```

### Common Issues

**Tool not found**:
- Check name in registry matches call name
- Check tool is registered in main()
- Check feature flag is enabled

**Validation error**:
- Check input schema matches call arguments
- Use `z.parse()` to debug schema issues

**Timeout**:
- Check tool is completing within timeoutMs
- Add logging to see where it hangs
- Check for infinite loops or locks

**Path errors**:
- Check REPO_ROOTS_JSON is set correctly
- Verify paths exist and are readable
- Check for symlink loops

## Performance Tuning

### Memory

- Reduce MAX_OUTPUT_BYTES (default 200KB)
- Reduce MAX_FILE_BYTES (default 2MB)
- Reduce MAX_SEARCH_MATCHES (default 2000)

### Speed

- Increase WS_PING_INTERVAL_MS if network is stable
- Increase WS_MAX_CONCURRENT_CALLS if gateway can handle it
- Use ripgrep (rg) for faster search

### Concurrency

- Adjust WS_MAX_CONCURRENT_CALLS based on:
  - Gateway capacity
  - Tool execution time
  - System resources

## Contributing

1. Create feature branch
2. Add tool or feature
3. Add tests
4. Update documentation
5. Run linting: `npm run lint`
6. Run tests: `npm test`
7. Submit PR

Code style:
- TypeScript strict mode
- Use Zod for validation
- Log with logger utility
- Apply security layers
- Write tests for new features
