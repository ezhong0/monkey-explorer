// Loads .env.local from the project directory and parses into typed Env.
//
// Cross-validates against the loaded MonkeyConfig: ai-form auth requires
// TEST_EMAIL + TEST_PASSWORD; other modes don't.

import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { MonkeyConfig } from '../config/schema.js';

export const EnvSchema = z.object({
  BROWSERBASE_API_KEY: z.string().min(1),
  BROWSERBASE_PROJECT_ID: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  TEST_EMAIL: z.string().email().optional(),
  TEST_PASSWORD: z.string().min(1).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(projectDir: string): Env {
  const envPath = join(projectDir, '.env.local');
  if (!existsSync(envPath)) {
    throw new Error(
      `.env.local not found in ${projectDir}.\n` +
        `Run \`monkey init\` to set up the project, or \`monkey configure\` to fix credentials.`,
    );
  }
  // Load with override:false so ambient process.env wins (useful for CI/tests).
  dotenvConfig({ path: envPath, override: false });

  const parsed = EnvSchema.safeParse({
    BROWSERBASE_API_KEY: process.env.BROWSERBASE_API_KEY,
    BROWSERBASE_PROJECT_ID: process.env.BROWSERBASE_PROJECT_ID,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    TEST_EMAIL: process.env.TEST_EMAIL,
    TEST_PASSWORD: process.env.TEST_PASSWORD,
  });
  if (!parsed.success) {
    const lines = parsed.error.errors.map((e) => `  - ${e.path.join('.')}: ${e.message}`);
    throw new Error(
      [`.env.local missing required fields:`, ...lines, '', 'Run `monkey configure` to fix.'].join(
        '\n',
      ),
    );
  }
  return parsed.data;
}

export function validateEnvForConfig(env: Env, config: MonkeyConfig): void {
  if (config.authMode.kind === 'ai-form') {
    if (!env.TEST_EMAIL || !env.TEST_PASSWORD) {
      throw new Error(
        `Auth mode is "ai-form" but TEST_EMAIL or TEST_PASSWORD is missing in .env.local.\n` +
          `Run \`monkey configure\` to set them.`,
      );
    }
  }
}
