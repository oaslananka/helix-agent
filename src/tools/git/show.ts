import { ToolExecutionError } from '../../errors/index.js';
import { z } from 'zod';
import { createTool } from '../types.js';
import { truncateOutput } from '../../security/pathPolicy.js';
import { logger } from '../../security/logger.js';
import { execa } from 'execa';

const GitShowArgsSchema = z.object({
  ref: z.string(),
});

export function createGitShowTool(
  allowedRoots: string[],
  maxOutputBytes: number
) {
  return createTool(
    'git.show',
    `📄 GIT SHOW COMMIT

Show commit details - message, author, date, changes.

WHEN TO USE:
• Inspect specific commit
• Review what changed in a commit
• Find commit author/message
• Verify tag contents

PARAMETERS:
• ref: Commit SHA, branch, or tag (e.g., "abc123", "HEAD", "v1.0.0")

EXAMPLES:
1. Show last commit:
   {"ref": "HEAD"}

2. Show specific commit:
   {"ref": "a1b2c3d"}

3. Show commit 3 back:
   {"ref": "HEAD~3"}

4. Show tagged release:
   {"ref": "v1.2.0"}

OUTPUT INCLUDES:
• Commit SHA
• Author & date
• Commit message
• Full diff of changes

COMMON USE CASES:
• Code archaeology: Understand why code changed
• Bug tracking: Find when bug was introduced
• Release notes: Review tagged commits

BEST PRACTICES:
• Use full commit SHA for precision
• Check HEAD for latest changes
• Review tagged commits before release`,
    GitShowArgsSchema,
    async (args) => {
      const parsed = GitShowArgsSchema.parse(args);
      const cwd = allowedRoots[0];

      try {
        const result = await execa('git', ['show', parsed.ref], {
          cwd,
          timeout: 10000,
        });

        const output = result.stdout || '';
        const truncated = truncateOutput(output, maxOutputBytes);

        return {
          content: [{ type: 'text', text: truncated }],
        };
      } catch (e) {
        logger.warn({ cwd, ref: parsed.ref, error: String(e) }, 'git show failed');
        throw new ToolExecutionError('git.show', String(e));
      }
    }
  );
}
