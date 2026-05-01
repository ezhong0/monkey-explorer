// One-shot helper: connect to an existing BB context, dump all cookies as
// Playwright storageState JSON. Used to bootstrap a cookie-jar target from
// an already-signed-in interactive target.
//
// Usage: node extract-cookies.mjs <BB_CONTEXT_ID> <OUT_PATH>

import Browserbase from '@browserbasehq/sdk';
import { Stagehand } from '@browserbasehq/stagehand';
import { writeFileSync, chmodSync } from 'node:fs';

const [contextId, outPath] = process.argv.slice(2);
if (!contextId || !outPath) {
  console.error('Usage: node extract-cookies.mjs <CONTEXT_ID> <OUT_PATH>');
  process.exit(1);
}

const apiKey = process.env.BROWSERBASE_API_KEY;
const projectId = process.env.BROWSERBASE_PROJECT_ID;
const openaiApiKey = process.env.OPENAI_API_KEY;
if (!apiKey || !projectId || !openaiApiKey) {
  console.error('Set BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, OPENAI_API_KEY env vars.');
  process.exit(1);
}

const bb = new Browserbase({ apiKey });

// Create a fresh BB session attached to the existing context.
console.log(`Creating BB session attached to context ${contextId}...`);
const session = await bb.sessions.create({
  projectId,
  browserSettings: { context: { id: contextId, persist: true } },
  timeout: 120,
});
console.log(`  session=${session.id}`);

const stagehand = new Stagehand({
  env: 'BROWSERBASE',
  apiKey,
  projectId,
  browserbaseSessionID: session.id,
  model: { modelName: 'openai/gpt-5.5', apiKey: openaiApiKey },
  verbose: 0,
  disablePino: true,
  logger: () => {},
});
await stagehand.init();

try {
  // Get all cookies via CDP Storage.getCookies (browser-wide).
  const result = await stagehand.context.conn.send('Storage.getCookies', {});
  const allCookies = result?.cookies ?? [];
  console.log(`Read ${allCookies.length} cookies from context.`);

  // Convert CDP cookie shape → Playwright storageState shape.
  // CDP fields: name, value, domain, path, expires, size, httpOnly, secure, session, sameSite, priority, sameParty, sourceScheme
  // Playwright fields: name, value, domain, path, expires (-1 for session), httpOnly, secure, sameSite ('Lax'|'Strict'|'None')
  const playwrightCookies = allCookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.session ? -1 : (typeof c.expires === 'number' && c.expires > 0 ? c.expires : -1),
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: ['Lax', 'Strict', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
  }));

  const storageState = {
    cookies: playwrightCookies,
    origins: [], // localStorage extraction would require navigating to each origin; skip for v1
  };

  writeFileSync(outPath, JSON.stringify(storageState, null, 2) + '\n');
  chmodSync(outPath, 0o600);
  console.log(`Wrote ${playwrightCookies.length} cookies to ${outPath} (mode 0600).`);

  // Print domain breakdown so user can verify what's in there.
  const byDomain = {};
  for (const c of playwrightCookies) {
    byDomain[c.domain] = (byDomain[c.domain] || 0) + 1;
  }
  console.log('Cookies by domain:');
  for (const [d, n] of Object.entries(byDomain).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${d.padEnd(50)} ${n}`);
  }
} finally {
  await stagehand.close();
  await bb.sessions.update(session.id, { projectId, status: 'REQUEST_RELEASE' }).catch(() => {});
}
