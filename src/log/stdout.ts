// Stdout — only used for piping (e.g., printing report markdown to stdout
// so `monkey list` → enter → `> findings.md` works).

export function out(line: string): void {
  process.stdout.write(line.endsWith('\n') ? line : line + '\n');
}

export function outRaw(text: string): void {
  process.stdout.write(text);
}
