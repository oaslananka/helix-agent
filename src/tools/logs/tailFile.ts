import { z } from 'zod';
import { createTool } from '../types.js';
import { resolvePath, truncateOutput } from '../../security/pathPolicy.js';
import { logger } from '../../security/logger.js';
import { readFile } from 'fs/promises';

const TailFileArgsSchema = z.object({
  path: z.string(),
  lines: z.number().int().positive().default(100),
});

export function createTailFileTool(
  allowedRoots: string[],
  logRoots: string[],
  maxOutputBytes: number
) {
  const allRoots = [...allowedRoots, ...logRoots];

  return createTool(
    'logs.tail_file',
    `📜 TAIL LOG FILE

Read last N lines from a log file - quick log inspection.

WHEN TO USE:
• Check application logs
• Debug errors from log files
• Monitor log file activity
• Review recent events

PARAMETERS:
• path: Log file path (relative or absolute)
• lines: Number of lines from end (default: 100)

EXAMPLES:
1. Check app logs:
   {"path": "logs/app.log", "lines": 100}

2. Recent errors:
   {"path": "/var/log/nginx/error.log", "lines": 50}

3. Quick peek:
   {"path": "debug.log", "lines": 20}

4. Deep investigation:
   {"path": "logs/production.log", "lines": 1000}

COMMON LOG LOCATIONS:

🪟 WINDOWS:
• IIS: C:\\inetpub\\logs\\LogFiles
• Application: C:\\ProgramData\\AppName\\logs
• Event logs: Use PowerShell Get-EventLog

🐧 LINUX:
• System: /var/log/syslog, /var/log/messages
• Web: /var/log/nginx/, /var/log/apache2/
• App: /var/log/appname/, ~/logs/
• Systemd: Use runner.exec: journalctl -u service

BEST PRACTICES:
• Start with lines=100 for overview
• Increase lines if you need more context
• For live monitoring, use runner.exec: tail -f
• Combine with repo.search_rg to find log patterns

TROUBLESHOOTING:
• File not found? Check path is within allowed roots
• Permissions denied? Agent may need elevated access
• Large files? Use repo.read_file with line ranges instead`,
    TailFileArgsSchema,
    async (args) => {
      const parsed = TailFileArgsSchema.parse(args);
      const resolvedPath = resolvePath(parsed.path, allRoots);

      try {
        const content = await readFile(resolvedPath, 'utf-8');
        const lines = content.split('\n');
        const tail = lines.slice(-parsed.lines).join('\n');

        const truncated = truncateOutput(tail, maxOutputBytes);

        return {
          content: [{ type: 'text', text: truncated }],
        };
      } catch (e) {
        logger.warn({ path: resolvedPath, error: String(e) }, 'Failed to tail file');
        throw e;
      }
    }
  );
}
