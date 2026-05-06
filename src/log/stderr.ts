// Stderr discipline — every status / progress / error message goes here.
// Stdout is reserved for report content (`--json` mode, future).

export function info(line: string): void {
  process.stderr.write(line.endsWith('\n') ? line : line + '\n');
}

export function ok(line: string): void {
  process.stderr.write(`✓ ${line}\n`);
}

export function warn(line: string): void {
  process.stderr.write(`⚠ ${line}\n`);
}

export function fail(line: string): void {
  process.stderr.write(`✗ ${line}\n`);
}

export function step(line: string): void {
  process.stderr.write(`▸ ${line}\n`);
}

export function blank(): void {
  process.stderr.write('\n');
}
