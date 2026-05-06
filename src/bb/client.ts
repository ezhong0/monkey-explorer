// Anti-corruption boundary: only file in the framework that imports the
// Browserbase SDK directly. Everything else uses our internal types.

import { Browserbase } from '@browserbasehq/sdk';

export function createClient(apiKey: string): Browserbase {
  return new Browserbase({ apiKey });
}

export type { Browserbase };
