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
  'include-speculative'?: boolean;
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
  'cookie-jar-path'?: string;
  'skip-bootstrap'?: boolean;
  // export-cookies flags
  out?: string;
  reset?: boolean;
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
      'cookie-jar-path',
      'out',
    ],
    boolean: ['dry-run', 'help', 'version', 'json', 'include-speculative', 'non-interactive', 'skip-bootstrap', 'reset'],
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
  config               Edit defaults (models, caps).
  target add <name>    Add a named target (URL, auth, test creds).
                         --auth-mode: password | cookie-jar | none
                         password: --sign-in-url, --test-email, --test-password
                         cookie-jar: --cookie-jar-path
                         Flags: --skip-bootstrap.
  target list          Show all targets, * marks current.
  target use <name>    Switch the current target.
  target rm <name>     Delete a target.
  target show [name]   Show target details (secrets redacted).
  current              Print the current target (name, URL, auth, status).
  auth <name>          Refresh login: open Chrome, capture cookies, push to BB.
                         Flags: --url (new target), --out (override path),
                                --reset (wipe profile), --skip-bootstrap.
  runs                 Show active + recent runs across all targets.
                         Flags: --target <name>, --since <duration> (1h/7d/30m).

Run flags:
  --target <name>           Run against a specific named target (default: current).
  --json                    Emit final aggregate JSON to stdout (for scripts/agents).
                            Streaming progress still goes to stderr.
  --include-speculative     Surface speculative-tier findings in the report
                            and JSON. Off by default — verified findings only.
  --non-interactive         Error instead of prompting (CI/agents).
  --dry-run                 Print plan without spawning sessions.
  --help, -h                This message.
  --version, -v             Print framework version.

Examples:
  monkey login
  monkey target add staging
  monkey "test the dashboard"
  monkey "test A" "test B" "test C"           # 3 missions in parallel
  monkey --target prod "test signup"
  monkey runs
  monkey runs --since 7d

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
  --auth-mode <kind>        password | cookie-jar | none

Auth-mode-specific flags:
  password       Requires --sign-in-url, --test-email, --test-password.
                 Stagehand AI-fills the form. Works for Clerk, Auth0, plain HTML.
  none           No further flags. Public app, no auth.
  cookie-jar     Requires --cookie-jar-path (Playwright storageState JSON;
                 resolved to absolute; injected into BB context at bootstrap).
                 Use this for Google OAuth / SSO / MFA. Sign in once locally
                 with \`monkey export-cookies <name>\`.

Other flags:
  --skip-bootstrap            Skip the auto bootstrap-auth at the end. Run
                            \`monkey bootstrap-auth --target <name>\` later.

The first added target also becomes the current target. Auto-runs
bootstrap-auth at the end unless --skip-bootstrap or auth-mode is "none".
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
test email, contextId (BB cookie store handle, minted on first run), and
lastUsed timestamp.
`,

  current: `monkey current — print the current target.

Usage:
  monkey current

Prints one line: name  URL  auth-mode  status. Useful for scripts or
quick "what target am I on" checks. If no current target is set, errors
with guidance.
`,

  config: `monkey config — edit user-level defaults.

Usage:
  monkey config

Prompts for: stagehandModel, agentModel, caps (wallClockMs, maxSteps,
sessionTimeoutSec). Press enter on any prompt to keep the current value.

For credential rotation: \`monkey login\`.
For target-specific changes: \`monkey target rm <name>\` then \`monkey target add <name>\`.

(\`monkey configure\` is also accepted as an alias.)
`,

  auth: `monkey auth <name> [flags] — refresh login + push cookies to BB.

Usage:
  monkey auth <name>                   Refresh existing cookie-jar target
  monkey auth <name> --url <url>       Create new cookie-jar target via export
  monkey auth <name> --reset           Wipe profile + start fresh

Flags:
  --url <url>          For new targets — the app URL to navigate to.
                       Required if the target doesn't already exist.
  --out <path>         Override output JSON path. Default for new targets:
                       ~/.config/monkey-explorer/cookie-jars/<name>.json
                       Default for existing: target's existing cookie-jar-path.
  --reset              Wipe the persistent Chrome profile dir before launching.
                       Use to sign in as a different user, or to recover from
                       "profile in use" errors.
  --skip-bootstrap     Don't auto-run bootstrap-auth at the end. Default is to
                       bootstrap immediately so the next mission is fast. Set
                       this in CI / scripted flows where bootstrap runs separately.

What happens:
  1. Opens Chrome with a persistent profile (~/.config/monkey-explorer/chrome-profile/).
     After your first sign-in there, subsequent runs reuse the same Chrome
     session — you don't re-do OAuth every export.
  2. Navigates to the URL. Auto-detects whether you're already signed in.
     - If yes: just press Enter to capture cookies.
     - If no:  sign in via the Chrome window, then press Enter.
  3. Captures cookies + localStorage as a Playwright storageState JSON.
  4. Auto-runs bootstrap-auth, pushing the cookies into your BB context.
     The next mission starts already signed in, no auto-reauth needed.
     (Skip with --skip-bootstrap if you want to bootstrap separately.)

Why local Chrome: Google's bot detection is hostile to data-center IPs.
Signing in from your own browser produces cookies that work fine in BB
via cookie-jar mode.

(\`monkey export-cookies\` is also accepted as an alias.)
`,

  runs: `monkey runs — show active + recent runs across all targets.

Usage:
  monkey runs                       Past 24h, all targets
  monkey runs --target <name>       Filter to one target
  monkey runs --since <duration>    Custom window (e.g., 1h, 7d, 30m)

Reports live at ~/.config/monkey-explorer/reports/<target>/. In a TTY:
arrow keys + enter to drill into a report. Piped (non-TTY): static
greppable text.

(\`monkey list\` is also accepted as an alias.)
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
  // Aliases route to the new canonical key.
  const HELP_ALIASES: Record<string, string> = {
    'export-cookies': 'auth',
    'bootstrap-auth': 'auth',
    configure: 'config',
    list: 'runs',
  };
  if (args.help && subcommand) {
    let key = HELP_ALIASES[subcommand] ?? subcommand;
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
          nonInteractive: Boolean(args['non-interactive']),
        });
      }
      case 'target': {
        const { runTargetDispatch } = await import('./commands/target/index.js');
        return runTargetDispatch({
          positional: args._.slice(1),
          nonInteractive: Boolean(args['non-interactive']),
          addFlags: {
            url: args.url,
            authMode: args['auth-mode'],
            signInUrl: args['sign-in-url'],
            testEmail: args['test-email'],
            testPassword: args['test-password'],
            customPath: args['custom-path'],
            cookieJarPath: args['cookie-jar-path'],
            skipBootstrap: args['skip-bootstrap'],
          },
        });
      }
      case 'current': {
        const { runCurrent } = await import('./commands/current.js');
        return runCurrent();
      }
      case 'config':
      case 'configure': {  // alias kept for muscle memory
        const { runConfigure } = await import('./commands/configure.js');
        return runConfigure();
      }
      case 'auth':
      case 'export-cookies':  // alias kept for muscle memory
      case 'bootstrap-auth': {  // alias — bootstrap-auth was retired as a user-facing command
        const positionalName = args._[1] ?? args.target;
        if (!positionalName) {
          process.stderr.write('Usage: monkey auth <target-name> [--url <url>] [--reset] [--skip-bootstrap]\n');
          return 1;
        }
        const { runAuth } = await import('./commands/auth.js');
        return runAuth({
          targetName: positionalName,
          url: args.url,
          out: args.out,
          reset: args.reset,
          skipBootstrap: args['skip-bootstrap'],
          nonInteractive: Boolean(args['non-interactive']),
        });
      }
      case 'runs':
      case 'list': {  // alias kept for muscle memory
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
          includeSpeculative: Boolean(args['include-speculative']),
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
