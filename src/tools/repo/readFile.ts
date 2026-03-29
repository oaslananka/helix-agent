import { ToolValidationError } from '../../errors/index.js';
import { z } from 'zod';
import { readFile, stat } from 'fs/promises';
import { createTool } from '../types.js';
import { resolvePath, truncateOutput, validateFileSize } from '../../security/pathPolicy.js';
import { logger } from '../../security/logger.js';

const ReadFileArgsSchema = z.object({
  path: z.string(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});

export function createReadFileTool(
  allowedRoots: string[],
  maxOutputBytes: number,
  maxFileBytes: number
) {
  return createTool(
    'repo.read_file',
    `📝 READ FILE CONTENTS

Read file contents with optional line range - inspect code and configs.

WHEN TO USE:
• Read source code for analysis
• Inspect configuration files
• Review specific functions/classes
• Extract documentation

PARAMETERS:
• path: File path (relative to repo root)
• startLine: First line to read (optional, 1-indexed)
• endLine: Last line to read (optional, inclusive)

EXAMPLES:
1. Read entire file:
   {"path": "src/index.ts"}

2. Read specific function (lines 45-80):
   {"path": "src/utils.ts", "startLine": 45, "endLine": 80}

3. Read file header (first 20 lines):
   {"path": "README.md", "startLine": 1, "endLine": 20}

4. Read from line to end:
   {"path": "package.json", "startLine": 10}

BEST PRACTICES:
• Use line ranges for large files
• Combine with repo.search_rg to find then read
• Read config files entirely (package.json, tsconfig.json)
• For specific sections, use search first to find line numbers

FILE SIZE LIMITS:
• Max file size: configured limit (typically 2MB)
• Output truncated if exceeds limit
• Use line ranges for very large files

SUPPORTED FILE TYPES:
• Text files: .ts, .js, .py, .md, .json, .yml, .txt
• Config files: .env, .config, .rc
• Any UTF-8 text file`,
    ReadFileArgsSchema,
    async (args) => {
      const parsed = ReadFileArgsSchema.parse(args);
      const resolvedPath = resolvePath(parsed.path, allowedRoots);

      try {
        const stats = await stat(resolvedPath);

        if (!stats.isFile()) {
          throw new ToolValidationError('repo.read_file', ['Path is not a file']);
        }

        validateFileSize(stats.size, maxFileBytes);

        let content = await readFile(resolvedPath, 'utf-8');

        // Handle line range if specified
        if (parsed.startLine || parsed.endLine) {
          const lines = content.split('\n');
          const start = (parsed.startLine || 1) - 1;
          const end = parsed.endLine || lines.length;
          content = lines.slice(start, end).join('\n');
        }

        // Detect binary files (rough heuristic)
        if (content.includes('\0')) {
          return {
            content: [
              {
                type: 'text',
                text: '[Binary file detected]',
              },
            ],
          };
        }

        const truncated = truncateOutput(content, maxOutputBytes);

        return {
          content: [{ type: 'text', text: truncated }],
        };
      } catch (e) {
        logger.warn({ path: resolvedPath, error: String(e) }, 'Failed to read file');
        throw e;
      }
    }
  );
}
