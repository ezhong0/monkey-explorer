// Pick the right API key from credentials based on the model's provider
// prefix (e.g., "anthropic/claude-..." → anthropicApiKey).
//
// Falls back to a clear error if the required key isn't present, since
// silently passing the wrong key triggers an opaque 401 from the provider.

import type { Credentials } from '../state/schema.js';

export function pickModelApiKey(modelName: string, credentials: Credentials): string {
  const provider = modelProvider(modelName);

  switch (provider) {
    case 'anthropic': {
      const key = credentials.anthropicApiKey;
      if (!key) {
        throw new Error(
          `Model "${modelName}" requires an Anthropic API key. Run \`monkey login\` to add one, or \`monkey config\` to switch to a different model.`,
        );
      }
      return key;
    }
    case 'openai':
    default: {
      // Unknown provider falls back to OpenAI; lets users experiment with
      // provider strings the SDK supports without us blocklisting them.
      const key = credentials.openaiApiKey;
      if (!key) {
        throw new Error(
          `Model "${modelName}" requires an OpenAI API key. Run \`monkey login\` to add one, or \`monkey config\` to switch to an Anthropic model.`,
        );
      }
      return key;
    }
  }
}

export function modelProvider(modelName: string): 'anthropic' | 'openai' | 'other' {
  const slash = modelName.indexOf('/');
  const prefix = slash === -1 ? modelName : modelName.slice(0, slash);
  if (prefix === 'anthropic') return 'anthropic';
  if (prefix === 'openai') return 'openai';
  return 'other';
}
