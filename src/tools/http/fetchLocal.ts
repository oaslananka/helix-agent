import { ToolExecutionError, PolicyDeniedError } from '../../errors/index.js';
import { z } from 'zod';
import { createTool } from '../types.js';
import { truncateOutput } from '../../security/pathPolicy.js';
import { logger } from '../../security/logger.js';

const FetchLocalArgsSchema = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'POST']).default('GET'),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
});

export function createFetchLocalTool(
  maxOutputBytes: number,
  allowlist: string[]
) {
  return createTool(
    'http.fetch_local',
    `🌐 FETCH LOCAL HTTP ENDPOINT

Fetch from local/allowed HTTP endpoints - API testing and health checks.

WHEN TO USE:
• Test local APIs
• Health check endpoints
• Verify service responses
• Debug localhost applications

PARAMETERS:
• url: Full URL (must be in allowlist)
• method: HTTP method (GET or POST, default: GET)
• headers: Custom headers (optional)
• body: Request body for POST (optional)

EXAMPLES:
1. Simple GET request:
   {"url": "http://localhost:3000/health", "method": "GET"}

2. API with headers:
   {"url": "http://localhost:8080/api/users", "method": "GET", "headers": {"Authorization": "Bearer token"}}

3. POST request:
   {"url": "http://localhost:3000/api/data", "method": "POST", "body": "{\\"key\\": \\"value\\"}"}

4. JSON API:
   {"url": "http://localhost:5000/status", "method": "GET", "headers": {"Accept": "application/json"}}

COMMON USE CASES:
• Health checks: GET /health, /status, /ping
• API testing: Test endpoints during development
• Metrics: Fetch Prometheus metrics, stats
• Local services: Docker API, dev servers

ALLOWLIST:
• Only URLs in LOCAL_HTTP_ALLOWLIST_JSON are accessible
• Typically: localhost:*, 127.0.0.1:*
• Configure via environment variable
• Security: Prevents external access

BEST PRACTICES:
• Use for local development/testing only
• Verify endpoint is running first
• Check response for errors
• For external APIs, use runner.exec: curl

TROUBLESHOOTING:
• "Not in allowlist": Add to LOCAL_HTTP_ALLOWLIST_JSON
• Connection refused: Service not running
• Timeout: Check service health, increase limits`,
    FetchLocalArgsSchema,
    async (args) => {
      const parsed = FetchLocalArgsSchema.parse(args);

      // Check allowlist (host:port format)
      const url = new URL(parsed.url);
      const hostPort = `${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`;
      const isAllowed = allowlist.some((pattern) => {
        // Support wildcards or exact match
        if (pattern === '*') return true;
        if (pattern === hostPort) return true;
        // Simple hostname match
        if (pattern === url.hostname) return true;
        return false;
      });

      if (!isAllowed) {
        throw new PolicyDeniedError('URL not in allowlist', 'http.fetch_local');
      }

      try {
        const response = await fetch(parsed.url, {
          method: parsed.method,
          headers: parsed.headers,
          body: parsed.body,
        });

        const text = await response.text();
        const truncated = truncateOutput(text, maxOutputBytes);

        return {
          content: [
            {
              type: 'text',
              text: truncated,
            },
          ],
        };
      } catch (e: unknown) {
        logger.warn({ url: parsed.url, error: String(e) }, 'fetch failed');
        throw new ToolExecutionError('http.fetch_local', e);
      }
    }
  );
}
