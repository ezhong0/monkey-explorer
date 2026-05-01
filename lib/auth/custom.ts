// "custom" auth mode — user provides a JS/TS file exporting a default
// signIn function. The framework dynamically imports it.
//
// Security gate (Red Team finding S1):
// - Path-traversal block: customSignInPath must resolve within the config
//   dir (no `..` escaping outside)
// - First-use SHA-256 hash confirmation (persisted in `.trusted-signin`);
//   re-prompt on hash change
// - Friendly error wrapping for import failures
//
// The hash-pin defends against the realistic attack: a teammate clones
// a malicious template repo with `customSignInPath` pointing at a JS
// file that exfiltrates `.env.local`. The first-use prompt + hash
// commit makes that visible.

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { confirm } from '@inquirer/prompts';
import type { Page } from 'playwright-core';
import type { SignInFn } from '../types.js';
import * as log from '../log/stderr.js';

const TRUSTED_FILE = '.trusted-signin';

export class CustomSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomSignInError';
  }
}

export function resolveCustomSignInPath(rawPath: string, configDir: string): string {
  const resolved = isAbsolute(rawPath) ? rawPath : resolve(configDir, rawPath);
  // Path traversal block: must resolve within configDir.
  const rel = relative(configDir, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new CustomSignInError(
      `customSignInPath ${rawPath} resolves outside the project directory (${resolved}).\n` +
        `For security, custom signIn files must live inside the project directory.`,
    );
  }
  return resolved;
}

async function sha256OfFile(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

async function readTrustedHashes(configDir: string): Promise<Set<string>> {
  const p = join(configDir, TRUSTED_FILE);
  if (!existsSync(p)) return new Set();
  const text = await readFile(p, 'utf-8');
  return new Set(text.split('\n').map((l) => l.trim()).filter(Boolean));
}

async function persistTrustedHash(configDir: string, hash: string): Promise<void> {
  const p = join(configDir, TRUSTED_FILE);
  const existing = existsSync(p) ? await readFile(p, 'utf-8') : '';
  await writeFile(p, existing.replace(/\n*$/, '\n') + hash + '\n');
}

export async function customSignIn(opts: {
  page: Page;
  signInUrl: string;
  email: string | undefined;
  password: string | undefined;
  configDir: string;
  customSignInPath: string;
  signal: AbortSignal;
}): Promise<void> {
  const fullPath = resolveCustomSignInPath(opts.customSignInPath, opts.configDir);

  if (!existsSync(fullPath)) {
    throw new CustomSignInError(
      `Custom signIn file not found: ${fullPath}\n` +
        `Check customSignInPath in monkey.config.json.`,
    );
  }

  const hash = await sha256OfFile(fullPath);
  const trusted = await readTrustedHashes(opts.configDir);

  if (!trusted.has(hash)) {
    log.blank();
    log.warn('Custom signIn file requires confirmation:');
    log.info(`  Path:     ${fullPath}`);
    log.info(`  SHA-256:  ${hash}`);
    log.info('');
    log.info('  This file will be executed with full Node privileges.');
    log.info('  It will have access to your environment variables and network.');
    log.blank();

    const accepted = await confirm({
      message: 'Trust this file and run it?',
      default: false,
    });
    if (!accepted) {
      throw new CustomSignInError('Custom signIn not trusted; aborting.');
    }
    await persistTrustedHash(opts.configDir, hash);
    log.ok('Trusted hash persisted to .trusted-signin');
    log.blank();
  }

  // Dynamic import with error wrapping.
  let mod: { default?: unknown };
  try {
    mod = await import(pathToFileURL(fullPath).href);
  } catch (err) {
    throw new CustomSignInError(
      `Failed to load custom signIn from ${fullPath}: ${(err as Error).message}\n` +
        `Verify the file exports a default async function.`,
    );
  }

  const fn = mod.default;
  if (typeof fn !== 'function') {
    throw new CustomSignInError(
      `${fullPath} must export a default function (got ${typeof fn}).`,
    );
  }

  await (fn as SignInFn)({
    page: opts.page,
    signInUrl: opts.signInUrl,
    email: opts.email,
    password: opts.password,
    signal: opts.signal,
  });
}
