import { writeFile, readFile, existsSync, mkdirSync } from 'fs';
import { promisify } from 'util';
import { dirname, join } from 'path';

const writeFileAsync = promisify(writeFile);
const readFileAsync = promisify(readFile);

export class RuntimeConfig {
  private configPath: string;
  private config: Record<string, string> = {};

  constructor(configPath: string = join(process.cwd(), 'logs', 'runtime.config.json')) {
    this.configPath = configPath;
  }

  async load(): Promise<void> {
    try {
      if (existsSync(this.configPath)) {
        const content = await readFileAsync(this.configPath, 'utf-8');
        this.config = JSON.parse(content);
        
        // Apply to process.env
        Object.entries(this.config).forEach(([key, value]) => {
          process.env[key] = value;
        });
        
        console.log(`Loaded ${Object.keys(this.config).length} runtime config overrides`);
      }
    } catch (e) {
      console.error('Failed to load runtime config:', e);
    }
  }

  async save(key: string, value: string): Promise<void> {
    this.config[key] = value;
    process.env[key] = value;
    
    mkdirSync(dirname(this.configPath), { recursive: true });
    await writeFileAsync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  async saveAll(updates: Record<string, string>): Promise<void> {
    Object.assign(this.config, updates);
    Object.entries(updates).forEach(([key, value]) => {
      process.env[key] = value;
    });
    
    mkdirSync(dirname(this.configPath), { recursive: true });
    await writeFileAsync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  get(key: string): string | undefined {
    return this.config[key];
  }

  getAll(): Record<string, string> {
    return { ...this.config };
  }

  async delete(key: string): Promise<void> {
    delete this.config[key];
    mkdirSync(dirname(this.configPath), { recursive: true });
    await writeFileAsync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
  }
}

export const runtimeConfig = new RuntimeConfig();
