import { z } from 'zod';
import { readdir, stat } from 'fs/promises';
import { join, relative } from 'path';
import { createTool } from '../types.js';
import { resolvePath, truncateOutput } from '../../security/pathPolicy.js';
import { logger } from '../../security/logger.js';

const ListTreeArgsSchema = z.object({
  path: z.string().default('.'),
  depth: z.number().int().positive().default(4),
  ignore: z.array(z.string()).default([]),
});

export function createListTreeTool(
  allowedRoots: string[],
  maxOutputBytes: number,
  maxTreeEntries: number
) {
  return createTool(
    'repo.list_tree',
    `📁 LIST DIRECTORY TREE

List directory structure with depth control - explore project layout.

WHEN TO USE:
• Explore unfamiliar project structure
• Find specific file locations
• Understand folder organization
• Document project layout

PARAMETERS:
• path: Directory to list (default: "." - current/root)
• depth: How deep to traverse (default: 4, max: configured)
• ignore: Patterns to skip (e.g., ["node_modules", ".git", "dist"])

EXAMPLES:
1. List entire project structure:
   {"path": ".", "depth": 4}

2. Deep dive into specific folder:
   {"path": "src/components", "depth": 10}

3. Exclude build artifacts:
   {"path": ".", "depth": 5, "ignore": ["node_modules", "dist", ".next"]}

4. Quick overview (2 levels):
   {"path": ".", "depth": 2}

BEST PRACTICES:
• Start with shallow depth (2-3) for overview
• Use ignore to skip large/irrelevant folders
• Increase depth when focusing on specific area
• Common ignores: node_modules, .git, dist, build, .next, target

OUTPUT FORMAT:
dir/
  subdir/
    file.ts
    another.ts
  file.js`,
    ListTreeArgsSchema,
    async (args) => {
      const parsed = ListTreeArgsSchema.parse(args);
      const resolvedPath = resolvePath(parsed.path, allowedRoots);

      let entries = 0;
      const lines: string[] = [];

      const traverse = async (currentPath: string, currentDepth: number): Promise<void> => {
        if (currentDepth === 0 || entries >= maxTreeEntries) return;

        try {
          const items = await readdir(currentPath, { withFileTypes: true });

          for (const item of items) {
            if (entries >= maxTreeEntries) return;

            // Check ignore patterns
            if (parsed.ignore.some((pattern) => item.name.includes(pattern))) {
              continue;
            }

            const fullPath = join(currentPath, item.name);
            const indent = '  '.repeat(parsed.depth - currentDepth);
            const icon = item.isDirectory() ? '📁' : '📄';

            lines.push(`${indent}${icon} ${item.name}`);
            entries++;

            if (item.isDirectory() && currentDepth > 1) {
              await traverse(fullPath, currentDepth - 1);
            }
          }
        } catch (e) {
          logger.warn({ path: currentPath, error: String(e) }, 'Failed to read directory');
        }
      };

      await traverse(resolvedPath, parsed.depth);

      const output = `${lines.join('\n')}\n\nTotal entries: ${entries}`;
      const truncated = truncateOutput(output, maxOutputBytes);

      return {
        content: [{ type: 'text', text: truncated }],
      };
    }
  );
}
