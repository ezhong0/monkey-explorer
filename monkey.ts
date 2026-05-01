#!/usr/bin/env -S npx tsx
// monkey-explorer CLI entry. Argv parser → subcommand dispatcher.
//
// Subcommands:
//   monkey init                            interactive setup
//   monkey configure                       re-prompt fields
//   monkey bootstrap-auth                  refresh BB context cookie
//   monkey list [--since <h|d>]            show active + recent runs
//   monkey ["mission" "mission" ...]       run missions
//   monkey --help / monkey --version

import mri from 'mri';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Argv {
  _: string[];
  target?: string;
  since?: string;
  'dry-run'?: boolean;
  help?: boolean;
  version?: boolean;
  json?: boolean;
  'non-interactive'?: boolean;
}

function parseArgs(argv: string[]): Argv {
  return mri(argv, {
    string: ['target', 'since'],
    boolean: ['dry-run', 'help', 'version', 'json', 'non-interactive'],
    alias: { h: 'help', v: 'version' },
  }) as Argv;
}

const HELP_TEXT = `monkey-explorer — AI-agent-driven exploratory testing for any web app.

Usage:
  monkey [--target <url>] "<mission>" ["<mission>" ...]
  monkey [subcommand] [flags]

Subcommands:
  init                Interactive setup. Writes monkey.config.json + .env.local.
  configure           Re-prompt every field with current values as defaults.
  bootstrap-auth      Refresh the Browserbase context's cookie.
  list                Show active + recent runs from ./reports/.
                        --since <duration>   default 24h, accepts 1h / 7d / 30m

Run flags:
  --target <url>      Target app URL (or prompted from .last-target default).
  --json              Emit final aggregate JSON to stdout (for scripting / agents).
                      Streaming progress still goes to stderr.
  --non-interactive   Error instead of prompting (for CI / agents). Aliases: -y avoidance.
  --dry-run           Print plan without spawning sessions.
  --help, -h          This message (or per-subcommand with \`monkey <cmd> --help\`).
  --version, -v       Print framework version.

Examples:
  monkey init
  monkey --target https://staging.my-app.com "test the dashboard"
  monkey "test A" "test B" "test C"           # 3 missions in parallel
  monkey list
  monkey list --since 7d
`;

async function readVersion(): Promise<string> {
  const pj = join(__dirname, 'package.json');
  if (!existsSync(pj)) return 'unknown';
  try {
    const text = await readFile(pj, 'utf-8');
    return JSON.parse(text).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.version) {
    process.stdout.write(`${await readVersion()}\n`);
    return 0;
  }

  if (args.help && args._.length === 0) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const subcommand = args._[0];
  const projectDir = resolve(process.cwd());

  // Friendly first-run error: if subcommand requires monkey.config.json
  // and it's missing, point to `monkey init`.
  const requiresConfig = ['configure', 'bootstrap-auth', 'list'].includes(subcommand) ||
    !subcommand ||
    (subcommand && !['init', 'configure', 'bootstrap-auth', 'list'].includes(subcommand));
  if (requiresConfig && subcommand !== 'init' && !existsSync(join(projectDir, 'monkey.config.json'))) {
    process.stderr.write(
      '✗ No monkey config in this directory.\n' +
        '  Run `monkey init` to set up a new project, or cd to one that has one.\n',
    );
    return 1;
  }

  try {
    switch (subcommand) {
      case 'init': {
        const { runInit } = await import('./commands/init.js');
        return runInit(projectDir);
      }
      case 'configure': {
        const { runConfigure } = await import('./commands/configure.js');
        return runConfigure(projectDir);
      }
      case 'bootstrap-auth': {
        const { runBootstrapAuth } = await import('./commands/bootstrap-auth.js');
        return runBootstrapAuth({ projectDir });
      }
      case 'list': {
        const { runList } = await import('./commands/list.js');
        return runList({ projectDir, since: args.since });
      }
      default: {
        // Bare invocation OR mission(s) as positional args
        const positionalMissions = args._.filter((s) => s.length > 0);
        const { runRun } = await import('./commands/run.js');
        return runRun({
          projectDir,
          target: args.target,
          positionalMissions,
          dryRun: Boolean(args['dry-run']),
          json: Boolean(args.json),
          nonInteractive: Boolean(args['non-interactive']),
        });
      }
    }
  } catch (err) {
    process.stderr.write(`\n✗ ${(err as Error).message}\n`);
    if (process.env.MONKEY_DEBUG) {
      process.stderr.write(`${(err as Error).stack ?? ''}\n`);
    }
    return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`\n✗ ${err?.message ?? err}\n`);
    process.exit(1);
  });
