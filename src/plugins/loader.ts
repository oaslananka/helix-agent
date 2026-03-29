import { readdir, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from '../security/logger.js';
import { PluginManifestSchema, type HelixPlugin, type PluginLoadResult } from './types.js';
import { PluginLoadError } from '../errors/index.js';

export class PluginLoader {
  private loaded: PluginLoadResult[] = [];
  private readonly pluginDir: string;

  constructor(pluginDir?: string) {
    this.pluginDir = pluginDir ?? resolve(process.cwd(), 'plugins');
  }

  async loadAll(): Promise<PluginLoadResult[]> {
    // Check if plugins directory exists
    try {
      await access(this.pluginDir);
    } catch {
      logger.info('No plugins directory found, skipping plugin loading');
      return [];
    }

    const entries = await readdir(this.pluginDir, { withFileTypes: true });
    const pluginDirs = entries.filter((e) => e.isDirectory());

    for (const dir of pluginDirs) {
      const pluginPath = join(this.pluginDir, dir.name);
      try {
        const result = await this.loadOne(pluginPath);
        this.loaded.push(result);
        logger.info({ plugin: result.plugin.manifest.id }, 'Plugin loaded');
      } catch (err) {
        logger.error({ err, pluginPath }, 'Failed to load plugin, skipping');
        // Don't fail the entire agent if one plugin fails
      }
    }

    return this.loaded;
  }

  private async loadOne(pluginPath: string): Promise<PluginLoadResult> {
    // 1. Read and validate manifest
    const manifestPath = join(pluginPath, 'manifest.json');
    let manifestRaw: unknown;
    try {
      const content = await readFile(manifestPath, 'utf-8');
      manifestRaw = JSON.parse(content);
    } catch (cause) {
      throw new PluginLoadError(pluginPath, `Cannot read manifest.json: ${cause}`);
    }

    const manifestResult = PluginManifestSchema.safeParse(manifestRaw);
    if (!manifestResult.success) {
      throw new PluginLoadError(
        pluginPath,
        `Invalid manifest: ${manifestResult.error.message}`
      );
    }

    // 2. Load the plugin module
    const indexPath = join(pluginPath, 'index.js');
    let pluginModule: unknown;
    try {
      pluginModule = await import(pathToFileURL(indexPath).href);
    } catch (cause) {
      throw new PluginLoadError(pluginPath, cause);
    }

    // 3. Validate plugin exports
    const plugin = (pluginModule as { default?: HelixPlugin }).default;
    if (!plugin || typeof plugin.register !== 'function') {
      throw new PluginLoadError(
        pluginPath,
        'Plugin must export a default object with a register() function'
      );
    }

    return {
      plugin: { ...plugin, manifest: manifestResult.data },
      path: pluginPath,
      loadedAt: new Date(),
    };
  }

  async unloadAll(): Promise<void> {
    for (const { plugin } of this.loaded) {
      if (plugin.unregister) {
        try {
          await plugin.unregister();
        } catch (err) {
          logger.error({ err, plugin: plugin.manifest.id }, 'Plugin unload failed');
        }
      }
    }
  }

  getLoaded(): PluginLoadResult[] {
    return [...this.loaded];
  }
}
