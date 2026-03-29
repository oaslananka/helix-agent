import { PathTraversalError, PolicyDeniedError, OutputLimitExceededError } from '../errors/index.js';
import { realpathSync } from 'fs';
import { relative, resolve, normalize, sep } from 'path';
import { logger } from './logger.js';

export interface PathPolicy {
  allowedRoots: string[];
  maxFileBytes: number;
  maxOutputBytes: number;
  redactionPatterns: RegExp[];
}

/**
 * Resolve a path against allowed roots.
 * Returns the resolved path if valid, throws if traversal attempted.
 */
export function resolvePath(
  path: string,
  allowedRoots: string[],
  maxPathDepth: number = 100
): string {
  if (!path) {
    throw new PolicyDeniedError('Path cannot be empty');
  }

  // Detect obvious traversal attempts
  if (path.includes('..')) {
    throw new PathTraversalError(path);
  }

  // Normalize the path
  const normalized = normalize(path);

  // Check if it has suspicious patterns
  if (normalized.includes('..')) {
    throw new PathTraversalError(path);
  }

  let resolvedPath: string | undefined;
  let foundRoot: string | null = null;

  // Try to resolve against each allowed root
  for (const root of allowedRoots) {
    try {
      const realRoot = realpathSync(root);
      const candidate = resolve(realRoot, normalized);
      const realCandidate = realpathSync(candidate);

      // Ensure resolved path is within allowed root on both POSIX and Windows.
      const relativeToRoot = relative(realRoot, realCandidate);
      const withinRoot =
        relativeToRoot === '' ||
        (!relativeToRoot.startsWith('..') && !relativeToRoot.includes(`..${sep}`));

      if (withinRoot) {
        resolvedPath = realCandidate;
        foundRoot = realRoot;
        break;
      }
    } catch (e) {
      // Root doesn't exist or realpath fails; continue to next
      continue;
    }
  }

  if (!resolvedPath) {
    throw new PolicyDeniedError(`Path ${path} could not be resolved within allowed roots: ${allowedRoots.join(', ')}`);
  }

  logger.debug({ path: normalized, resolved: resolvedPath, root: foundRoot }, 'Path resolved');

  return resolvedPath;
}

/**
 * Truncate text output to max bytes, respecting UTF-8 boundaries.
 */
export function truncateOutput(text: string, maxBytes: number): string {
  if (!text) return text;

  const buffer = Buffer.from(text, 'utf-8');
  if (buffer.length <= maxBytes) {
    return text;
  }

  // Truncate and try to decode safely
  const truncated = buffer.subarray(0, maxBytes).toString('utf-8');
  // Replace invalid UTF-8 sequences if needed (toString handles it)
  return truncated.replace(/\ufffd+$/, '') + '\n...(truncated)';
}

/**
 * Apply redaction patterns to a string.
 */
export function redactSensitive(text: string, patterns: RegExp[]): string {
  let result = text;
  for (const pattern of patterns) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

/**
 * Validate file size before reading.
 */
export function validateFileSize(bytes: number, maxBytes: number): void {
  if (bytes > maxBytes) {
    throw new OutputLimitExceededError(bytes, maxBytes);
  }
}
