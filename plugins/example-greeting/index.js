import { z } from 'zod';

const plugin = {
  manifest: {},
  register(registry, config) {
    registry.register({
      definition: {
        name: 'example.greet',
        description: 'Returns a greeting message (plugin system demo)',
        inputSchema: z.object({
          name: z.string().describe('Name to greet'),
        }),
      },
      handler: async ({ name }) => ({
        content: [{ type: 'text', text: `Hello, ${name}! This tool was loaded via the plugin system.` }],
      }),
    });
  },
};

export default plugin;
