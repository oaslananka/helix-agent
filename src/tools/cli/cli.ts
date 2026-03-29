import { ToolExecutionError, ToolNotFoundError } from '../../errors/index.js';
import { z } from 'zod';
import { createTool } from '../types.js';
import { truncateOutput } from '../../security/pathPolicy.js';
import { logger } from '../../security/logger.js';
import { execa, ExecaChildProcess } from 'execa';
import { randomUUID } from 'crypto';

// Active CLI sessions storage
const activeSessions: Map<string, {
    process: ExecaChildProcess;
    command: string;
    startTime: number;
    output: string[];
}> = new Map();

// CLI paths from env
function getGeminiCliPath(): string {
    return process.env.GEMINI_CLI_PATH || 'gemini';
}

function getCopilotCliPath(): string {
    return process.env.COPILOT_CLI_PATH || 'gh';
}

function getMaxSessions(): number {
    return parseInt(process.env.CLI_MAX_SESSIONS || '3', 10);
}

function getSessionTimeout(): number {
    return parseInt(process.env.CLI_SESSION_TIMEOUT_MS || '300000', 10);
}

// Cleanup old sessions
function cleanupStaleSession() {
    const timeout = getSessionTimeout();
    const now = Date.now();

    for (const [id, session] of activeSessions.entries()) {
        if (now - session.startTime > timeout) {
            try {
                session.process.kill();
            } catch { }
            activeSessions.delete(id);
            logger.info({ sessionId: id }, 'Cleaned up stale CLI session');
        }
    }
}

// Gemini CLI Tool
const GeminiArgsSchema = z.object({
    prompt: z.string().describe('Prompt to send to Gemini'),
    model: z.string().optional().describe('Model name (optional)'),
});

export function createGeminiTool(maxOutputBytes: number) {
    return createTool(
        'cli.gemini',
        `🤖 GEMINI CLI

Send a prompt to Gemini CLI (headless mode).

REQUIREMENTS:
• Gemini CLI installed (npm install -g @anthropic/gemini-cli or similar)
• GEMINI_API_KEY environment variable set

PARAMETERS:
• prompt: Text prompt to send (required)
• model: Model name (optional)

EXAMPLES:
1. Simple prompt:
   {"prompt": "Explain what Docker is in 3 sentences"}

2. Code question:
   {"prompt": "Write a Python function to reverse a string"}

NOTES:
• Runs in headless/non-interactive mode
• Each call is independent (no conversation history)
• Timeout: ${getSessionTimeout() / 1000}s`,
        GeminiArgsSchema,
        async (args) => {
            const parsed = GeminiArgsSchema.parse(args);
            const geminiPath = getGeminiCliPath();

            try {
                const cliArgs = ['-p', parsed.prompt];
                if (parsed.model) {
                    cliArgs.push('--model', parsed.model);
                }

                const result = await execa(geminiPath, cliArgs, {
                    timeout: getSessionTimeout(),
                    reject: false,
                    env: process.env,
                });

                if (result.exitCode !== 0 && !result.stdout) {
                    throw new ToolExecutionError('cli.gemini', result.stderr || 'Gemini CLI failed');
                }

                const output = result.stdout || result.stderr || 'No response';
                const truncated = truncateOutput(output, maxOutputBytes);

                return { content: [{ type: 'text', text: truncated }] };
            } catch (e: unknown) {
                if (String(e).includes('ENOENT')) {
                    throw new ToolExecutionError('cli.gemini', `Gemini CLI not found at: ${geminiPath}. Install with: npm install -g @google/generative-ai-cli`);
                }
                logger.warn({ error: String(e) }, 'cli.gemini failed');
                throw new ToolExecutionError('cli.gemini', String(e));
            }
        }
    );
}

// Copilot CLI Tool
const CopilotArgsSchema = z.object({
    prompt: z.string().describe('Prompt for Copilot'),
    mode: z.enum(['explain', 'suggest', 'general']).default('general'),
});

export function createCopilotTool(maxOutputBytes: number) {
    return createTool(
        'cli.copilot',
        `🧑‍✈️ GITHUB COPILOT CLI

Send a prompt to GitHub Copilot CLI.

REQUIREMENTS:
• GitHub CLI installed (gh)
• Copilot extension: gh extension install github/gh-copilot
• Authenticated: gh auth login

PARAMETERS:
• prompt: Text prompt (required)
• mode: Mode - explain, suggest, general (default: general)

EXAMPLES:
1. Explain code:
   {"prompt": "Explain what git rebase does", "mode": "explain"}

2. Suggest command:
   {"prompt": "Find all .js files larger than 1MB", "mode": "suggest"}

3. General question:
   {"prompt": "How to deploy to Kubernetes?"}

NOTES:
• Requires GitHub authentication (OAuth)
• Each call is independent`,
        CopilotArgsSchema,
        async (args) => {
            const parsed = CopilotArgsSchema.parse(args);
            const ghPath = getCopilotCliPath();

            try {
                let cliArgs: string[];

                if (parsed.mode === 'explain') {
                    cliArgs = ['copilot', 'explain', parsed.prompt];
                } else if (parsed.mode === 'suggest') {
                    cliArgs = ['copilot', 'suggest', '-t', 'shell', parsed.prompt];
                } else {
                    cliArgs = ['copilot', 'explain', parsed.prompt];
                }

                const result = await execa(ghPath, cliArgs, {
                    timeout: getSessionTimeout(),
                    reject: false,
                    env: process.env,
                });

                if (result.exitCode !== 0 && !result.stdout) {
                    throw new ToolExecutionError('cli.copilot', result.stderr || 'Copilot CLI failed');
                }

                const output = result.stdout || result.stderr || 'No response';
                const truncated = truncateOutput(output, maxOutputBytes);

                return { content: [{ type: 'text', text: truncated }] };
            } catch (e: unknown) {
                if (String(e).includes('ENOENT')) {
                    throw new ToolExecutionError('cli.copilot', `GitHub CLI not found at: ${ghPath}. Install from: https://cli.github.com/`);
                }
                logger.warn({ error: String(e) }, 'cli.copilot failed');
                throw new ToolExecutionError('cli.copilot', String(e));
            }
        }
    );
}

// Interactive Session Start
const SessionStartArgsSchema = z.object({
    command: z.string().describe('Command to run (e.g., gemini, python, node)'),
    args: z.array(z.string()).optional().describe('Command arguments'),
    cwd: z.string().optional().describe('Working directory'),
});

export function createSessionStartTool(maxOutputBytes: number) {
    return createTool(
        'cli.session_start',
        `🚀 START CLI SESSION

Start an interactive CLI session (background process).

MAX SESSIONS: ${getMaxSessions()}
SESSION TIMEOUT: ${getSessionTimeout() / 1000}s

PARAMETERS:
• command: Command to run (required)
• args: Command arguments (optional)
• cwd: Working directory (optional)

EXAMPLES:
1. Start Python REPL:
   {"command": "python", "args": ["-i"]}

2. Start Node REPL:
   {"command": "node"}

3. Start shell:
   {"command": "bash"}

RETURNS:
• Session ID for use with cli.session_input and cli.session_read

NOTES:
• Sessions are killed after timeout
• Use cli.session_stop to end early
• Max ${getMaxSessions()} concurrent sessions`,
        SessionStartArgsSchema,
        async (args) => {
            const parsed = SessionStartArgsSchema.parse(args);

            // Cleanup old sessions
            cleanupStaleSession();

            if (activeSessions.size >= getMaxSessions()) {
                throw new ToolExecutionError('cli.session', `Max sessions (${getMaxSessions()}) reached. Stop some sessions first.`);
            }

            const sessionId = randomUUID().substring(0, 8);

            try {
                const childProcess = execa(parsed.command, parsed.args || [], {
                    cwd: parsed.cwd,
                    reject: false,
                    stdin: 'pipe',
                    stdout: 'pipe',
                    stderr: 'pipe',
                    env: process.env,
                });

                const output: string[] = [];

                childProcess.stdout?.on('data', (data) => {
                    output.push(data.toString());
                    // Keep last 1000 lines
                    if (output.length > 1000) output.shift();
                });

                childProcess.stderr?.on('data', (data) => {
                    output.push(`[stderr] ${data.toString()}`);
                    if (output.length > 1000) output.shift();
                });

                activeSessions.set(sessionId, {
                    process: childProcess,
                    command: parsed.command,
                    startTime: Date.now(),
                    output,
                });

                // Wait a bit for initial output
                await new Promise(r => setTimeout(r, 500));

                const initialOutput = output.join('').substring(0, 500);

                return {
                    content: [{
                        type: 'text',
                        text: `Session started!\n\nSession ID: ${sessionId}\nCommand: ${parsed.command} ${(parsed.args || []).join(' ')}\n\nInitial output:\n${initialOutput || '(no output yet)'}`,
                    }],
                };
            } catch (e: unknown) {
                logger.warn({ command: parsed.command, error: String(e) }, 'cli.session_start failed');
                throw new ToolExecutionError('cli.session', `Failed to start session: ${String(e)}`);
            }
        }
    );
}

// Session Input
const SessionInputArgsSchema = z.object({
    sessionId: z.string().describe('Session ID from cli.session_start'),
    input: z.string().describe('Input to send'),
});

export function createSessionInputTool(maxOutputBytes: number) {
    return createTool(
        'cli.session_input',
        `⌨️ SEND SESSION INPUT

Send input to an active CLI session.

PARAMETERS:
• sessionId: Session ID (required)
• input: Text to send (required, newline added automatically)

EXAMPLES:
1. Send Python code:
   {"sessionId": "abc123", "input": "print('Hello')"}

2. Exit session:
   {"sessionId": "abc123", "input": "exit()"}`,
        SessionInputArgsSchema,
        async (args) => {
            const parsed = SessionInputArgsSchema.parse(args);

            const session = activeSessions.get(parsed.sessionId);
            if (!session) {
                throw new ToolNotFoundError(`session:${parsed.sessionId}`);
            }

            if (!session.process.stdin?.writable) {
                throw new ToolExecutionError('cli.session', 'Session stdin is not writable');
            }

            try {
                session.process.stdin.write(parsed.input + '\n');

                // Wait for output
                await new Promise(r => setTimeout(r, 500));

                const recentOutput = session.output.slice(-50).join('');
                const truncated = truncateOutput(recentOutput, maxOutputBytes);

                return {
                    content: [{
                        type: 'text',
                        text: `Input sent.\n\nRecent output:\n${truncated}`,
                    }],
                };
            } catch (e: unknown) {
                logger.warn({ sessionId: parsed.sessionId, error: String(e) }, 'cli.session_input failed');
                throw new ToolExecutionError('cli.session', `Failed to send input: ${String(e)}`);
            }
        }
    );
}

// Session Read
const SessionReadArgsSchema = z.object({
    sessionId: z.string().describe('Session ID'),
    lines: z.number().int().min(1).max(500).default(50).describe('Number of lines to read'),
});

export function createSessionReadTool(maxOutputBytes: number) {
    return createTool(
        'cli.session_read',
        `📖 READ SESSION OUTPUT

Read output from an active CLI session.

PARAMETERS:
• sessionId: Session ID (required)
• lines: Number of recent lines (1-500, default: 50)

EXAMPLES:
1. Read recent output:
   {"sessionId": "abc123", "lines": 50}`,
        SessionReadArgsSchema,
        async (args) => {
            const parsed = SessionReadArgsSchema.parse(args);

            const session = activeSessions.get(parsed.sessionId);
            if (!session) {
                throw new ToolNotFoundError(`session:${parsed.sessionId}`);
            }

            const lines = session.output.slice(-parsed.lines);
            const output = lines.join('');
            const truncated = truncateOutput(output, maxOutputBytes);

            const runningTime = Math.floor((Date.now() - session.startTime) / 1000);

            return {
                content: [{
                    type: 'text',
                    text: `Session: ${parsed.sessionId}\nCommand: ${session.command}\nRunning: ${runningTime}s\n\nOutput (last ${parsed.lines} lines):\n${truncated}`,
                }],
            };
        }
    );
}

// Session Stop
const SessionStopArgsSchema = z.object({
    sessionId: z.string().describe('Session ID to stop'),
});

export function createSessionStopTool() {
    return createTool(
        'cli.session_stop',
        `🛑 STOP CLI SESSION

Stop an active CLI session.

PARAMETERS:
• sessionId: Session ID (required)

EXAMPLES:
1. Stop session:
   {"sessionId": "abc123"}`,
        SessionStopArgsSchema,
        async (args) => {
            const parsed = SessionStopArgsSchema.parse(args);

            const session = activeSessions.get(parsed.sessionId);
            if (!session) {
                throw new ToolNotFoundError(`session:${parsed.sessionId}`);
            }

            try {
                session.process.kill();
                activeSessions.delete(parsed.sessionId);

                const runningTime = Math.floor((Date.now() - session.startTime) / 1000);

                return {
                    content: [{
                        type: 'text',
                        text: `Session ${parsed.sessionId} stopped.\nCommand: ${session.command}\nRan for: ${runningTime}s`,
                    }],
                };
            } catch (e: unknown) {
                activeSessions.delete(parsed.sessionId);
                throw new ToolExecutionError('cli.session', `Failed to stop session: ${String(e)}`);
            }
        }
    );
}

// List Active Sessions
const SessionListArgsSchema = z.object({});

export function createSessionListTool() {
    return createTool(
        'cli.session_list',
        `📋 LIST ACTIVE SESSIONS

List all active CLI sessions.

PARAMETERS: none`,
        SessionListArgsSchema,
        async () => {
            cleanupStaleSession();

            if (activeSessions.size === 0) {
                return {
                    content: [{ type: 'text', text: 'No active sessions.' }],
                };
            }

            const lines: string[] = [`Active sessions (${activeSessions.size}/${getMaxSessions()}):\n`];

            for (const [id, session] of activeSessions.entries()) {
                const runningTime = Math.floor((Date.now() - session.startTime) / 1000);
                lines.push(`• ${id}: ${session.command} (running ${runningTime}s)`);
            }

            return {
                content: [{ type: 'text', text: lines.join('\n') }],
            };
        }
    );
}
