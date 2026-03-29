import { ToolExecutionError, ToolValidationError } from '../../errors/index.js';
import { z } from 'zod';
import { createTool } from '../types.js';
import { truncateOutput } from '../../security/pathPolicy.js';
import { logger } from '../../security/logger.js';
import { auditLogger } from '../../security/auditLogger.js';
import { execa } from 'execa';

const ServiceOpsArgsSchema = z.object({
  operation: z.enum(['list', 'status', 'start', 'stop', 'restart', 'enable', 'disable']),
  service: z.string().optional(),
});

export function createServiceTool(
  maxOutputBytes: number,
  timeoutMs: number,
  unrestrictedMode: boolean = false
) {
  if (!unrestrictedMode) {
    return null;
  }

  return createTool(
    'system.service',
    `⚠️ SERVICE MANAGEMENT (UNRESTRICTED) ⚠️

Manage system services (Windows Services / Linux systemd/init).

SUPPORTED OPERATIONS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 LIST SERVICES:
  • Windows: Get-Service
  • Linux: systemctl list-units --type=service
  • Examples:
    - List all: {"operation": "list"}
    - Shows all services with their status (running/stopped)

🔍 SERVICE STATUS:
  • Check status of a specific service
  • Windows: Get-Service -Name service
  • Linux: systemctl status service
  • Examples:
    - {"operation": "status", "service": "nginx"}
    - {"operation": "status", "service": "Docker"}

▶️ START SERVICE:
  • Start a stopped service
  • Windows: Start-Service -Name service
  • Linux: systemctl start service
  • Examples:
    - {"operation": "start", "service": "nginx"}
    - {"operation": "start", "service": "postgresql"}

⏸️ STOP SERVICE:
  • Stop a running service
  • Windows: Stop-Service -Name service
  • Linux: systemctl stop service
  • Examples:
    - {"operation": "stop", "service": "apache2"}
    - {"operation": "stop", "service": "MySQL"}

🔄 RESTART SERVICE:
  • Restart a service (stop + start)
  • Windows: Restart-Service -Name service
  • Linux: systemctl restart service
  • Examples:
    - {"operation": "restart", "service": "nginx"}
    - {"operation": "restart", "service": "docker"}

✅ ENABLE SERVICE:
  • Enable service to start on boot
  • Windows: Set-Service -Name service -StartupType Automatic
  • Linux: systemctl enable service
  • Examples:
    - {"operation": "enable", "service": "docker"}

❌ DISABLE SERVICE:
  • Disable service from starting on boot
  • Windows: Set-Service -Name service -StartupType Disabled
  • Linux: systemctl disable service
  • Examples:
    - {"operation": "disable", "service": "bluetooth"}

PARAMETERS:
• operation: Type of operation (list|status|start|stop|restart|enable|disable)
• service: Service name (required for all except list)

⚠️ WARNINGS:
- Requires administrator/root privileges for most operations
- Stopping critical services can affect system stability
- Windows: Use exact service name (case-insensitive, but exact match)
- Linux: Service names often have .service suffix (e.g., nginx.service)
- Restart causes brief downtime

COMMON SERVICES:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🪟 WINDOWS:
  • Docker, MySQL, MongoDB, PostgreSQL
  • W3SVC (IIS), MSSQLSERVER
  • ssh-agent, WinRM
  • wuauserv (Windows Update)

🐧 LINUX:
  • nginx, apache2, httpd
  • docker, containerd
  • mysql, postgresql, mongodb
  • ssh, sshd
  • NetworkManager, systemd-networkd
  • cron, rsyslog

COMMON USE CASES:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Web Server Management:
   - Apply config changes: {"operation": "restart", "service": "nginx"}
   - Start production: {"operation": "start", "service": "apache2"}
   
2. Database Operations:
   - Maintenance: {"operation": "stop", "service": "postgresql"}
   - Resume: {"operation": "start", "service": "postgresql"}

3. Docker Management:
   - Restart Docker daemon: {"operation": "restart", "service": "docker"}
   - Enable on boot: {"operation": "enable", "service": "docker"}

4. Development:
   - Stop conflicting services: {"operation": "stop", "service": "IIS"}
   - Start dev database: {"operation": "start", "service": "MySQL"}

5. System Maintenance:
   - List all services: {"operation": "list"}
   - Check service health: {"operation": "status", "service": "nginx"}

EXAMPLES WITH WORKFLOWS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Deploy new Nginx config:
1. {"operation": "status", "service": "nginx"}     # Check current status
2. Use runner.exec to test config: nginx -t
3. {"operation": "restart", "service": "nginx"}    # Apply changes

Database backup workflow:
1. {"operation": "stop", "service": "postgresql"}  # Stop DB
2. Use system.file_ops to backup data directory
3. {"operation": "start", "service": "postgresql"} # Restart DB

Development environment setup:
1. {"operation": "enable", "service": "docker"}
2. {"operation": "start", "service": "docker"}
3. {"operation": "enable", "service": "postgresql"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ServiceOpsArgsSchema,
    async (args) => {
      const parsed = ServiceOpsArgsSchema.parse(args);
      const isWindows = process.platform === 'win32';

      try {
        let cmd: string;
        let cmdArgs: string[] = [];

        if (parsed.operation !== 'list' && !parsed.service) {
          throw new ToolValidationError('system.service', ['service name required for this operation']);
        }

        switch (parsed.operation) {
          case 'list':
            if (isWindows) {
              cmd = 'powershell';
              cmdArgs = [
                '-Command',
                'Get-Service | Sort-Object Status,DisplayName | Format-Table -AutoSize',
              ];
            } else {
              cmd = 'systemctl';
              cmdArgs = ['list-units', '--type=service', '--all'];
            }
            break;

          case 'status':
            if (isWindows) {
              cmd = 'powershell';
              cmdArgs = ['-Command', `Get-Service -Name "${parsed.service}" | Format-List *`];
            } else {
              cmd = 'systemctl';
              cmdArgs = ['status', parsed.service!];
            }
            break;

          case 'start':
            if (isWindows) {
              cmd = 'powershell';
              cmdArgs = ['-Command', `Start-Service -Name "${parsed.service}"`];
            } else {
              cmd = 'systemctl';
              cmdArgs = ['start', parsed.service!];
            }
            break;

          case 'stop':
            if (isWindows) {
              cmd = 'powershell';
              cmdArgs = ['-Command', `Stop-Service -Name "${parsed.service}"`];
            } else {
              cmd = 'systemctl';
              cmdArgs = ['stop', parsed.service!];
            }
            break;

          case 'restart':
            if (isWindows) {
              cmd = 'powershell';
              cmdArgs = ['-Command', `Restart-Service -Name "${parsed.service}"`];
            } else {
              cmd = 'systemctl';
              cmdArgs = ['restart', parsed.service!];
            }
            break;

          case 'enable':
            if (isWindows) {
              cmd = 'powershell';
              cmdArgs = [
                '-Command',
                `Set-Service -Name "${parsed.service}" -StartupType Automatic`,
              ];
            } else {
              cmd = 'systemctl';
              cmdArgs = ['enable', parsed.service!];
            }
            break;

          case 'disable':
            if (isWindows) {
              cmd = 'powershell';
              cmdArgs = [
                '-Command',
                `Set-Service -Name "${parsed.service}" -StartupType Disabled`,
              ];
            } else {
              cmd = 'systemctl';
              cmdArgs = ['disable', parsed.service!];
            }
            break;

          default:
            throw new ToolValidationError('system.service', [`Unknown operation: ${parsed.operation}`]);
        }

        logger.info(
          { operation: parsed.operation, service: parsed.service, cmd, args: cmdArgs },
          'Executing service operation'
        );

        // Audit log service operations
        auditLogger.systemOperation(
          `service.${parsed.operation}`,
          {
            service: parsed.service,
            operation: parsed.operation,
          },
          'success' // Will update on failure
        );

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
          { operation: parsed.operation, service: parsed.service, error: String(e) },
          'Service operation failed'
        );

        // Audit log failure
        auditLogger.systemOperation(
          `service.${parsed.operation}`,
          {
            service: parsed.service,
            operation: parsed.operation,
          },
          'failure',
          String(e)
        );

        throw new ToolExecutionError('system.service', e);
      }
    }
  );
}
