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
  current              Print the current target (name, URL, auth, status).
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
  monkey target add staging
  monkey "test the dashboard"
  monkey "test A" "test B" "test C"           # 3 missions in parallel
  monkey --target prod "test signup"
  monkey list
  monkey list --since 7d

Per-subcommand help: \`monkey <subcommand> --help\`
`;

// ─── Per-subcommand help ─────────────────────────────────────────────────────
//
// Keyed by subcommand. For `target <sub>`, key is `target:<sub>`.

const SUBCOMMAND_HELP: Record<string, string> = {
  login: `monkey login — set Browserbase + OpenAI credentials globally.

Usage:
  monkey login                       Interactive — prompts for each field
  monkey login --browserbase-key <k> --openai-key <k> [...]
                                     Non-interactive (CI / agents)

Required flags for non-interactive:
  --browserbase-key <k>     Browserbase API key (starts with bb_)
  --openai-key <k>          OpenAI API key (starts with sk-)

Optional flags:
  --bb-project <id>         BB project ID (auto-discovered if you have one project)
  --anthropic-key <k>       Anthropic API key (only needed for Claude models)

Partial flags are rejected — pass all required, or none (then prompts run).
Stored at ~/.config/monkey-explorer/config.json (mode 0600).

If credentials already exist, current values become the prompt defaults.
`,

  target: `monkey target <add|list|use|rm|show> — manage named targets.

A target is one app you want to test. Each holds: URL, auth mode, test
credentials, and a Browserbase context handle. Stored under
~/.config/monkey-explorer/config.json (no project directory needed).

Subcommands:
  monkey target add <name>     Register a new target (interactive or via flags)
  monkey target list           List all targets, * marks current
  monkey target use <name>     Switch the current target
  monkey target rm <name>      Delete a target
  monkey target show [<name>]  Show target details (secrets redacted)

For details on each: \`monkey target <subcommand> --help\`.
`,

  'target:add': `monkey target add <name> — register a new target.

Usage:
  monkey target add <name>            Interactive — prompts for each field
  monkey target add <name> \\
    --url <url> --auth-mode <kind> [...]
                                      Non-interactive (CI / agents)

Required flags for non-interactive:
  --url <app-url>           The app to test (e.g., https://app.example.com)
  --auth-mode <kind>        ai-form | interactive | none | custom

Auth-mode-specific flags:
  ai-form        Requires --sign-in-url, --test-email, --test-password
  interactive    Requires --sign-in-url
  none           No further flags
  custom         Requires --custom-path (resolved to absolute at this step)

Other flags:
  --no-bootstrap            Skip the auto bootstrap-auth at the end. Run
                            \`monkey bootstrap-auth --target <name>\` later.

The first added target also becomes the current target. Auto-runs
bootstrap-auth at the end unless --no-bootstrap or auth-mode is "none".
Partial flags are rejected — pass all required, or none.
`,

  'target:list': `monkey target list — list all named targets.

Usage:
  monkey target list

Shows each target's name, URL, auth mode, and bootstrap status. The
current target is marked with *. Run \`monkey target use <name>\` to
switch.
`,

  'target:use': `monkey target use <name> — switch the current target.

Usage:
  monkey target use <name>

Subsequent \`monkey "<mission>"\` runs go against this target until you
switch again or pass --target <other> to override for one invocation.
`,

  'target:rm': `monkey target rm <name> — delete a target.

Usage:
  monkey target rm <name>

Confirms before deleting. Reports for this target are kept on disk under
~/.config/monkey-explorer/reports/<name>/. The Browserbase context is not
explicitly deleted — it auto-expires.
`,

  'target:show': `monkey target show [<name>] — print target details.

Usage:
  monkey target show           Show current target
  monkey target show <name>    Show a specific target

Test-credentials password is redacted. Shows: URL, auth mode, sign-in URL,
test email, contextId (or "not bootstrapped"), and lastUsed timestamp.
`,

  current: `monkey current — print the current target.

Usage:
  monkey current

Prints one line: name  URL  auth-mode  status. Useful for scripts or
quick "what target am I on" checks. If no current target is set, errors
with guidance.
`,

  configure: `monkey configure — edit user-level defaults.

Usage:
  monkey configure

Prompts for: stagehandModel, agentModel, caps (wallClockMs, maxSteps,
sessionTimeoutSec). Press enter on any prompt to keep the current value.

For credential rotation: \`monkey login\`.
For target-specific changes: \`monkey target rm <name>\` then \`monkey target add <name>\`.
`,

  'bootstrap-auth': `monkey bootstrap-auth [--target <name>] — refresh BB context cookie.

Usage:
  monkey bootstrap-auth                    Use current target
  monkey bootstrap-auth --target <name>    Use specific target

Reuses the target's existing contextId if present, mints a new one if not.
Always runs the configured signIn flow — re-running refreshes a stale
cookie.

If signIn fails (e.g., test creds rotated), re-add the target with
\`monkey target rm <name>\` then \`monkey target add <name>\`.
`,

  list: `monkey list — show active + recent runs across all targets.

Usage:
  monkey list                       Past 24h, all targets
  monkey list --target <name>       Filter to one target
  monkey list --since <duration>    Custom window (e.g., 1h, 7d, 30m)

Reports live at ~/.config/monkey-explorer/reports/<target>/. In a TTY:
arrow keys + enter to drill into a report. Piped (non-TTY): static
greppable text.
`,
};

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

  // Per-subcommand --help. For `target <sub>`, key is `target:<sub>`.
  if (args.help && subcommand) {
    let key = subcommand;
    if (subcommand === 'target' && args._[1]) {
      key = `${subcommand}:${args._[1]}`;
    }
    const text = SUBCOMMAND_HELP[key];
    if (text) {
      process.stdout.write(text);
      return 0;
    }
    // Unknown subcommand — fall through to top-level help.
    process.stdout.write(HELP_TEXT);
    return 0;
  }

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
      case 'current': {
        const { runCurrent } = await import('./commands/current.js');
        return runCurrent();
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
