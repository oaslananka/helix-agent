import { ConfigurationError } from '../errors/index.js';
import { z } from 'zod';
import process from 'process';

const AllowlistEntrySchema = z.object({
  cmd: z.string(),
  argsPrefix: z.array(z.string()),
});

const EnvSchema = z.object({
  // Agent Identity
  AGENT_ID: z.string().min(1),
  AGENT_NAME: z.string().min(1),

  // Gateway
  GATEWAY_WS_URL: z.string().url(),
  AGENT_KEY: z.string().min(1),

  // Repositories
  REPO_ROOTS_JSON: z.string().transform((val) => {
    try {
      const parsed = JSON.parse(val);
      if (!Array.isArray(parsed)) throw new ConfigurationError('Must be array');
      return parsed as string[];
    } catch (e) {
      throw new ConfigurationError(`REPO_ROOTS_JSON must be valid JSON array: ${e}`, 'REPO_ROOTS_JSON');
    }
  }),

  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Output Limits
  MAX_OUTPUT_BYTES: z.coerce.number().int().positive().default(200000),
  MAX_FILE_BYTES: z.coerce.number().int().positive().default(2000000),
  MAX_SEARCH_MATCHES: z.coerce.number().int().positive().default(2000),
  MAX_TREE_ENTRIES: z.coerce.number().int().positive().default(50000),

  // WebSocket
  WS_PING_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  WS_RECONNECT_MAX_MS: z.coerce.number().int().positive().default(30000),
  WS_MAX_CONCURRENT_CALLS: z.coerce.number().int().positive().default(4),

  // Feature Toggles
  ENABLE_RUNNER: z.string().transform(val => val === 'true').default('false'),
  ENABLE_GIT: z.string().transform(val => val === 'true').default('true'),
  ENABLE_DOCKER: z.string().transform(val => val === 'true').default('false'),
  ENABLE_HTTP_FETCH: z.string().transform(val => val === 'true').default('false'),
  ENABLE_SYSTEM_TOOLS: z.string().transform(val => val === 'true').default('false'),
  ENABLE_UNRESTRICTED_MODE: z.string().transform(val => val === 'true').default('false'),
  AGENT_EXPECTS_PREFIX: z.string().transform(val => val === 'true').default('false'),

  // New Feature Toggles
  ENABLE_DATABASE: z.string().transform(val => val === 'true').default('false'),
  ENABLE_KUBERNETES: z.string().transform(val => val === 'true').default('false'),
  ENABLE_NETWORK: z.string().transform(val => val === 'true').default('false'),
  ENABLE_MCP_PROXY: z.string().transform(val => val === 'true').default('false'),
  ENABLE_CLI_TOOLS: z.string().transform(val => val === 'true').default('false'),

  // Runner Configuration
  RUNNER_ALLOWLIST_JSON: z
    .string()
    .optional()
    .default('[]')
    .transform((val) => {
      try {
        const parsed = JSON.parse(val);
        if (!Array.isArray(parsed)) throw new ConfigurationError('Must be array');
        return z.array(AllowlistEntrySchema).parse(parsed);
      } catch (e) {
        throw new ConfigurationError(`RUNNER_ALLOWLIST_JSON must be valid JSON array: ${e}`);
      }
    }),
  RUNNER_CWD: z.string().optional().default('./repo'),
  RUNNER_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),

  // Redaction
  REDACT_REGEXES_JSON: z
    .string()
    .optional()
    .default('[]')
    .transform((val) => {
      try {
        const parsed = JSON.parse(val);
        if (!Array.isArray(parsed)) throw new ConfigurationError('Must be array');
        return (parsed as string[]).map((p) => new RegExp(p, 'g'));
      } catch (e) {
        throw new ConfigurationError(`REDACT_REGEXES_JSON must be valid JSON array of regex: ${e}`);
      }
    }),

  // Optional: Log Roots
  LOG_ROOTS_JSON: z
    .string()
    .optional()
    .default('[]')
    .transform((val) => {
      try {
        const parsed = JSON.parse(val);
        if (!Array.isArray(parsed)) throw new ConfigurationError('Must be array');
        return parsed as string[];
      } catch (e) {
        throw new ConfigurationError(`LOG_ROOTS_JSON must be valid JSON array: ${e}`, 'LOG_ROOTS_JSON');
      }
    }),

  // Local HTTP Allowlist
  LOCAL_HTTP_ALLOWLIST_JSON: z
    .string()
    .optional()
    .default('[]')
    .transform((val) => {
      try {
        const parsed = JSON.parse(val);
        if (!Array.isArray(parsed)) throw new ConfigurationError('Must be array');
        return parsed as string[];
      } catch (e) {
        throw new ConfigurationError(`LOCAL_HTTP_ALLOWLIST_JSON must be valid JSON array: ${e}`, 'LOCAL_HTTP_ALLOWLIST_JSON');
      }
    }),

  // Docker
  DOCKER_SOCKET_PATH: z.string().optional().default('/var/run/docker.sock'),

  // Agent Version & Features
  AGENT_VERSION: z.string().optional().default('1.0.0'),

  // Audit Logging
  AUDIT_LOG_DIR: z.string().optional().default('./logs'),
  AUDIT_LOG_ENABLED: z.string().transform(val => val === 'true').default('true'),

  // Dashboard
  DASHBOARD_ENABLED: z.string().transform(val => val === 'true').default('false'),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(3001),
  DASHBOARD_AUTH_TOKEN: z.string().optional().default(''),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(): Config {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Configuration validation failed:');
    console.error(result.error.issues);
    process.exit(1);
  }
  return result.data;
}
