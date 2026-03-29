import { ToolExecutionError } from '../../errors/index.js';
import { z } from 'zod';
import { createTool } from '../types.js';
import { resolvePath, truncateOutput } from '../../security/pathPolicy.js';
import { logger } from '../../security/logger.js';
import { execa } from 'execa';

const GitDiffArgsSchema = z.object({
  base: z.string().default('HEAD'),
  paths: z.array(z.string()).optional(),
});

export function createGitDiffTool(
  allowedRoots: string[],
  maxOutputBytes: number
) {
  return createTool(
    'git.diff',
    `🔍 GIT DIFF

Show code changes between commits or working tree.

WHEN TO USE:
• Review changes before committing
• Compare branches or commits
• Understand what changed in specific files
• Code review preparation

PARAMETERS:
• base: Commit/branch to compare against (default: "HEAD")
• paths: Specific files to diff (optional)

EXAMPLES:
1. Show uncommitted changes:
   {"base": "HEAD"}

2. Compare with previous commit:
   {"base": "HEAD~1"}

3. Compare branches:
   {"base": "main"}

4. Diff specific file:
   {"base": "HEAD", "paths": ["src/index.ts"]}

5. Compare with 5 commits ago:
   {"base": "HEAD~5"}

OUTPUT FORMAT:
diff --git a/file.ts b/file.ts
- deleted line
+ added line

COMMON USE CASES:
• Pre-commit review: {"base": "HEAD"}
• Feature branch vs main: {"base": "main"}
• Last commit changes: {"base": "HEAD~1"}
• Specific file history: {"base": "HEAD~10", "paths": ["config.ts"]}

BEST PRACTICES:
• Review diff before committing
• Use paths to focus on specific changes
• Compare feature branches before merging`,
    GitDiffArgsSchema,
    async (args) => {
      const parsed = GitDiffArgsSchema.parse(args);
      const cwd = allowedRoots[0];

      try {
        const diffArgs = ['diff', parsed.base];
        if (parsed.paths && parsed.paths.length > 0) {
          // Validate paths are within repo
          for (const p of parsed.paths) {
            resolvePath(p, allowedRoots);
          }
          diffArgs.push('--', ...parsed.paths);
        }

        const result = await execa('git', diffArgs, {
          cwd,
          timeout: 10000,
        });

        const output = result.stdout || '';
        const truncated = truncateOutput(output, maxOutputBytes);

        return {
          content: [{ type: 'text', text: truncated || 'No differences' }],
        };
      } catch (e) {
        logger.warn({ cwd, error: String(e) }, 'git diff failed');
        throw new ToolExecutionError('git.diff', String(e));
      }
    }
  );
}
