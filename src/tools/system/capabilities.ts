import { ToolExecutionError } from '../../errors/index.js';
import { z } from 'zod';
import { createTool } from '../types.js';
import { execa } from 'execa';
import os from 'os';
import fs from 'fs/promises';

const CapabilitiesArgsSchema = z.object({});

export function createCapabilitiesTool(
  maxFileBytes: number,
  maxOutputBytes: number,
  maxSearchMatches: number,
  maxTreeEntries: number,
  execTimeoutMs: number,
  unrestrictedMode: boolean,
  dockerEnabled: boolean,
  gitEnabled: boolean,
  httpEnabled: boolean,
  repoRoots: string[]
) {
  return createTool(
    'system.get_capabilities',
    `🔍 GET SYSTEM CAPABILITIES

Get comprehensive information about agent capabilities, limits, permissions, and sandbox boundaries.

PURPOSE:
This tool provides a complete picture of what the agent can and cannot do, helping you:
• Plan operations within known limits
• Avoid trial-and-error approaches
• Understand security boundaries
• Make informed decisions about tool selection

WHEN TO USE:
• Before starting complex multi-step operations
• When encountering unexpected behavior
• To verify resource availability
• For debugging limit-related issues
• To document system constraints

OUTPUT INCLUDES:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔐 IDENTITY: Who is running commands (uid, gid, mode)
📏 LIMITS: Hard boundaries (file size, output, timeout, etc.)
💻 RESOURCES: CPU, memory, disk quotas
📂 FILESYSTEM: Writable paths, mounts, Docker socket access
🌐 NETWORK: Internet access, HTTP allowlists
🔒 SANDBOX: Container/host separation, kernel masking

EXAMPLE USAGE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{}  // No parameters needed

EXAMPLE OUTPUT:
{
  "identity": {
    "uid": 0,
    "gid": 0,
    "username": "root",
    "mode": "container-root"
  },
  "limits": {
    "max_file_read_bytes": 2097152,
    "max_output_bytes": 204800,
    "max_search_matches": 2000,
    "max_tree_entries": 50000,
    "exec_timeout_ms": 120000,
    "open_files": 1024
  },
  "features": {
    "unrestricted_mode": true,
    "docker_enabled": true,
    "git_enabled": true,
    "http_fetch_enabled": true
  },
  "filesystem": {
    "repo_roots": ["/projects"],
    "writable": true,
    "docker_socket_access": true
  },
  "resources": {
    "cpu_cores": 8,
    "total_memory_gb": 16,
    "available_disk_gb": 311
  },
  "sandbox": {
    "containerized": true,
    "host_access": false
  }
}

USE CASES:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. File Operations:
   Check max_file_read_bytes before reading large files
   Plan chunked operations for files > 2MB

2. Code Execution:
   Verify exec_timeout_ms for long-running processes
   Check unrestricted_mode for system commands

3. Resource Planning:
   Check available_disk_gb before large operations
   Verify cpu_cores for parallel processing

4. Security Verification:
   Confirm sandbox boundaries
   Verify docker_socket_access for container ops

TIPS:
• Call this once at session start for planning
• Use limits to avoid hitting boundaries
• Check features before using advanced tools
• Verify paths are within repo_roots
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    CapabilitiesArgsSchema,
    async () => {
      try {
        // Get identity info
        interface IdentityInfo { uid?: number; gid?: number; username?: string; groups?: string[]; mode?: string; error?: string; }
      let identity: IdentityInfo = {};
        try {
          if (process.platform === 'win32') {
            const whoami = await execa('whoami', [], { timeout: 5000 });
            identity = {
              username: whoami.stdout.trim(),
              mode: 'windows',
            };
          } else {
            const id = await execa('id', [], { timeout: 5000 });
            const idMatch = id.stdout.match(/uid=(\d+)\((\w+)\)\s+gid=(\d+)\((\w+)\)/);
            if (idMatch) {
              identity = {
                uid: parseInt(idMatch[1]),
                gid: parseInt(idMatch[3]),
                username: idMatch[2],
                mode: idMatch[1] === '0' ? 'container-root' : 'user',
              };
            }
          }
        } catch (e) {
          identity = { error: 'Unable to determine identity' };
        }

        // Check containerization
        interface SandboxInfo { containerized: boolean; host_access: boolean; cgroup?: string }
      let sandbox: SandboxInfo = { containerized: false, host_access: true };
        try {
          const cgroup = await fs.readFile('/proc/1/cgroup', 'utf-8');
          if (cgroup.includes('docker') || cgroup.includes('containerd') || cgroup === '0::/\n') {
            sandbox.containerized = true;
            sandbox.host_access = false;
          }
        } catch (e) {
          // Not Linux or no access to cgroup
        }

        // Get resource info
        const cpus = os.cpus().length;
        const totalMemGB = Math.round((os.totalmem() / (1024 ** 3)) * 100) / 100;
        
        // Get disk space
        let diskGB = 0;
        try {
          if (process.platform === 'win32') {
            const df = await execa('powershell', ['-Command', 
              '(Get-PSDrive -PSProvider FileSystem | Where-Object {$_.Name -eq "C"} | Select-Object -ExpandProperty Free) / 1GB'
            ], { timeout: 5000 });
            diskGB = Math.round(parseFloat(df.stdout) * 100) / 100;
          } else {
            const df = await execa('df', ['-BG', repoRoots[0] || '/'], { timeout: 5000 });
            const match = df.stdout.match(/(\d+)G\s+\d+%/);
            if (match) diskGB = parseInt(match[1]);
          }
        } catch (e) {
          diskGB = 0;
        }

        // Check Docker socket
        let dockerSocketAccess = false;
        try {
          await fs.access('/var/run/docker.sock');
          dockerSocketAccess = true;
        } catch (e) {
          // No Docker socket access
        }

        // Get open files limit
        let openFiles = 1024;
        try {
          if (process.platform !== 'win32') {
            const ulimit = await execa('sh', ['-c', 'ulimit -n'], { timeout: 5000 });
            openFiles = parseInt(ulimit.stdout);
          }
        } catch (e) {
          // Default
        }

        const capabilities = {
          identity,
          limits: {
            max_file_read_bytes: maxFileBytes,
            max_output_bytes: maxOutputBytes,
            max_search_matches: maxSearchMatches,
            max_tree_entries: maxTreeEntries,
            exec_timeout_ms: execTimeoutMs,
            open_files: openFiles,
          },
          features: {
            unrestricted_mode: unrestrictedMode,
            docker_enabled: dockerEnabled,
            git_enabled: gitEnabled,
            http_fetch_enabled: httpEnabled,
          },
          filesystem: {
            repo_roots: repoRoots,
            writable: true,
            docker_socket_access: dockerSocketAccess,
          },
          resources: {
            cpu_cores: cpus,
            total_memory_gb: totalMemGB,
            available_disk_gb: diskGB,
          },
          sandbox,
          platform: {
            os: process.platform,
            arch: process.arch,
            node_version: process.version,
          },
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(capabilities, null, 2),
            },
          ],
        };
      } catch (e) {
        throw new ToolExecutionError('system.capabilities', String(e));
      }
    }
  );
}
