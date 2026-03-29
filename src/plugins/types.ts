import { z } from 'zod';
import type { ToolRegistry } from '../tools/registry.js';
import type { Config } from '../config/env.js';

export const PluginManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'Plugin ID must be lowercase alphanumeric with hyphens'),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  author: z.string().optional(),
  requires: z.object({
    agentVersion: z.string().optional(), // semver range
    permissions: z.array(
      z.enum(['fs', 'exec', 'network', 'docker', 'k8s', 'database'])
    ).optional(),
  }).optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export interface HelixPlugin {
  manifest: PluginManifest;
  /**
   * Called when the plugin is loaded. Register your tools here.
   * @param registry - Tool registry to register tools into
   * @param config - Agent configuration
   */
  register(registry: ToolRegistry, config: Config): Promise<void> | void;
  /**
   * Called on graceful shutdown. Clean up resources.
   */
  unregister?(): Promise<void> | void;
}

export interface PluginLoadResult {
  plugin: HelixPlugin;
  path: string;
  loadedAt: Date;
}
