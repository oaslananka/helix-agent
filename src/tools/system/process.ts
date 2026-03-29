import { ToolExecutionError, ToolValidationError } from '../../errors/index.js';
import { z } from 'zod';
import { createTool } from '../types.js';
import { truncateOutput } from '../../security/pathPolicy.js';
import { logger } from '../../security/logger.js';
import { auditLogger } from '../../security/auditLogger.js';
import { execa } from 'execa';

const ProcessOpsArgsSchema = z.object({
  operation: z.enum(['list', 'kill', 'info']),
  pid: z.number().int().positive().optional(),
  name: z.string().optional(),
  signal: z.string().default('TERM'), // TERM, KILL, HUP, etc.
  force: z.boolean().default(false),
});

export function createProcessTool(
  maxOutputBytes: number,
  timeoutMs: number,
  unrestrictedMode: boolean = false
) {
  if (!unrestrictedMode) {
    return null;
  }

  return createTool(
    'system.process',
    `⚠️ PROCESS MANAGEMENT (UNRESTRICTED) ⚠️

Manage system processes - list, inspect, and terminate.

SUPPORTED OPERATIONS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 LIST PROCESSES:
  • Windows: Get-Process, tasklist
  • Linux: ps aux, top -bn1
  • Examples:
    - List all: {"operation": "list"}
    - Sort by CPU/Memory: Lists all processes with resource usage

🔍 PROCESS INFO:
  • Get detailed information about a specific process
  • Windows: Get-Process -Id PID
  • Linux: ps -p PID -o pid,ppid,cmd,%cpu,%mem,etime
  • Examples:
    - By PID: {"operation": "info", "pid": 1234}
    - By name: {"operation": "info", "name": "node"}

⚠️ KILL PROCESS:
  • Terminate a running process
  • Windows: Stop-Process -Id PID [-Force], taskkill
  • Linux: kill [-9] PID, killall name
  • Examples:
    - Graceful: {"operation": "kill", "pid": 1234}
    - Force kill: {"operation": "kill", "pid": 1234, "force": true}
    - By name: {"operation": "kill", "name": "chrome"}
    - Custom signal (Linux): {"operation": "kill", "pid": 1234, "signal": "HUP"}

PARAMETERS:
• operation: Type of operation (list|kill|info)
• pid: Process ID (for kill/info)
• name: Process name (for kill/info)
• signal: Signal to send (Linux: TERM, KILL, HUP, INT, QUIT)
• force: Force kill (Windows: -Force, Linux: -9)

SIGNALS (Linux):
• TERM (15): Graceful termination (default)
• KILL (9): Forceful termination (cannot be caught)
• HUP (1): Hangup - reload configuration
• INT (2): Interrupt (Ctrl+C)
• QUIT (3): Quit with core dump

⚠️ WARNINGS:
- Killing critical system processes can crash the OS
- Use 'force' carefully - doesn't allow cleanup
- On Linux, you may need sudo for processes owned by other users
- Windows: Requires appropriate permissions
- Always verify PID before killing

COMMON USE CASES:
• Monitoring: List processes sorted by CPU/memory usage
• Troubleshooting: Find hanging or zombie processes
• Development: Kill dev servers, test processes
• Cleanup: Terminate stuck applications
• Reload: Send HUP signal to reload configs (nginx, etc.)

EXAMPLES:
1. Find memory-heavy processes:
   {"operation": "list"}
   
2. Kill stuck Node.js process:
   {"operation": "kill", "name": "node"}

3. Force kill unresponsive app:
   {"operation": "kill", "pid": 5678, "force": true}

4. Reload nginx configuration:
   {"operation": "kill", "name": "nginx", "signal": "HUP"}

5. Get detailed process info:
   {"operation": "info", "pid": 1234}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ProcessOpsArgsSchema,
    async (args) => {
      const parsed = ProcessOpsArgsSchema.parse(args);
      const isWindows = process.platform === 'win32';

      try {
        let cmd: string;
        let cmdArgs: string[] = [];

        switch (parsed.operation) {
          case 'list':
            if (isWindows) {
              cmd = 'powershell';
              cmdArgs = [
                '-Command',
                'Get-Process | Sort-Object CPU -Descending | Select-Object -First 50 Id,ProcessName,CPU,WorkingSet,StartTime | Format-Table -AutoSize',
              ];
            } else {
              cmd = 'ps';
              cmdArgs = ['aux', '--sort=-%cpu'];
            }
            break;

          case 'info':
            if (!parsed.pid && !parsed.name) {
              throw new ToolValidationError('system.process', ['Either pid or name required for info']);
            }
            if (isWindows) {
              cmd = 'powershell';
              const filter = parsed.pid ? `-Id ${parsed.pid}` : `-Name "${parsed.name}"`;
              cmdArgs = [
                '-Command',
                `Get-Process ${filter} | Format-List *`,
              ];
            } else {
              if (parsed.pid) {
                cmd = 'ps';
                cmdArgs = ['-p', String(parsed.pid), '-o', 'pid,ppid,cmd,%cpu,%mem,etime'];
              } else {
                cmd = 'pgrep';
                cmdArgs = ['-a', parsed.name!];
              }
            }
            break;

          case 'kill':
            if (!parsed.pid && !parsed.name) {
              throw new ToolValidationError('system.process', ['Either pid or name required for kill']);
            }
            if (isWindows) {
              cmd = 'powershell';
              const target = parsed.pid ? `-Id ${parsed.pid}` : `-Name "${parsed.name}"`;
              cmdArgs = [
                '-Command',
                `Stop-Process ${target}${parsed.force ? ' -Force' : ''}`,
              ];
            } else {
              if (parsed.pid) {
                cmd = 'kill';
                if (parsed.force || parsed.signal === 'KILL') {
                  cmdArgs.push('-9');
                } else if (parsed.signal !== 'TERM') {
                  cmdArgs.push(`-${parsed.signal}`);
                }
                cmdArgs.push(String(parsed.pid));
              } else {
                cmd = 'killall';
                if (parsed.force || parsed.signal === 'KILL') {
                  cmdArgs.push('-9');
                } else if (parsed.signal !== 'TERM') {
                  cmdArgs.push(`-${parsed.signal}`);
                }
                cmdArgs.push(parsed.name!);
              }
            }
            break;

          default:
            throw new ToolValidationError('system.process', [`Unknown operation: ${parsed.operation}`]);
        }

        logger.info(
          { operation: parsed.operation, cmd, args: cmdArgs },
          'Executing process operation'
        );

        // Audit log - especially for kill operations
        if (parsed.operation === 'kill') {
          auditLogger.systemOperation(
            'process.kill',
            {
              pid: parsed.pid,
              name: parsed.name,
              signal: parsed.signal,
              force: parsed.force,
            },
            'success' // Will update on failure
          );
        }

        const result = await execa(cmd, cmdArgs, {
          timeout: timeoutMs,
          reject: false,
        });

        const output = (result.stdout || '') + '\n' + (result.stderr || '');
        const truncated = truncateOutput(
          output || 'Operation completed successfully',
          maxOutputBytes
        );

        return {
          content: [
            {
              type: 'text',
              text: truncated,
            },
          ],
        };
      } catch (e: unknown) {
        logger.warn(
          { operation: parsed.operation, error: String(e) },
          'Process operation failed'
        );
        throw new ToolExecutionError('system.process', e);
      }
    }
  );
}
