// "custom" auth mode — user provides a JS/TS file exporting a default
// signIn function. The framework dynamically imports it.
//
// Security gate:
// - First-use SHA-256 hash confirmation (persisted in
//   ~/.config/monkey-explorer/.trusted-signin); re-prompt on hash change
// - Friendly error wrapping for import failures
//
// The hash-pin defends against a teammate cloning a malicious template that
// references a custom signIn file. The first-use prompt + hash commit makes
// that visible.
//
// Path-traversal block was removed in the global-state refactor: paths are
// resolved to absolute at `monkey target add` time (no template-config
// scenario), so the previous within-configDir constraint no longer applies.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { confirm } from '@inquirer/prompts';
import type { Page } from 'playwright-core';
import type { SignInFn } from '../types.js';
import * as log from '../log/stderr.js';
import { getBaseDir } from '../state/path.js';

const TRUSTED_FILENAME = '.trusted-signin';

export class CustomSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomSignInError';
  }
}

function getTrustedFilePath(): string {
  return join(getBaseDir(), TRUSTED_FILENAME);
}

async function sha256OfFile(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

async function readTrustedHashes(): Promise<Set<string>> {
  const p = getTrustedFilePath();
  if (!existsSync(p)) return new Set();
  const text = await readFile(p, 'utf-8');
  return new Set(text.split('\n').map((l) => l.trim()).filter(Boolean));
}

async function persistTrustedHash(hash: string): Promise<void> {
  const p = getTrustedFilePath();
  await mkdir(dirname(p), { recursive: true });
  const existing = existsSync(p) ? await readFile(p, 'utf-8') : '';
  await writeFile(p, existing.replace(/\n*$/, '\n') + hash + '\n');
}

export async function customSignIn(opts: {
  page: Page;
  signInUrl: string;
  email: string | undefined;
  password: string | undefined;
  customSignInPath: string;
  signal: AbortSignal;
}): Promise<void> {
  // customSignInPath is stored absolute by `target add`; no resolution needed.
  const fullPath = opts.customSignInPath;

  if (!existsSync(fullPath)) {
    throw new CustomSignInError(
      `Custom signIn file not found: ${fullPath}\n` +
        `The path was set when this target was added; run \`monkey target rm <name>\` ` +
        `and \`monkey target add <name>\` again to update it.`,
    );
  }

  const hash = await sha256OfFile(fullPath);
  const trusted = await readTrustedHashes();

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
    await persistTrustedHash(hash);
    log.ok(`Trusted hash persisted to ${getTrustedFilePath()}`);
    log.blank();
  }

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
