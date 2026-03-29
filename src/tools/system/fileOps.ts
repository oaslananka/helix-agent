import { ToolExecutionError, ToolValidationError } from '../../errors/index.js';
import { z } from 'zod';
import { createTool } from '../types.js';
import { truncateOutput } from '../../security/pathPolicy.js';
import { logger } from '../../security/logger.js';
import { auditLogger } from '../../security/auditLogger.js';
import { execa } from 'execa';

const FileOpsArgsSchema = z.object({
  operation: z.enum(['copy', 'move', 'delete', 'create', 'mkdir', 'chmod', 'chown']),
  source: z.string().optional(),
  destination: z.string().optional(),
  content: z.string().optional(),
  mode: z.string().optional(), // chmod mode (e.g., "755", "644")
  owner: z.string().optional(), // chown owner (e.g., "user:group")
  recursive: z.boolean().default(false),
  force: z.boolean().default(false),
});

export function createFileOpsTool(
  maxOutputBytes: number,
  timeoutMs: number,
  unrestrictedMode: boolean = false
) {
  if (!unrestrictedMode) {
    // Return a disabled tool if unrestricted mode is off
    return null;
  }

  return createTool(
    'system.file_ops',
    `⚠️ SYSTEM FILE OPERATIONS (UNRESTRICTED) ⚠️

Perform file system operations anywhere on the system.

SUPPORTED OPERATIONS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 COPY:
  • Windows: Copy-Item, copy, xcopy
  • Linux: cp [-r] source destination
  • Examples:
    - Copy file: {"operation": "copy", "source": "file.txt", "destination": "backup.txt"}
    - Copy directory: {"operation": "copy", "source": "dir", "destination": "backup", "recursive": true}

📦 MOVE/RENAME:
  • Windows: Move-Item, move
  • Linux: mv source destination
  • Examples:
    - Move: {"operation": "move", "source": "old.txt", "destination": "/tmp/new.txt"}
    - Rename: {"operation": "move", "source": "old_name", "destination": "new_name"}

🗑️ DELETE:
  • Windows: Remove-Item, del
  • Linux: rm [-rf] path
  • Examples:
    - Delete file: {"operation": "delete", "source": "file.txt"}
    - Delete directory: {"operation": "delete", "source": "dir", "recursive": true, "force": true}

📝 CREATE FILE:
  • Creates or overwrites a file with content
  • Examples:
    - {"operation": "create", "destination": "file.txt", "content": "Hello World"}

📁 CREATE DIRECTORY:
  • Windows: New-Item -ItemType Directory, mkdir
  • Linux: mkdir [-p] path
  • Examples:
    - {"operation": "mkdir", "destination": "/path/to/dir"}
    - {"operation": "mkdir", "destination": "/path/to/nested/dir", "recursive": true}

🔒 CHMOD (Linux/Mac):
  • Change file permissions
  • Examples:
    - Make executable: {"operation": "chmod", "source": "script.sh", "mode": "755"}
    - Read-only: {"operation": "chmod", "source": "file.txt", "mode": "444"}

👤 CHOWN (Linux/Mac):
  • Change file ownership
  • Examples:
    - {"operation": "chown", "source": "file.txt", "owner": "user:group"}
    - Recursive: {"operation": "chown", "source": "dir", "owner": "www-data:www-data", "recursive": true}

PARAMETERS:
• operation: Type of operation (copy|move|delete|create|mkdir|chmod|chown)
• source: Source file/directory path
• destination: Destination path
• content: File content (for create operation)
• mode: Permission mode (for chmod, e.g., "755")
• owner: Owner specification (for chown, e.g., "user:group")
• recursive: Apply recursively to directories
• force: Force operation (delete without confirmation, overwrite)

⚠️ WARNINGS:
- Operations are IRREVERSIBLE (especially delete)
- Use absolute paths for clarity
- Test with non-critical files first
- 'force' flag bypasses confirmations
- Windows: Some operations require admin privileges
- Linux: chown/chmod may require sudo

COMMON USE CASES:
• Backup: Copy important files before changes
• Cleanup: Delete temporary or old files
• Organization: Move files to proper directories
• Deployment: Set correct permissions for web files (chmod 755)
• Security: Change ownership for service accounts (chown)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    FileOpsArgsSchema,
    async (args) => {
      const parsed = FileOpsArgsSchema.parse(args);

      try {
        let cmd: string;
        let cmdArgs: string[] = [];

        // Detect OS (simple check)
        const isWindows = process.platform === 'win32';

        switch (parsed.operation) {
          case 'copy':
            if (!parsed.source || !parsed.destination) {
              throw new ToolValidationError('system.fileOps', ['source and destination required for copy']);
            }
            if (isWindows) {
              cmd = 'powershell';
              cmdArgs = [
                '-Command',
                `Copy-Item -Path "${parsed.source}" -Destination "${parsed.destination}"${parsed.recursive ? ' -Recurse' : ''}${parsed.force ? ' -Force' : ''}`,
              ];
            } else {
              cmd = 'cp';
              if (parsed.recursive) cmdArgs.push('-r');
              if (parsed.force) cmdArgs.push('-f');
              cmdArgs.push(parsed.source, parsed.destination);
            }
            break;

          case 'move':
            if (!parsed.source || !parsed.destination) {
              throw new ToolValidationError('system.fileOps', ['source and destination required for move']);
            }
            if (isWindows) {
              cmd = 'powershell';
              cmdArgs = [
                '-Command',
                `Move-Item -Path "${parsed.source}" -Destination "${parsed.destination}"${parsed.force ? ' -Force' : ''}`,
              ];
            } else {
              cmd = 'mv';
              if (parsed.force) cmdArgs.push('-f');
              cmdArgs.push(parsed.source, parsed.destination);
            }
            break;

          case 'delete':
            if (!parsed.source) {
              throw new ToolValidationError('system.fileOps', ['source required for delete']);
            }
            if (isWindows) {
              cmd = 'powershell';
              cmdArgs = [
                '-Command',
                `Remove-Item -Path "${parsed.source}"${parsed.recursive ? ' -Recurse' : ''}${parsed.force ? ' -Force' : ''}`,
              ];
            } else {
              cmd = 'rm';
              if (parsed.recursive) cmdArgs.push('-r');
              if (parsed.force) cmdArgs.push('-f');
              cmdArgs.push(parsed.source);
            }
            break;

          case 'create':
            if (!parsed.destination || parsed.content === undefined) {
              throw new ToolValidationError('system.fileOps', ['destination and content required for create']);
            }
            if (isWindows) {
              cmd = 'powershell';
              cmdArgs = [
                '-Command',
                `Set-Content -Path "${parsed.destination}" -Value "${parsed.content.replace(/"/g, '`"')}"`,
              ];
            } else {
              cmd = 'sh';
              cmdArgs = ['-c', `echo "${parsed.content.replace(/"/g, '\\"')}" > "${parsed.destination}"`];
            }
            break;

          case 'mkdir':
            if (!parsed.destination) {
              throw new ToolValidationError('system.fileOps', ['destination required for mkdir']);
            }
            if (isWindows) {
              cmd = 'powershell';
              cmdArgs = [
                '-Command',
                `New-Item -ItemType Directory -Path "${parsed.destination}"${parsed.force ? ' -Force' : ''}`,
              ];
            } else {
              cmd = 'mkdir';
              if (parsed.recursive) cmdArgs.push('-p');
              cmdArgs.push(parsed.destination);
            }
            break;

          case 'chmod':
            if (isWindows) {
              throw new ToolValidationError('system.fileOps', ['chmod not supported on Windows (use icacls or file properties)']);
            }
            if (!parsed.source || !parsed.mode) {
              throw new ToolValidationError('system.fileOps', ['source and mode required for chmod']);
            }
            cmd = 'chmod';
            if (parsed.recursive) cmdArgs.push('-R');
            cmdArgs.push(parsed.mode, parsed.source);
            break;

          case 'chown':
            if (isWindows) {
              throw new ToolValidationError('system.fileOps', ['chown not supported on Windows (use icacls or takeown)']);
            }
            if (!parsed.source || !parsed.owner) {
              throw new ToolValidationError('system.fileOps', ['source and owner required for chown']);
            }
            cmd = 'chown';
            if (parsed.recursive) cmdArgs.push('-R');
            cmdArgs.push(parsed.owner, parsed.source);
            break;

          default:
            throw new ToolValidationError('system.fileOps', [`Unknown operation: ${parsed.operation}`]);
        }

        logger.info(
          { operation: parsed.operation, cmd, args: cmdArgs },
          'Executing file operation'
        );

        // Audit log before execution
        auditLogger.systemOperation(
          `file_ops.${parsed.operation}`,
          {
            source: parsed.source,
            destination: parsed.destination,
            recursive: parsed.recursive,
            force: parsed.force,
          },
          'success' // Will be updated on failure
        );

        const result = await execa(cmd, cmdArgs, {
          timeout: timeoutMs,
          reject: false,
        });

        const output = (result.stdout || '') + '\n' + (result.stderr || '');
        const truncated = truncateOutput(output || 'Operation completed successfully', maxOutputBytes);

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
          'File operation failed'
        );

        // Audit log failure
        auditLogger.systemOperation(
          `file_ops.${parsed.operation}`,
          {
            source: parsed.source,
            destination: parsed.destination,
          },
          'failure',
          String(e)
        );

        throw new ToolExecutionError('system.file_ops', e);
      }
    }
  );
}
