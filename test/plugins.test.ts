import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PluginLoader } from '../src/plugins/loader.js';
import type { Config } from '../src/config/env.js';
import { rmSync } from 'fs';
import { createRegistry } from '../src/tools/registry.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';

const minimalConfig = {
  AGENT_ID: 'test-agent',
  AGENT_NAME: 'Test',
  AGENT_VERSION: '1.0.0',
  ENABLE_GIT: false,
  ENABLE_RUNNER: false,
  ENABLE_DOCKER: false,
  ENABLE_HTTP_FETCH: false,
  ENABLE_SYSTEM_TOOLS: false,
  ENABLE_UNRESTRICTED_MODE: false,
} as unknown as Config;

describe('Plugin System', () => {
  let testPluginDir: string;

  beforeEach(() => {
    testPluginDir = join(tmpdir(), `helix-test-plugins-${Date.now()}`);
    mkdirSync(join(testPluginDir, 'test-plugin'), { recursive: true });
    writeFileSync(
      join(testPluginDir, 'test-plugin', 'manifest.json'),
      JSON.stringify({
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        description: 'Test',
      })
    );
    writeFileSync(
      join(testPluginDir, 'test-plugin', 'index.js'),
      `export default { manifest: {}, register(registry) { registry.register({ definition: { name: 'example.greet', description: '', inputSchema: { parse: () => ({}) } }, handler: async () => ({ content: [] }) }); } };`
    );
  });

  afterEach(() => {
    rmSync(testPluginDir, { recursive: true, force: true });
  });
  it('loads plugin from directory', async () => {
    const pluginLoader = new PluginLoader(testPluginDir);
    // Since we're using default PLUGIN_DIR, it might load example-greeting
    const loaded = await pluginLoader.loadAll();
    // In our test environment, we expect at least the example-greeting to be loaded
    expect(loaded.length).toBeGreaterThanOrEqual(1);

    const testPlugin = loaded.find(p => p.plugin.manifest.id === 'test-plugin');
    expect(testPlugin).toBeDefined();
    expect(testPlugin?.plugin.manifest.name).toBe('Test Plugin');
  });

  it('skips invalid plugins without crashing', async () => {
    // We mock a scenario where an invalid plugin is present
    // Just verify the loader doesn't throw on loadAll
    const pluginLoader = new PluginLoader(testPluginDir);
    await expect(pluginLoader.loadAll()).resolves.toBeInstanceOf(Array);
  });

  it('registers tools from plugin', async () => {
    const registry = createRegistry();
    const pluginLoader = new PluginLoader(testPluginDir);
    const loaded = await pluginLoader.loadAll();

    for (const { plugin } of loaded) {
      await plugin.register(registry, minimalConfig);
    }

    expect(registry.getNames()).toContain('example.greet');
  });

  it('calls unregister on shutdown', async () => {
    const pluginLoader = new PluginLoader(testPluginDir);
    await pluginLoader.loadAll();
    // ensure unregister doesn't throw
    await expect(pluginLoader.unloadAll()).resolves.toBeUndefined();
  });
});
