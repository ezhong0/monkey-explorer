#!/usr/bin/env -S npx tsx
// monkey-explorer CLI entry. Argv parser → subcommand dispatcher.
//
// Subcommands:
//   monkey login                            global credential setup
//   monkey target <add|list|use|rm|show>    manage named targets
//   monkey configure                        edit defaults (models, caps)
//   monkey bootstrap-auth [--target <name>] refresh BB context cookie
//   monkey list [--since <h|d>]             show active + recent runs
//   monkey ["mission" ...]                  run missions against current target
//   monkey --help / monkey --version

import mri from 'mri';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Argv {
  _: string[];
  // Universal
  target?: string;
  since?: string;
  'dry-run'?: boolean;
  help?: boolean;
  version?: boolean;
  json?: boolean;
  'non-interactive'?: boolean;
  // login flags
  'browserbase-key'?: string;
  'openai-key'?: string;
  'bb-project'?: string;
  'anthropic-key'?: string;
  // target add flags
  url?: string;
  'auth-mode'?: string;
  'sign-in-url'?: string;
  'test-email'?: string;
  'test-password'?: string;
  'custom-path'?: string;
  'no-bootstrap'?: boolean;
}

function parseArgs(argv: string[]): Argv {
  return mri(argv, {
    string: [
      'target',
      'since',
      'browserbase-key',
      'openai-key',
      'bb-project',
      'anthropic-key',
      'url',
      'auth-mode',
      'sign-in-url',
      'test-email',
      'test-password',
      'custom-path',
    ],
    boolean: ['dry-run', 'help', 'version', 'json', 'non-interactive', 'no-bootstrap'],
    alias: { h: 'help', v: 'version' },
  }) as Argv;
}

const HELP_TEXT = `monkey-explorer — AI-agent-driven exploratory testing for any web app.

Usage:
  monkey [--target <name>] "<mission>" ["<mission>" ...]
  monkey [subcommand] [flags]

Subcommands:
  login                Set BB + OpenAI credentials (per-machine, once).
                         Flags: --browserbase-key, --openai-key, --bb-project,
                         --anthropic-key (all-or-nothing for non-interactive).
  target add <name>    Add a named target (URL, auth, test creds).
                         Flags: --url, --auth-mode, --sign-in-url, --test-email,
                         --test-password, --custom-path, --no-bootstrap.
  target list          Show all targets, * marks current.
  target use <name>    Switch the current target.
  target rm <name>     Delete a target.
  target show [name]   Show target details (secrets redacted).
  configure            Edit defaults (models, caps).
  bootstrap-auth       Refresh the BB context cookie.
                         Flags: --target <name> (default: current target).
  list                 Show active + recent runs across all targets.
                         Flags: --target <name>, --since <duration> (1h/7d/30m).

Run flags:
  --target <name>      Run against a specific named target (default: current).
  --json               Emit final aggregate JSON to stdout (for scripts/agents).
                       Streaming progress still goes to stderr.
  --non-interactive    Error instead of prompting (CI/agents).
  --dry-run            Print plan without spawning sessions.
  --help, -h           This message.
  --version, -v        Print framework version.

Examples:
  monkey login
  monkey target add tamarind-staging
  monkey "test the dashboard"
  monkey "test A" "test B" "test C"           # 3 missions in parallel
  monkey --target prod "test signup"
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

  try {
    switch (subcommand) {
      case 'login': {
        const { runLogin } = await import('./commands/login.js');
        return runLogin({
          browserbaseKey: args['browserbase-key'],
          openaiKey: args['openai-key'],
          bbProject: args['bb-project'],
          anthropicKey: args['anthropic-key'],
        });
      }
      case 'target': {
        const { runTargetDispatch } = await import('./commands/target/index.js');
        return runTargetDispatch({
          positional: args._.slice(1),
          addFlags: {
            url: args.url,
            authMode: args['auth-mode'],
            signInUrl: args['sign-in-url'],
            testEmail: args['test-email'],
            testPassword: args['test-password'],
            customPath: args['custom-path'],
            noBootstrap: args['no-bootstrap'],
          },
        });
      }
      case 'configure': {
        const { runConfigure } = await import('./commands/configure.js');
        return runConfigure();
      }
      case 'bootstrap-auth': {
        const { runBootstrapAuth } = await import('./commands/bootstrap-auth.js');
        return runBootstrapAuth({ targetName: args.target });
      }
      case 'list': {
        const { runList } = await import('./commands/list.js');
        return runList({ targetFilter: args.target, since: args.since });
      }
      default: {
        // Bare invocation OR mission(s) as positional args
        const positionalMissions = args._.filter((s) => s.length > 0);
        const { runRun } = await import('./commands/run.js');
        return runRun({
          targetName: args.target,
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
