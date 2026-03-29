import { ToolExecutionError, PolicyDeniedError } from '../../errors/index.js';
import { z } from 'zod';
import { createTool } from '../types.js';
import { resolvePath, truncateOutput } from '../../security/pathPolicy.js';
import { logger } from '../../security/logger.js';
import { execa } from 'execa';

const ExecArgsSchema = z.object({
  cmd: z.string(),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
});

interface AllowlistEntry {
  cmd: string;
  argsPrefix: string[];
}

export function createExecTool(
  allowedRoots: string[],
  maxOutputBytes: number,
  allowlist: AllowlistEntry[],
  defaultCwd: string,
  timeoutMs: number,
  unrestrictedMode: boolean = false
) {
  return createTool(
    'runner.exec',
    `${unrestrictedMode ? '⚠️ UNRESTRICTED MODE ENABLED ⚠️\n\nExecute ANY command on the system - NO RESTRICTIONS.\nThis tool can execute shell commands, scripts, and programs with FULL system access.\n\n' : 'Execute allowlisted shell commands in the project directory.\n\n'}${unrestrictedMode ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 AVAILABLE COMMANDS (UNRESTRICTED):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🪟 WINDOWS COMMANDS:
  • PowerShell: Get-Process, Get-Service, Get-ChildItem, Set-Content
  • CMD: dir, copy, move, del, mkdir, rmdir, tasklist, taskkill
  • Package: choco install, winget install, scoop install
  • System: systeminfo, wmic, reg query, netstat, ipconfig
  • File ops: type, more, findstr, fc, attrib, xcopy

🐧 LINUX COMMANDS:
  • File: ls, cat, cp, mv, rm, mkdir, touch, chmod, chown, ln
  • Process: ps, top, htop, kill, killall, pkill, pgrep
  • System: systemctl, service, journalctl, dmesg, uname
  • Package: apt install, yum install, dnf install, pacman -S
  • Network: netstat, ss, ping, curl, wget, nmap, iptables
  • Disk: df, du, mount, fdisk, lsblk
  • Users: useradd, usermod, passwd, groups, sudo

🤖 AI/DEV TOOLS:
  • Gemini: gemini -p "prompt" [--yolo] [--resume ID]
  • Jules: jules new "task" [--parallel N]
  • Docker: docker ps, logs, exec, run, build, compose
  • Git: git status, commit, push, pull, diff, log
  • Node: npm install, run, test, build
  • Python: pip install, python script.py

📂 FILE SYSTEM OPERATIONS:
  • Read: cat file.txt, type file.txt, Get-Content file.txt
  • Write: echo "text" > file.txt, Set-Content file.txt "text"
  • Copy: cp src dst, copy src dst, Copy-Item src dst
  • Move: mv src dst, move src dst, Move-Item src dst
  • Delete: rm file, del file, Remove-Item file [-Force]
  • Search: find / -name "*.js", findstr "pattern" *.txt

⚡ SYSTEM ADMINISTRATION:
  • Services: systemctl start/stop/restart service
  • Windows Services: sc start/stop service, Get-Service
  • Processes: kill -9 PID, taskkill /F /PID 1234
  • Monitoring: top, htop, Get-Process | Sort CPU -Descending
  • Logs: journalctl -u service, Get-EventLog -LogName System

🌐 NETWORK OPERATIONS:
  • Check ports: netstat -tulpn, Get-NetTCPConnection
  • Test connectivity: ping host, Test-Connection host
  • Download: wget URL, curl -O URL, Invoke-WebRequest
  • Scan: nmap -p- host

EXAMPLE WORKFLOWS:
• Install package: 
  Windows: choco install nodejs -y
  Linux: sudo apt update && sudo apt install nodejs -y

• Manage service:
  Windows: sc start nginx / Get-Service nginx | Start-Service
  Linux: sudo systemctl start nginx

• Find & kill process:
  Windows: Get-Process chrome | Stop-Process -Force
  Linux: pkill -f chrome

• Cleanup disk:
  Windows: Remove-Item C:\\Temp\\* -Recurse -Force
  Linux: sudo rm -rf /tmp/*

• Deploy application:
  git pull origin main && npm install && npm run build && systemctl restart myapp

• System health check:
  df -h && free -h && ps aux --sort=-%mem | head -n 10

⚠️ IMPORTANT NOTES:
- Commands execute in the working directory (default: /projects or configured CWD)
- You can change directory with 'cwd' parameter
- Windows: Use PowerShell commands or cmd.exe commands
- Linux: Use bash/sh commands
- Sudo commands work if agent runs with proper privileges
- Output is truncated if > ${maxOutputBytes} bytes
- Timeout: ${timeoutMs}ms per command
- Use absolute paths when needed for clarity

CROSS-PLATFORM TIPS:
- Check OS first: uname (Linux) or $PSVersionTable (Windows)
- Use 'which cmd' or 'Get-Command cmd' to verify availability
- Adapt commands based on detected OS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
` : `AVAILABLE TOOLS & COMMANDS:`}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤖 GEMINI CLI (AI Code Assistant):
  gemini -p "your prompt here"           # Ask Gemini
  gemini -p "review code" --yolo         # Auto-approve
  gemini -p "find bugs" -o json          # JSON output
  gemini --resume latest                 # Continue session
  
🚀 JULES CLI (Async Coding Agent):
  jules new "task description"           # Create task
  jules new --parallel 3 "description"   # 3 parallel tasks
  jules remote list --session            # List sessions
  jules remote pull --session ID --apply # Get & apply result
  jules teleport SESSION_ID              # Clone + apply changes

📦 PACKAGE MANAGERS:
  npm install package-name    # Install Node.js package
  npm test                    # Run tests
  npm run build               # Build project
  pip install package         # Python package
  
🐳 DOCKER (via host):
  docker ps                   # List containers
  docker logs container-name  # View logs
  docker stats --no-stream    # Resource usage

📝 GIT:
  git status                  # Check status
  git add .                   # Stage all
  git commit -m "message"     # Commit
  git push                    # Push to remote

EXAMPLE WORKFLOWS:
• Code review: gemini -p "review $(cat src/file.js)" --yolo
• Bug fix: jules new "fix authentication bug in user.js"
• Build & test: npm run build && npm test
• Monitor: docker logs my-app --tail 50

Note: Commands execute in /projects directory (mounted Windows folder)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ExecArgsSchema,
    async (args) => {
      const parsed = ExecArgsSchema.parse(args);

      // Check allowlist (bypass if unrestricted mode)
      if (!unrestrictedMode) {
        const allowed = allowlist.find((entry) => entry.cmd === parsed.cmd);
        if (!allowed) {
          throw new PolicyDeniedError(`Command not in allowlist: ${parsed.cmd}`, 'runner.exec');
        }

        // Check args prefix
        if (!allowed.argsPrefix.every((prefix, idx) => parsed.args[idx] === prefix)) {
          throw new PolicyDeniedError(
            `Arguments do not match allowlist prefix for ${parsed.cmd}: expected [${allowed.argsPrefix.join(', ')}]`, 'runner.exec'
          );
        }
      }

      // Resolve cwd
      const cwd = parsed.cwd ? resolvePath(parsed.cwd, allowedRoots) : defaultCwd;

      try {
        logger.info({ cmd: parsed.cmd, args: parsed.args, cwd }, 'Executing command');

        const result = await execa(parsed.cmd, parsed.args, {
          cwd,
          timeout: timeoutMs,
          reject: false,
        });

        const output = (result.stdout || '') + '\n' + (result.stderr || '');
        const truncated = truncateOutput(output, maxOutputBytes);

        return {
          content: [
            {
              type: 'text',
              text: truncated,
            },
          ],
        };
      } catch (e) {
        logger.warn(
          { cmd: parsed.cmd, error: String(e) },
          'Command execution failed'
        );
        throw new ToolExecutionError('runner.exec', String(e));
      }
    }
  );
}
