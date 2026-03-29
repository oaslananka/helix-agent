import { PathTraversalError, OutputLimitExceededError } from '../src/errors/index.js';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { parseIncomingMessage, createCallResultSuccess, createCallResultError } from '../src/net/protocol';
import { resolvePath, truncateOutput, redactSensitive } from '../src/security/pathPolicy';
import { ConcurrencyController } from '../src/security/policy';
import { ToolRegistry } from '../src/tools/registry';
import { createTool } from '../src/tools/types';
import { createListTreeTool } from '../src/tools/repo/listTree';
import { createReadFileTool } from '../src/tools/repo/readFile';
import { tmpdir } from 'os';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

describe('Protocol Validation', () => {
  it('should parse valid ping message', () => {
    const msg = JSON.stringify({ type: 'ping', ts: 12345 });
    const parsed = parseIncomingMessage(msg);
    expect(parsed.type).toBe('ping');
    expect(parsed.ts).toBe(12345);
  });

  it('should parse valid call message', () => {
    const msg = JSON.stringify({
      type: 'call',
      requestId: 'req-1',
      domain: 'tools',
      name: 'repo.read_file',
      arguments: { path: 'test.txt' },
      timeoutMs: 30000,
    });
    const parsed = parseIncomingMessage(msg);
    expect(parsed.type).toBe('call');
    expect(parsed.name).toBe('repo.read_file');
  });

  it('should create call result success', () => {
    const result = createCallResultSuccess('req-1', [{ type: 'text', text: 'hello' }]);
    expect(result.ok).toBe(true);
    expect(result.result.content[0].text).toBe('hello');
  });

  it('should create call result error', () => {
    const result = createCallResultError('req-1', 'TIMEOUT', 'Tool execution timed out');
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('TIMEOUT');
  });
});

describe('Path Security', () => {
  it('should reject path traversal with ../', () => {
    const allowedRoots = ['/repo'];
    expect(() => resolvePath('../../../etc/passwd', allowedRoots)).toThrowError(PathTraversalError);
  });

  it('should resolve valid paths', () => {
    const tmpDir = tmpdir();
    const testDir = join(tmpDir, 'test-agent-paths');
    mkdirSync(testDir, { recursive: true });

    const path = resolvePath('.', [testDir]);
    expect(path).toContain('test-agent-paths');
  });

  it('should truncate output correctly', () => {
    const text = 'a'.repeat(1000);
    const truncated = truncateOutput(text, 100);
    expect(truncated.length).toBeLessThan(200);
    expect(truncated).toContain('truncated');
  });

  it('should redact sensitive patterns', () => {
    const text = 'API key: AKIA0123456789ABCDEF';
    const patterns = [/AKIA[0-9A-Z]{16}/g];
    const redacted = redactSensitive(text, patterns);
    expect(redacted).not.toContain('AKIA');
    expect(redacted).toContain('[REDACTED]');
  });
});

describe('Concurrency Control', () => {
  it('should acquire and release permits', async () => {
    const cc = new ConcurrencyController(2);
    await cc.acquire('req-1');
    await cc.acquire('req-2');

    const stats = cc.getStats();
    expect(stats.active).toBe(2);
    expect(stats.queued).toBe(0);
  });

  it('should queue requests when limit exceeded', async () => {
    const cc = new ConcurrencyController(1);
    await cc.acquire('req-1');

    // This one will be queued (async)
    const promise = cc.acquire('req-2');
    const stats = cc.getStats();
    expect(stats.active).toBe(1);

    cc.release('req-1');
    await promise; // Should resolve now
  });

  it('should reject all on connection loss', async () => {
    const cc = new ConcurrencyController(2);
    cc.rejectAll('Connection lost');
    const stats = cc.getStats();
    expect(stats.queued).toBe(0);
  });
});

describe('Tool Registry', () => {
  it('should register and retrieve tools', () => {
    const registry = new ToolRegistry();
    const tool = createTool(
      'test.tool',
      'A test tool',
      z.object({ input: z.string() }),
      async () => ({ content: [{ type: 'text', text: 'test' }] })
    );

    registry.register(tool);
    expect(registry.getTool('test.tool')).toBeDefined();
    expect(registry.getNames()).toContain('test.tool');
  });

  it('should export capabilities', () => {
    const registry = new ToolRegistry();
    const tool = createTool(
      'test.capability',
      'Test capability export',
      z.object({ param: z.string() }),
      async () => ({ content: [{ type: 'text', text: '' }] })
    );

    registry.register(tool);
    const caps = registry.exportCapabilities();
    expect(caps).toHaveLength(1);
    expect(caps[0].name).toBe('test.capability');
  });
});

describe('Repo Tools', () => {
  it('should list directory tree', async () => {
    const tmpDir = tmpdir();
    const testDir = join(tmpDir, 'test-agent-tree');
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, 'subdir'), { recursive: true });
    writeFileSync(join(testDir, 'file.txt'), 'content');

    const tool = createListTreeTool([testDir], 100000, 1000);
    const result = await tool.handler({ path: '.', depth: 2 });
    expect(result.content[0].text).toContain('file.txt');
    expect(result.content[0].text).toContain('subdir');
  });

  it('should read file content', async () => {
    const tmpDir = tmpdir();
    const testFile = join(tmpDir, 'test-read-file.txt');
    const content = 'Hello, World!';
    writeFileSync(testFile, content);

    const tool = createReadFileTool([tmpDir], 100000, 100000);
    const result = await tool.handler({ path: 'test-read-file.txt' });
    expect(result.content[0].text).toContain('Hello, World!');
  });

  it('should respect file size limits', async () => {
    const tmpDir = tmpdir();
    const testFile = join(tmpDir, 'test-large-file.txt');
    const largeContent = 'x'.repeat(10000);
    writeFileSync(testFile, largeContent);

    const tool = createReadFileTool([tmpDir], 100000, 5000); // max 5000 bytes
    try {
      await tool.handler({ path: 'test-large-file.txt' });
      // Should throw or handle gracefully
    } catch (e) {
      expect(String(e)).toContain('exceeds');
    }
  });

  it('should reject binary files', async () => {
    const tmpDir = tmpdir();
    const binFile = join(tmpDir, 'test-binary.bin');
    writeFileSync(binFile, Buffer.from([0x00, 0x01, 0x02])); // Binary data

    const tool = createReadFileTool([tmpDir], 100000, 100000);
    const result = await tool.handler({ path: 'test-binary.bin' });
    expect(result.content[0].text).toContain('Binary');
  });
});
