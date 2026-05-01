// Detects whether stdout is connected to a terminal.
// `monkey list` uses this to switch between interactive (arrow keys) and
// static (greppable) output modes.

export function isStdoutTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}
