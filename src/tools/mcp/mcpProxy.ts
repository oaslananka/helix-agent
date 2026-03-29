import { ToolExecutionError, PolicyDeniedError, ToolNotFoundError } from '../../errors/index.js';
import { z } from 'zod';
import { createTool } from '../types.js';
import { truncateOutput } from '../../security/pathPolicy.js';
import { logger } from '../../security/logger.js';
import { execa } from 'execa';
import { readFile, access } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

// MCP Server configuration interface
interface MCPServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

interface MCPConfig {
    mcpServers?: Record<string, MCPServerConfig>;
}

// Get MCP config paths for various clients
function getMcpConfigPaths(): string[] {
    const home = homedir();
    const platform = process.platform;

    const paths: string[] = [];

    // Claude Desktop
    if (platform === 'win32') {
        paths.push(join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json'));
    } else if (platform === 'darwin') {
        paths.push(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
    } else {
        paths.push(join(home, '.config', 'claude', 'claude_desktop_config.json'));
    }

    // Custom paths from env
    const customPaths = process.env.MCP_CONFIG_PATHS_JSON;
    if (customPaths) {
        try {
            const parsed = JSON.parse(customPaths);
            paths.push(...parsed.map((p: string) => p.replace('~', home)));
        } catch {
            logger.warn('Failed to parse MCP_CONFIG_PATHS_JSON');
        }
    }

    return paths;
}

// Allowed MCP servers from env
function getAllowedMcpServers(): string[] {
    const json = process.env.MCP_ALLOWED_SERVERS_JSON;
    if (!json) return []; // Empty = all allowed
    try {
        return JSON.parse(json);
    } catch {
        return [];
    }
}

function isServerAllowed(name: string): boolean {
    const allowed = getAllowedMcpServers();
    if (allowed.length === 0) return true;
    return allowed.includes(name) || allowed.includes('*');
}

// Discover MCP servers from config files
const McpDiscoverArgsSchema = z.object({});

export function createMcpDiscoverTool(maxOutputBytes: number) {
    return createTool(
        'mcp.discover',
        `🔍 DISCOVER LOCAL MCP SERVERS

Find MCP servers configured on this machine (Claude Desktop, etc).

PARAMETERS: none

SEARCHES:
${getMcpConfigPaths().map(p => `• ${p}`).join('\n')}

RETURNS:
• Server name
• Command
• Arguments
• Status (available/not found)

USE CASES:
• Find available MCP servers
• Get server names for mcp.call
• Debug MCP configuration`,
        McpDiscoverArgsSchema,
        async () => {
            const configPaths = getMcpConfigPaths();
            const discovered: { path: string; servers: Record<string, MCPServerConfig> }[] = [];

            for (const configPath of configPaths) {
                try {
                    await access(configPath);
                    const content = await readFile(configPath, 'utf-8');
                    const config: MCPConfig = JSON.parse(content);

                    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
                        discovered.push({
                            path: configPath,
                            servers: config.mcpServers,
                        });
                    }
                } catch {
                    // Config file doesn't exist or is invalid
                }
            }

            if (discovered.length === 0) {
                return {
                    content: [{
                        type: 'text',
                        text: `No MCP servers found.\n\nSearched paths:\n${configPaths.map(p => `• ${p}`).join('\n')}\n\nTo configure MCP servers, create a config file with mcpServers section.`,
                    }],
                };
            }

            const output: string[] = ['Discovered MCP Servers:\n'];

            for (const { path, servers } of discovered) {
                output.push(`📁 ${path}`);

                for (const [name, config] of Object.entries(servers)) {
                    const allowed = isServerAllowed(name);
                    const status = allowed ? '✅' : '🚫';
                    output.push(`  ${status} ${name}`);
                    output.push(`     Command: ${config.command} ${(config.args || []).join(' ')}`);
                }
                output.push('');
            }

            const allowedList = getAllowedMcpServers();
            if (allowedList.length > 0) {
                output.push(`\nAllowed servers filter: ${allowedList.join(', ')}`);
            }

            const truncated = truncateOutput(output.join('\n'), maxOutputBytes);
            return { content: [{ type: 'text', text: truncated }] };
        }
    );
}

// Call a local MCP server tool
const McpCallArgsSchema = z.object({
    server: z.string().describe('MCP server name (from mcp.discover)'),
    tool: z.string().describe('Tool name to call'),
    arguments: z.record(z.unknown()).optional().describe('Tool arguments'),
    timeout: z.number().int().min(1).max(120).default(30).describe('Timeout in seconds'),
});

export function createMcpCallTool(maxOutputBytes: number) {
    return createTool(
        'mcp.call',
        `🔧 CALL MCP SERVER TOOL

Execute a tool from a local MCP server.

PARAMETERS:
• server: MCP server name (from mcp.discover)
• tool: Tool name to call
• arguments: Tool arguments object (optional)
• timeout: Timeout in seconds (1-120, default: 30)

EXAMPLES:
1. Call filesystem read:
   {"server": "filesystem", "tool": "read_file", "arguments": {"path": "/home/user/file.txt"}}

2. Call GitHub list repos:
   {"server": "github", "tool": "list_repos", "arguments": {"user": "octocat"}}

3. Call with timeout:
   {"server": "postgres", "tool": "query", "arguments": {"sql": "SELECT 1"}, "timeout": 60}

NOTES:
• Server must be configured in Claude Desktop or MCP config
• Use mcp.discover first to find available servers
• Server is started as subprocess for each call`,
        McpCallArgsSchema,
        async (args) => {
            const parsed = McpCallArgsSchema.parse(args);

            if (!isServerAllowed(parsed.server)) {
                throw new PolicyDeniedError(`MCP server not allowed: ${parsed.server}`, 'mcp.call');
            }

            // Find server config
            const configPaths = getMcpConfigPaths();
            let serverConfig: MCPServerConfig | null = null;

            for (const configPath of configPaths) {
                try {
                    await access(configPath);
                    const content = await readFile(configPath, 'utf-8');
                    const config: MCPConfig = JSON.parse(content);

                    if (config.mcpServers?.[parsed.server]) {
                        serverConfig = config.mcpServers[parsed.server];
                        break;
                    }
                } catch {
                    // Continue to next config
                }
            }

            if (!serverConfig) {
                throw new ToolNotFoundError(`MCP server not found: ${parsed.server}`);
            }

            try {
                // Create JSON-RPC request for tool call
                const jsonRpcRequest = {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: {
                        name: parsed.tool,
                        arguments: parsed.arguments || {},
                    },
                };

                // Start MCP server as subprocess and send request via stdin
                const result = await execa(
                    serverConfig.command,
                    serverConfig.args || [],
                    {
                        input: JSON.stringify(jsonRpcRequest) + '\n',
                        timeout: parsed.timeout * 1000,
                        reject: false,
                        env: { ...process.env, ...serverConfig.env },
                    }
                );

                if (result.exitCode !== 0 && !result.stdout) {
                    throw new ToolExecutionError('mcp.call', result.stderr || 'MCP server failed');
                }

                // Parse JSON-RPC response
                let output = result.stdout;
                try {
                    const lines = output.split('\n').filter(l => l.trim());
                    for (const line of lines) {
                        try {
                            const response = JSON.parse(line);
                            if (response.result) {
                                output = JSON.stringify(response.result, null, 2);
                                break;
                            } else if (response.error) {
                                throw new ToolExecutionError('mcp.call', `MCP error: ${response.error.message || JSON.stringify(response.error)}`);
                            }
                        } catch {
                            // Not valid JSON, continue
                        }
                    }
                } catch {
                    // Keep original output
                }

                const truncated = truncateOutput(output, maxOutputBytes);
                return { content: [{ type: 'text', text: truncated }] };
            } catch (e: unknown) {
                logger.warn({ server: parsed.server, tool: parsed.tool, error: String(e) }, 'mcp.call failed');
                throw new ToolExecutionError('mcp.call', String(e));
            }
        }
    );
}

// List tools from an MCP server
const McpListToolsArgsSchema = z.object({
    server: z.string().describe('MCP server name'),
});

export function createMcpListToolsTool(maxOutputBytes: number) {
    return createTool(
        'mcp.list_tools',
        `📋 LIST MCP SERVER TOOLS

Get available tools from an MCP server.

PARAMETERS:
• server: MCP server name (from mcp.discover)

EXAMPLES:
1. List filesystem tools:
   {"server": "filesystem"}

2. List GitHub tools:
   {"server": "github"}

RETURNS:
• Tool names
• Descriptions
• Input schemas`,
        McpListToolsArgsSchema,
        async (args) => {
            const parsed = McpListToolsArgsSchema.parse(args);

            if (!isServerAllowed(parsed.server)) {
                throw new PolicyDeniedError(`MCP server not allowed: ${parsed.server}`, 'mcp.call');
            }

            // Find server config
            const configPaths = getMcpConfigPaths();
            let serverConfig: MCPServerConfig | null = null;

            for (const configPath of configPaths) {
                try {
                    await access(configPath);
                    const content = await readFile(configPath, 'utf-8');
                    const config: MCPConfig = JSON.parse(content);

                    if (config.mcpServers?.[parsed.server]) {
                        serverConfig = config.mcpServers[parsed.server];
                        break;
                    }
                } catch {
                    // Continue
                }
            }

            if (!serverConfig) {
                throw new ToolNotFoundError(`MCP server not found: ${parsed.server}`);
            }

            try {
                // JSON-RPC request for tools/list
                const jsonRpcRequest = {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/list',
                    params: {},
                };

                const result = await execa(
                    serverConfig.command,
                    serverConfig.args || [],
                    {
                        input: JSON.stringify(jsonRpcRequest) + '\n',
                        timeout: 30000,
                        reject: false,
                        env: { ...process.env, ...serverConfig.env },
                    }
                );

                let output = `Tools for ${parsed.server}:\n\n`;

                try {
                    const lines = result.stdout.split('\n').filter(l => l.trim());
                    for (const line of lines) {
                        try {
                            const response = JSON.parse(line);
                            if (response.result?.tools) {
                                for (const tool of response.result.tools) {
                                    output += `• ${tool.name}\n`;
                                    if (tool.description) {
                                        output += `  ${tool.description.substring(0, 100)}\n`;
                                    }
                                }
                            }
                        } catch {
                            // Not valid JSON
                        }
                    }
                } catch {
                    output += result.stdout || 'No tools found';
                }

                const truncated = truncateOutput(output, maxOutputBytes);
                return { content: [{ type: 'text', text: truncated }] };
            } catch (e: unknown) {
                logger.warn({ server: parsed.server, error: String(e) }, 'mcp.list_tools failed');
                throw new ToolExecutionError('mcp.list_tools', String(e));
            }
        }
    );
}
