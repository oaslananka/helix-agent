import { ToolExecutionError } from '../../errors/index.js';
import { z } from 'zod';
import { createTool } from '../types.js';
import { truncateOutput } from '../../security/pathPolicy.js';
import { logger } from '../../security/logger.js';
import { execa } from 'execa';

const DockerPsArgsSchema = z.object({
  all: z.boolean().default(false),
});

export function createDockerPsTool(
  maxOutputBytes: number,
  dockerSocketPath: string
) {
  return createTool(
    'docker.ps',
    `🐳 DOCKER CONTAINERS LIST

List Docker containers - running or all.

WHEN TO USE:
• Check what containers are running
• Find container IDs/names
• Monitor container status
• Verify deployments

PARAMETERS:
• all: Include stopped containers (default: false)

EXAMPLES:
1. List running containers:
   {"all": false}

2. List all containers (including stopped):
   {"all": true}

OUTPUT INCLUDES:
• Container ID
• Image name
• Command
• Created time
• Status (Up/Exited)
• Ports
• Names

COMMON USE CASES:
• Check if app container running
• Find container name for logs
• Monitor docker-compose stack
• Troubleshoot stopped containers

BEST PRACTICES:
• Use container names in docker.logs
• Check status before restart attempts
• Monitor port conflicts`,
    DockerPsArgsSchema,
    async (args) => {
      const parsed = DockerPsArgsSchema.parse(args);

      try {
        const psArgs = ['ps', '--no-trunc'];
        if (parsed.all) {
          psArgs.push('-a');
        }

        const result = await execa('docker', psArgs, {
          timeout: 10000,
          env: {
            DOCKER_HOST: process.env.DOCKER_HOST || `unix://${dockerSocketPath}`,
          },
        });

        const output = result.stdout || '';
        const truncated = truncateOutput(output, maxOutputBytes);

        return {
          content: [{ type: 'text', text: truncated }],
        };
      } catch (e: unknown) {
        logger.warn({ error: String(e) }, 'docker ps failed');
        throw new ToolExecutionError('docker.ps', e);
      }
    }
  );
}

const DockerLogsArgsSchema = z.object({
  container: z.string(),
  tail: z.number().int().positive().default(100),
});

export function createDockerLogsTool(
  maxOutputBytes: number,
  dockerSocketPath: string
) {
  return createTool(
    'docker.logs',
    `📋 DOCKER CONTAINER LOGS

Get logs from a Docker container - debugging and monitoring.

WHEN TO USE:
• Debug container issues
• Monitor application logs
• Troubleshoot crashes
• Verify startup sequence

PARAMETERS:
• container: Container name or ID (from docker.ps)
• tail: Number of recent lines (default: 100)

EXAMPLES:
1. Recent logs (last 100 lines):
   {"container": "my-app", "tail": 100}

2. More context (500 lines):
   {"container": "nginx", "tail": 500}

3. Quick check (last 20 lines):
   {"container": "postgres", "tail": 20}

4. By container ID:
   {"container": "a1b2c3d4", "tail": 100}

COMMON USE CASES:
• Error investigation: tail=500 for context
• Startup verification: tail=50 to see initialization
• Real-time issues: tail=100 for recent activity
• Crash diagnosis: tail=1000 to capture full sequence

BEST PRACTICES:
• Use docker.ps first to get container names
• Start with tail=100, increase if needed
• Look for ERROR, WARN, Exception keywords
• Combine with system.process to check resources

TROUBLESHOOTING:
• Container not found? Check docker.ps output
• No logs? Container might not produce stdout/stderr
• Need live logs? Use runner.exec: docker logs -f container`,
    DockerLogsArgsSchema,
    async (args) => {
      const parsed = DockerLogsArgsSchema.parse(args);

      try {
        const result = await execa(
          'docker',
          ['logs', '--tail', String(parsed.tail), parsed.container],
          {
            timeout: 10000,
            env: {
              DOCKER_HOST: process.env.DOCKER_HOST || `unix://${dockerSocketPath}`,
            },
          }
        );

        const output = result.stdout || '';
        const truncated = truncateOutput(output, maxOutputBytes);

        return {
          content: [{ type: 'text', text: truncated }],
        };
      } catch (e: unknown) {
        logger.warn({ container: parsed.container, error: String(e) }, 'docker logs failed');
        throw new ToolExecutionError('docker.logs', e);
      }
    }
  );
}
