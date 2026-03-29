import { z } from 'zod';
import { createTool } from '../types.js';
import { resolvePath, truncateOutput } from '../../security/pathPolicy.js';
import { logger } from '../../security/logger.js';
import { execa } from 'execa';

const SearchArgsSchema = z.object({
  query: z.string(),
  glob: z.string().optional(),
  caseSensitive: z.boolean().default(false),
});

export function createSearchRgTool(
  allowedRoots: string[],
  maxOutputBytes: number,
  maxSearchMatches: number
) {
  return createTool(
    'repo.search_rg',
    `🔍 SEARCH CODE (ripgrep)

Fast code search using ripgrep - find functions, classes, patterns.

WHEN TO USE:
• Find where function/class is defined
• Locate all usages of a variable
• Search for TODOs/FIXMEs
• Find specific patterns (imports, API calls)
• Discover authentication/security code

PARAMETERS:
• query: Search pattern (text or regex)
• glob: File pattern filter (e.g., "*.ts", "src/**/*.js")
• caseSensitive: Exact case match (default: false)

EXAMPLES:
1. Find function definition:
   {"query": "function authenticate"}

2. Search only TypeScript files:
   {"query": "useState", "glob": "*.ts"}

3. Case-sensitive search:
   {"query": "API_KEY", "caseSensitive": true}

4. Find imports from specific module:
   {"query": "from 'react'", "glob": "src/**/*.tsx"}

5. Find TODOs in source:
   {"query": "TODO:", "glob": "src/**"}

6. Find database queries:
   {"query": "SELECT.*FROM", "glob": "*.sql"}

BEST PRACTICES:
• Use specific queries for better results
• Combine with glob to limit scope
• Case-insensitive is usually better
• After finding, use repo.read_file to inspect

COMMON PATTERNS:
• Find class: "class ClassName"
• Find exports: "export.*function"
• Find API endpoints: "app\\.(get|post)"
• Find environment vars: "process\\.env\\."
• Find errors: "throw.*Error"

GLOB PATTERNS:
• All TypeScript: "*.ts"
• Source folder: "src/**/*"
• Specific extension: "*.{js,ts,jsx,tsx}"
• Exclude tests: Use ignore in list_tree instead

OUTPUT FORMAT:
file.ts:45:  function authenticate(user) {
file.ts:67:    if (!authenticated) return;
other.ts:12:  const auth = authenticate(currentUser);`,
    SearchArgsSchema,
    async (args) => {
      const parsed = SearchArgsSchema.parse(args);
      const resolvedPath = resolvePath(parsed.glob ? '.' : '.', allowedRoots);

      try {
        // Try ripgrep first
        const rgArgs = [
          parsed.query,
          resolvedPath,
          '--max-count',
          String(maxSearchMatches),
          '--color',
          'never',
        ];

        if (parsed.glob) {
          rgArgs.push('--glob', parsed.glob);
        }

        if (!parsed.caseSensitive) {
          rgArgs.push('-i');
        }

        try {
          const result = await execa('rg', rgArgs, {
            timeout: 30000,
            reject: false,
          });

          const output = result.stdout || '';
          const truncated = truncateOutput(output, maxOutputBytes);

          return {
            content: [
              { type: 'text' as const, text: (truncated || 'No matches found') },
            ],
          };
        } catch (rgError) {
          logger.debug(
            { error: String(rgError) },
            'ripgrep not available, falling back to text search'
          );
          // Fall back to Node search
          return fallbackSearch(parsed, allowedRoots, maxSearchMatches, maxOutputBytes);
        }
      } catch (e) {
        logger.warn({ error: String(e) }, 'Search failed');
        throw e;
      }
    }
  );
}

async function fallbackSearch(
  args: z.infer<typeof SearchArgsSchema>,
  allowedRoots: string[],
  maxMatches: number,
  maxOutputBytes: number
) {
  const { readdir, readFile } = await import('fs/promises');
  const { join } = await import('path');

  const matches: string[] = [];
  const query = args.caseSensitive ? args.query : args.query.toLowerCase();

  const searchDir = async (dir: string): Promise<void> => {
    if (matches.length >= maxMatches) return;

    try {
      const items = await readdir(dir, { withFileTypes: true });

      for (const item of items) {
        if (matches.length >= maxMatches) return;

        // Skip common ignore patterns
        if (['.git', 'node_modules', '.next', 'dist'].includes(item.name)) {
          continue;
        }

        const fullPath = join(dir, item.name);

        if (item.isDirectory()) {
          await searchDir(fullPath);
        } else if (item.isFile()) {
          try {
            const content = await readFile(fullPath, 'utf-8');
            const searchContent = args.caseSensitive ? content : content.toLowerCase();
            const lines = searchContent.split('\n');

            lines.forEach((line, idx) => {
              if (matches.length < maxMatches && line.includes(query)) {
                matches.push(`${fullPath}:${idx + 1}:${line.substring(0, 200)}`);
              }
            });
          } catch {
            // Skip files that can't be read
          }
        }
      }
    } catch (e) {
      logger.debug({ path: dir, error: String(e) }, 'Search directory failed');
    }
  };

  for (const root of allowedRoots) {
    await searchDir(root);
  }

  const output = matches.length > 0 ? matches.join('\n') : 'No matches found';
  const truncated = truncateOutput(output, maxOutputBytes);

  return {
    content: [{ type: 'text' as const, text: truncated }],
  };
}
