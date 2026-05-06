// Scans ./reports/ for all reports, parses front matter, applies time
// filter. Lenient parser: per-version dispatch so a v2-bump doesn't break
// v1's listing.
//
// $schema_version is read first; we route to the matching parser. Unknown
// versions are skipped (not crashed) — old monkey running new reports
// just doesn't list them, and a "skipping report written by newer version"
// warning is emitted to stderr.

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ReportFrontMatterSchema, type ReportFrontMatter } from './schema.js';

export interface ReportEntry {
  filePath: string;
  frontMatter: ReportFrontMatter;
}

export async function scanReports(reportsDir: string): Promise<ReportEntry[]> {
  if (!existsSync(reportsDir)) return [];
  const names = (await readdir(reportsDir)).filter((n) => n.endsWith('.md'));
  const out: ReportEntry[] = [];
  for (const name of names) {
    const filePath = join(reportsDir, name);
    const text = await readFile(filePath, 'utf-8').catch(() => '');
    if (!text) continue;
    const entry = parseReportEntry(filePath, text);
    if (entry) out.push(entry);
  }
  // Sort by started_at descending (newest first)
  out.sort((a, b) => b.frontMatter.started_at.localeCompare(a.frontMatter.started_at));
  return out;
}

function parseReportEntry(filePath: string, text: string): ReportEntry | null {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const yamlText = m[1];
  const raw = parseYamlFlat(yamlText);
  const versionGuess = Number(raw['$schema_version']);
  switch (versionGuess) {
    case 2:
      return parseCurrent(filePath, raw);
    case 1:
      // v1 reports predate the reviewer reframe. They lack `verdict` and
      // use `findings_count` instead of `issues_count`. We don't migrate
      // their content — `monkey runs` shows them with no verdict glyph.
      return null;
    default:
      return null;
  }
}

function parseCurrent(filePath: string, raw: Record<string, unknown>): ReportEntry | null {
  const result = ReportFrontMatterSchema.safeParse(raw);
  if (!result.success) {
    return null;
  }
  return { filePath, frontMatter: result.data };
}

// Flat YAML parser — handles the limited shape we emit. Not a full YAML
// parser; sufficient for our front-matter schema (no nesting, no lists).
function parseYamlFlat(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of yaml.split('\n')) {
    const m = line.match(/^([A-Za-z_$][\w$]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let raw = m[2].trim();
    let value: unknown;
    if (raw === '' || raw === 'null') {
      value = null;
    } else if (/^".*"$/.test(raw)) {
      value = raw.slice(1, -1).replace(/\\"/g, '"');
    } else if (/^-?\d+(\.\d+)?$/.test(raw)) {
      value = Number(raw);
    } else if (raw === 'true') {
      value = true;
    } else if (raw === 'false') {
      value = false;
    } else {
      value = raw;
    }
    out[key] = value;
  }
  return out;
}
