// Example custom signIn for Clerk's multi-step sign-in flow.
//
// To use: copy this file to your project directory (alongside monkey.config.json),
// then set authMode in monkey.config.json:
//
//   "authMode": { "kind": "custom", "path": "./signin.mjs" }
//
// The first time monkey loads this file it'll prompt you to confirm the
// SHA-256 hash. Re-prompts if the file changes.
//
// The signature this file must export:
//
//   export default async function signIn({ page, signInUrl, email, password, signal }) { ... }
//
// `page` is a playwright-core Page object. `signInUrl` comes from the
// monkey.config.json's authMode (custom mode has no signInUrl, but you can
// hardcode here). `email` and `password` come from .env.local's TEST_EMAIL
// and TEST_PASSWORD if set. `signal` is an AbortSignal you can listen to
// for SIGINT propagation.

/** @type {import('monkey-explorer').SignInFn} */
export default async function signIn({ page, email, password }) {
  const SIGN_IN_URL = 'https://your-app.com/sign-in';

  console.log(`▸ Navigating to ${SIGN_IN_URL}`);
  await page.goto(SIGN_IN_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.waitForLoadState('networkidle').catch(() => {});

  // Already signed in? Clerk redirects /sign-in → /app when cookie is valid.
  if (!/sign-in/.test(page.url())) {
    console.log(`✓ Already signed in (URL: ${page.url()}). Cookie still valid.`);
    return;
  }

  console.log('▸ Filling email…');
  const emailInput = page
    .locator('input[type="email"], input[name="emailAddress"], input[name="identifier"]')
    .first();
  await emailInput.waitFor({ state: 'visible', timeout: 15_000 });
  await emailInput.fill(email);
  await page
    .getByRole('button', { name: /continue/i })
    .first()
    .click();

  console.log('▸ Filling password…');
  const passwordInput = page.locator('input[type="password"]').first();
  await passwordInput.waitFor({ state: 'visible', timeout: 15_000 });
  await passwordInput.fill(password);
  await page
    .getByRole('button', { name: /continue|sign in/i })
    .first()
    .click();

  console.log('▸ Waiting for redirect into /app…');
  await page.waitForURL(/\/app(\/|$|\?)/, { timeout: 30_000 });
  console.log(`✓ Signed in. URL: ${page.url()}`);
}
