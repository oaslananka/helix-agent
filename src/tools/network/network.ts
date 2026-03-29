import { ToolExecutionError, PolicyDeniedError } from '../../errors/index.js';
import { z } from 'zod';
import { createTool } from '../types.js';
import { truncateOutput } from '../../security/pathPolicy.js';
import { logger } from '../../security/logger.js';
import { execa } from 'execa';

// Network Ports Tool
const NetPortsArgsSchema = z.object({
    state: z.enum(['all', 'listening', 'established']).default('listening'),
    protocol: z.enum(['all', 'tcp', 'udp']).default('all'),
});

export function createNetPortsTool(maxOutputBytes: number) {
    return createTool(
        'net.ports',
        `🔌 NETWORK PORTS

List network ports and connections.

PARAMETERS:
• state: Connection state filter (all, listening, established) - default: listening
• protocol: Protocol filter (all, tcp, udp) - default: all

EXAMPLES:
1. List listening ports:
   {"state": "listening"}

2. All TCP connections:
   {"state": "all", "protocol": "tcp"}

3. Established connections only:
   {"state": "established"}

OUTPUT INCLUDES:
• Protocol (tcp/udp)
• Local address:port
• Foreign address (for established)
• State
• Process (if available)

USE CASES:
• Check if service is listening on expected port
• Find port conflicts
• Debug connection issues
• Monitor active connections`,
        NetPortsArgsSchema,
        async (args) => {
            const parsed = NetPortsArgsSchema.parse(args);

            try {
                let output: string;
                const isWindows = process.platform === 'win32';

                if (isWindows) {
                    // Windows: netstat
                    const netstatArgs = ['-ano'];
                    if (parsed.protocol === 'tcp') netstatArgs.push('-p', 'TCP');
                    if (parsed.protocol === 'udp') netstatArgs.push('-p', 'UDP');

                    const result = await execa('netstat', netstatArgs, { timeout: 15000, reject: false });
                    output = result.stdout;

                    // Filter by state if needed
                    if (parsed.state === 'listening') {
                        output = output.split('\n').filter(l => l.includes('LISTENING')).join('\n');
                    } else if (parsed.state === 'established') {
                        output = output.split('\n').filter(l => l.includes('ESTABLISHED')).join('\n');
                    }
                } else {
                    // Linux/Mac: ss or netstat
                    const ssArgs = ['-tuln'];
                    if (parsed.state === 'listening') ssArgs.push('-l');
                    if (parsed.state === 'established') ssArgs.push('state', 'established');
                    if (parsed.protocol === 'tcp') ssArgs.push('-t');
                    if (parsed.protocol === 'udp') ssArgs.push('-u');

                    try {
                        const result = await execa('ss', ssArgs, { timeout: 15000, reject: false });
                        output = result.stdout;
                    } catch {
                        // Fallback to netstat
                        const result = await execa('netstat', ['-tuln'], { timeout: 15000, reject: false });
                        output = result.stdout;
                    }
                }

                const truncated = truncateOutput(output, maxOutputBytes);
                return { content: [{ type: 'text', text: truncated }] };
            } catch (e: unknown) {
                logger.warn({ error: String(e) }, 'net.ports failed');
                throw new ToolExecutionError('net.ports', e);
            }
        }
    );
}

// Network DNS Tool
const NetDnsArgsSchema = z.object({
    host: z.string().describe('Hostname to resolve'),
    type: z.enum(['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS', 'SOA']).default('A'),
});

export function createNetDnsTool(maxOutputBytes: number) {
    return createTool(
        'net.dns',
        `🌐 DNS LOOKUP

Resolve DNS records for a hostname.

PARAMETERS:
• host: Hostname to resolve (required)
• type: Record type (A, AAAA, MX, TXT, CNAME, NS, SOA) - default: A

EXAMPLES:
1. Get IP address:
   {"host": "google.com", "type": "A"}

2. Get mail servers:
   {"host": "gmail.com", "type": "MX"}

3. Get TXT records (SPF, DKIM):
   {"host": "example.com", "type": "TXT"}

USE CASES:
• Verify DNS configuration
• Debug network issues
• Check mail server setup`,
        NetDnsArgsSchema,
        async (args) => {
            const parsed = NetDnsArgsSchema.parse(args);

            try {
                // Use nslookup (cross-platform) or dig
                let output: string;

                try {
                    const result = await execa('dig', [parsed.host, parsed.type, '+short'], {
                        timeout: 10000,
                        reject: false,
                    });
                    output = result.stdout || 'No records found';
                } catch {
                    // Fallback to nslookup
                    const result = await execa('nslookup', ['-type=' + parsed.type, parsed.host], {
                        timeout: 10000,
                        reject: false,
                    });
                    output = result.stdout;
                }

                const truncated = truncateOutput(output, maxOutputBytes);
                return { content: [{ type: 'text', text: `DNS ${parsed.type} records for ${parsed.host}:\n\n${truncated}` }] };
            } catch (e: unknown) {
                logger.warn({ host: parsed.host, error: String(e) }, 'net.dns failed');
                throw new ToolExecutionError('net.dns', e);
            }
        }
    );
}

// Network Ping Tool
const NetPingArgsSchema = z.object({
    host: z.string().describe('Host to ping'),
    count: z.number().int().min(1).max(10).default(4),
});

export function createNetPingTool(maxOutputBytes: number) {
    return createTool(
        'net.ping',
        `📡 PING HOST

Test network connectivity to a host.

PARAMETERS:
• host: Hostname or IP to ping (required)
• count: Number of pings (1-10, default: 4)

EXAMPLES:
1. Simple ping:
   {"host": "google.com"}

2. Quick check (1 ping):
   {"host": "192.168.1.1", "count": 1}

USE CASES:
• Check if host is reachable
• Measure latency
• Debug network issues`,
        NetPingArgsSchema,
        async (args) => {
            const parsed = NetPingArgsSchema.parse(args);

            try {
                const isWindows = process.platform === 'win32';
                const countArg = isWindows ? '-n' : '-c';

                const result = await execa('ping', [countArg, String(parsed.count), parsed.host], {
                    timeout: 30000,
                    reject: false,
                });

                const output = result.stdout || result.stderr || 'No response';
                const truncated = truncateOutput(output, maxOutputBytes);

                return { content: [{ type: 'text', text: truncated }] };
            } catch (e: unknown) {
                logger.warn({ host: parsed.host, error: String(e) }, 'net.ping failed');
                throw new ToolExecutionError('net.ping', e);
            }
        }
    );
}

// Network Curl Tool (with allowlist)
function getHttpAllowlist(): string[] {
    const json = process.env.NET_HTTP_ALLOWLIST_JSON || process.env.LOCAL_HTTP_ALLOWLIST_JSON;
    if (!json) return [];
    try {
        return JSON.parse(json);
    } catch {
        return [];
    }
}

function isUrlAllowed(url: string): boolean {
    const allowlist = getHttpAllowlist();
    if (allowlist.length === 0) return true; // Empty = all allowed

    try {
        const urlObj = new URL(url);
        const hostPort = urlObj.port ? `${urlObj.hostname}:${urlObj.port}` : urlObj.hostname;

        return allowlist.some(pattern => {
            if (pattern === '*') return true;
            if (pattern.includes('*')) {
                const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
                return regex.test(hostPort) || regex.test(urlObj.hostname);
            }
            return hostPort === pattern || urlObj.hostname === pattern;
        });
    } catch {
        return false;
    }
}

const NetCurlArgsSchema = z.object({
    url: z.string().url().describe('URL to fetch'),
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'DELETE']).default('GET'),
    headers: z.record(z.string()).optional().describe('Request headers'),
    body: z.string().optional().describe('Request body (for POST/PUT)'),
    timeout: z.number().int().min(1).max(60).default(30),
});

export function createNetCurlTool(maxOutputBytes: number) {
    return createTool(
        'net.curl',
        `🌍 HTTP REQUEST

Make HTTP requests to URLs.

ALLOWLIST: ${getHttpAllowlist().join(', ') || 'all URLs allowed'}

PARAMETERS:
• url: URL to fetch (required)
• method: HTTP method (GET, HEAD, POST, PUT, DELETE) - default: GET
• headers: Request headers object (optional)
• body: Request body for POST/PUT (optional)
• timeout: Timeout in seconds (1-60, default: 30)

EXAMPLES:
1. Simple GET:
   {"url": "https://api.example.com/status"}

2. GET with headers:
   {"url": "https://api.example.com/data", "headers": {"Authorization": "Bearer token"}}

3. POST JSON:
   {"url": "https://api.example.com/items", "method": "POST", "body": "{\\"name\\": \\"test\\"}", "headers": {"Content-Type": "application/json"}}

USE CASES:
• Test API endpoints
• Fetch remote data
• Debug webhook issues`,
        NetCurlArgsSchema,
        async (args) => {
            const parsed = NetCurlArgsSchema.parse(args);

            if (!isUrlAllowed(parsed.url)) {
                throw new PolicyDeniedError(`URL not in allowlist: ${parsed.url}`, 'network.curl');
            }

            try {
                const curlArgs = ['-s', '-S', '-i', '-X', parsed.method, '--max-time', String(parsed.timeout)];

                if (parsed.headers) {
                    for (const [key, value] of Object.entries(parsed.headers)) {
                        curlArgs.push('-H', `${key}: ${value}`);
                    }
                }

                if (parsed.body && (parsed.method === 'POST' || parsed.method === 'PUT')) {
                    curlArgs.push('-d', parsed.body);
                }

                curlArgs.push(parsed.url);

                const result = await execa('curl', curlArgs, {
                    timeout: (parsed.timeout + 5) * 1000,
                    reject: false,
                });

                const output = result.stdout || result.stderr || 'No response';
                const truncated = truncateOutput(output, maxOutputBytes);

                return { content: [{ type: 'text', text: truncated }] };
            } catch (e: unknown) {
                if (String(e).includes('ENOENT')) {
                    // Fallback to Node fetch if curl not available
                    try {
                        const response = await fetch(parsed.url, {
                            method: parsed.method,
                            headers: parsed.headers,
                            body: parsed.body,
                            signal: AbortSignal.timeout(parsed.timeout * 1000),
                        });

                        const text = await response.text();
                        const output = `HTTP/${response.status} ${response.statusText}\n\n${text}`;
                        const truncated = truncateOutput(output, maxOutputBytes);

                        return { content: [{ type: 'text', text: truncated }] };
                    } catch (fetchErr) {
                        throw new ToolExecutionError('network.curl', String(fetchErr));
                    }
                }

                logger.warn({ url: parsed.url, error: String(e) }, 'net.curl failed');
                throw new ToolExecutionError('net.curl', e);
            }
        }
    );
}
