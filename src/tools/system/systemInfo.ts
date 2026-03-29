import { ToolExecutionError, ToolValidationError } from '../../errors/index.js';
import { z } from 'zod';
import { createTool } from '../types.js';
import { truncateOutput } from '../../security/pathPolicy.js';
import { logger } from '../../security/logger.js';
import { execa } from 'execa';

const SystemInfoArgsSchema = z.object({
  info: z.enum(['os', 'cpu', 'memory', 'disk', 'network', 'all']),
});

export function createSystemInfoTool(
  maxOutputBytes: number,
  timeoutMs: number,
  unrestrictedMode: boolean = false
) {
  if (!unrestrictedMode) {
    return null;
  }

  return createTool(
    'system.info',
    `📊 SYSTEM INFORMATION

Get comprehensive system information (OS, CPU, memory, disk, network).

AVAILABLE INFO TYPES:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🖥️ OS INFO ("os"):
  • Windows: systeminfo, Get-ComputerInfo
  • Linux: uname -a, lsb_release, hostnamectl
  • Shows: OS version, hostname, uptime, architecture
  • Example: {"info": "os"}

🔧 CPU INFO ("cpu"):
  • Windows: Get-WmiObject Win32_Processor
  • Linux: lscpu, cat /proc/cpuinfo
  • Shows: CPU model, cores, threads, frequency
  • Example: {"info": "cpu"}

💾 MEMORY INFO ("memory"):
  • Windows: Get-WmiObject Win32_PhysicalMemory, systeminfo
  • Linux: free -h, cat /proc/meminfo
  • Shows: Total RAM, used, free, swap
  • Example: {"info": "memory"}

💿 DISK INFO ("disk"):
  • Windows: Get-Volume, Get-Disk
  • Linux: df -h, lsblk, fdisk -l
  • Shows: Disk usage, partitions, mount points
  • Example: {"info": "disk"}

🌐 NETWORK INFO ("network"):
  • Windows: Get-NetIPAddress, ipconfig /all
  • Linux: ip addr, ifconfig, nmcli
  • Shows: Network interfaces, IP addresses, MAC addresses
  • Example: {"info": "network"}

📊 ALL INFO ("all"):
  • Comprehensive system report
  • Combines all above information
  • Useful for system diagnostics
  • Example: {"info": "all"}

COMMON USE CASES:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. System Health Check:
   {"info": "all"}
   - Quick overview of system resources
   - Identify bottlenecks (CPU, RAM, disk)

2. Pre-Deployment Verification:
   {"info": "memory"} + {"info": "disk"}
   - Ensure sufficient resources
   - Check disk space before installs

3. Troubleshooting:
   {"info": "disk"}
   - Diagnose "disk full" errors
   - Find large partitions
   
   {"info": "memory"}
   - Check for memory leaks
   - Verify swap usage

4. Network Diagnostics:
   {"info": "network"}
   - Get IP addresses for configuration
   - Verify network interfaces active

5. Documentation:
   {"info": "os"} + {"info": "cpu"}
   - Document server specifications
   - Plan resource allocation

EXAMPLE OUTPUTS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DISK INFO (Linux):
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1       100G   45G   50G  48% /
/dev/sda2       500G  200G  280G  42% /home

MEMORY INFO (Windows):
Total Physical Memory: 16 GB
Available Memory:      8 GB
Used Memory:          8 GB (50%)
Swap/Page File:       4 GB

NETWORK INFO:
Interface: eth0
  IP: 192.168.1.100
  Mask: 255.255.255.0
  Gateway: 192.168.1.1
  MAC: 00:11:22:33:44:55

TIPS:
• Use 'all' for comprehensive diagnostics
• Combine with process/service tools for full picture
• Monitor disk usage regularly to prevent failures
• Check memory before running heavy applications
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    SystemInfoArgsSchema,
    async (args) => {
      const parsed = SystemInfoArgsSchema.parse(args);
      const isWindows = process.platform === 'win32';

      try {
        let commands: Array<{ label: string; cmd: string; args: string[] }> = [];

        switch (parsed.info) {
          case 'os':
            if (isWindows) {
              commands.push({
                label: 'OS Info',
                cmd: 'powershell',
                args: [
                  '-Command',
                  'Get-ComputerInfo | Select-Object WindowsProductName,WindowsVersion,OsHardwareAbstractionLayer,CsName,CsManufacturer,CsModel | Format-List',
                ],
              });
            } else {
              commands.push(
                { label: 'Kernel', cmd: 'uname', args: ['-a'] },
                { label: 'Distribution', cmd: 'cat', args: ['/etc/os-release'] },
                { label: 'Hostname', cmd: 'hostname', args: [] }
              );
            }
            break;

          case 'cpu':
            if (isWindows) {
              commands.push({
                label: 'CPU Info',
                cmd: 'powershell',
                args: [
                  '-Command',
                  'Get-WmiObject Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed | Format-List',
                ],
              });
            } else {
              commands.push({ label: 'CPU Info', cmd: 'lscpu', args: [] });
            }
            break;

          case 'memory':
            if (isWindows) {
              commands.push({
                label: 'Memory Info',
                cmd: 'powershell',
                args: [
                  '-Command',
                  '$os = Get-CimInstance Win32_OperatingSystem; Write-Output "Total: $([math]::Round($os.TotalVisibleMemorySize/1MB,2)) GB"; Write-Output "Free: $([math]::Round($os.FreePhysicalMemory/1MB,2)) GB"; Write-Output "Used: $([math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/1MB,2)) GB"',
                ],
              });
            } else {
              commands.push({ label: 'Memory Info', cmd: 'free', args: ['-h'] });
            }
            break;

          case 'disk':
            if (isWindows) {
              commands.push({
                label: 'Disk Info',
                cmd: 'powershell',
                args: [
                  '-Command',
                  'Get-Volume | Where-Object {$_.DriveLetter} | Format-Table DriveLetter,FileSystemLabel,FileSystem,Size,SizeRemaining -AutoSize',
                ],
              });
            } else {
              commands.push(
                { label: 'Disk Usage', cmd: 'df', args: ['-h'] },
                { label: 'Block Devices', cmd: 'lsblk', args: [] }
              );
            }
            break;

          case 'network':
            if (isWindows) {
              commands.push({
                label: 'Network Info',
                cmd: 'powershell',
                args: [
                  '-Command',
                  'Get-NetIPAddress | Where-Object {$_.AddressFamily -eq "IPv4"} | Format-Table InterfaceAlias,IPAddress,PrefixLength -AutoSize',
                ],
              });
            } else {
              commands.push({ label: 'Network Interfaces', cmd: 'ip', args: ['addr'] });
            }
            break;

          case 'all':
            // Recursively get all info
            if (isWindows) {
              commands.push(
                {
                  label: '=== OS INFO ===',
                  cmd: 'powershell',
                  args: [
                    '-Command',
                    'Get-ComputerInfo | Select-Object WindowsProductName,WindowsVersion,CsName | Format-List',
                  ],
                },
                {
                  label: '=== CPU INFO ===',
                  cmd: 'powershell',
                  args: [
                    '-Command',
                    'Get-WmiObject Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors | Format-List',
                  ],
                },
                {
                  label: '=== MEMORY INFO ===',
                  cmd: 'powershell',
                  args: [
                    '-Command',
                    '$os = Get-CimInstance Win32_OperatingSystem; Write-Output "Total: $([math]::Round($os.TotalVisibleMemorySize/1MB,2)) GB"; Write-Output "Free: $([math]::Round($os.FreePhysicalMemory/1MB,2)) GB"',
                  ],
                },
                {
                  label: '=== DISK INFO ===',
                  cmd: 'powershell',
                  args: [
                    '-Command',
                    'Get-Volume | Where-Object {$_.DriveLetter} | Format-Table -AutoSize',
                  ],
                },
                {
                  label: '=== NETWORK INFO ===',
                  cmd: 'powershell',
                  args: [
                    '-Command',
                    'Get-NetIPAddress | Where-Object {$_.AddressFamily -eq "IPv4"} | Format-Table -AutoSize',
                  ],
                }
              );
            } else {
              commands.push(
                { label: '=== OS INFO ===', cmd: 'uname', args: ['-a'] },
                { label: '=== CPU INFO ===', cmd: 'lscpu', args: [] },
                { label: '=== MEMORY INFO ===', cmd: 'free', args: ['-h'] },
                { label: '=== DISK INFO ===', cmd: 'df', args: ['-h'] },
                { label: '=== NETWORK INFO ===', cmd: 'ip', args: ['addr'] }
              );
            }
            break;

          default:
            throw new ToolValidationError('system.systemInfo', [`Unknown info type: ${parsed.info}`]);
        }

        let output = '';

        for (const { label, cmd, args } of commands) {
          try {
            output += `\n${label}:\n`;
            const result = await execa(cmd, args, {
              timeout: timeoutMs,
              reject: false,
            });
            output += result.stdout || result.stderr || '';
            output += '\n';
          } catch (e: unknown) {
            output += `Error: ${String(e)}\n`;
          }
        }

        const truncated = truncateOutput(output, maxOutputBytes);

        return {
          content: [
            {
              type: 'text',
              text: truncated,
            },
          ],
        };
      } catch (e: unknown) {
        logger.warn({ info: parsed.info, error: String(e) }, 'System info failed');
        throw new ToolExecutionError('system.systemInfo', String(e));
      }
    }
  );
}
