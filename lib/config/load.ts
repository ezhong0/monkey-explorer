// Reads and validates monkey.config.json from the project directory (cwd).
// Schema-validates via Zod; throws helpful errors on parse failure.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { MonkeyConfigSchema, type MonkeyConfig } from './schema.js';

export interface LoadedConfig {
  config: MonkeyConfig;
  configPath: string;
  configDir: string;
}

export async function loadConfig(projectDir: string): Promise<LoadedConfig> {
  const configPath = join(projectDir, 'monkey.config.json');
  if (!existsSync(configPath)) {
    throw new ConfigNotFoundError(projectDir);
  }
  let raw: unknown;
  try {
    const text = await readFile(configPath, 'utf-8');
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse ${configPath}: ${(err as Error).message}\n` +
        `If the file is corrupted, run \`monkey init\` in a clean directory or restore from backup.`,
    );
  }
  try {
    const config = MonkeyConfigSchema.parse(raw);
    return { config, configPath, configDir: projectDir };
  } catch (err) {
    if (err instanceof ZodError) {
      const lines = err.errors.map((e) => `  - ${e.path.join('.')}: ${e.message}`);
      throw new Error(
        [
          `${configPath} failed schema validation:`,
          ...lines,
          '',
          'Fix the offending field(s) or run `monkey configure` to re-prompt.',
        ].join('\n'),
      );
    }
    throw err;
  }
}

export class ConfigNotFoundError extends Error {
  constructor(public readonly projectDir: string) {
    super(
      `No monkey config in this directory.\n` +
        `  Run \`monkey init\` to set up a new project, or cd to one that has one.\n` +
        `  (Looked for: ${join(projectDir, 'monkey.config.json')})`,
    );
    this.name = 'ConfigNotFoundError';
  }
}
