import { ToolExecutionError } from '../../errors/index.js';
import { z } from 'zod';
import { createTool } from '../types.js';
import { resolvePath, truncateOutput } from '../../security/pathPolicy.js';
import { logger } from '../../security/logger.js';
import { execa } from 'execa';

const GitStatusArgsSchema = z.object({
  repoRoot: z.string().optional(),
});

export function createGitStatusTool(
  allowedRoots: string[],
  maxOutputBytes: number
) {
  return createTool(
    'git.status',
    `🌱 GIT STATUS

Show git repository status - modified, staged, untracked files.

WHEN TO USE:
• Check what files changed before commit
• Verify staging area contents
• Find untracked files
• Check if repo is clean

OUTPUT FORMAT (--porcelain):
 M modified.ts        # Modified, not staged
M  staged.ts          # Staged for commit
MM both.ts            # Modified + staged
?? untracked.ts      # Not in git
 D deleted.ts         # Deleted

EXAMPLES:
1. Check current status:
   {}

2. Check specific repo:
   {"repoRoot": "/path/to/repo"}

COMMON WORKFLOWS:
1. Before commit: Check what will be committed
2. After changes: Verify expected files changed
3. Pre-deployment: Ensure working tree is clean

BEST PRACTICES:
• Check status before git operations
• Clean working tree = ready to deploy
• Combine with git.diff to see actual changes`,
    GitStatusArgsSchema,
    async (args) => {
      const parsed = GitStatusArgsSchema.parse(args);
      const cwd = parsed.repoRoot ? resolvePath(parsed.repoRoot, allowedRoots) : allowedRoots[0];

      try {
        const result = await execa('git', ['status', '--porcelain'], {
          cwd,
          timeout: 10000,
        });

        const output = result.stdout || '';
        const truncated = truncateOutput(output, maxOutputBytes);

        return {
          content: [
            {
              type: 'text',
              text: truncated || 'Repository is clean',
            },
          ],
        };
      } catch (e) {
        logger.warn({ cwd, error: String(e) }, 'git status failed');
        throw new ToolExecutionError('git.status', String(e));
      }
    }
  );
}
