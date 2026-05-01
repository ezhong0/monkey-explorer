// Pick the right API key from credentials based on the model's provider
// prefix (e.g., "anthropic/claude-..." → anthropicApiKey).
//
// Falls back to a clear error if the required key isn't present, since
// silently passing the wrong key triggers an opaque 401 from the provider.

import type { Credentials } from '../state/schema.js';

export function pickModelApiKey(modelName: string, credentials: Credentials): string {
  const slash = modelName.indexOf('/');
  const provider = slash === -1 ? modelName : modelName.slice(0, slash);

  switch (provider) {
    case 'anthropic': {
      const key = credentials.anthropicApiKey;
      if (!key) {
        throw new Error(
          `Model "${modelName}" requires an Anthropic API key. Run \`monkey login\` to add one.`,
        );
      }
      return key;
    }
    case 'openai':
      return credentials.openaiApiKey;
    default:
      // Unknown provider — fall through to OpenAI key. Lets users experiment
      // with provider strings the SDK supports without us blocklisting them.
      return credentials.openaiApiKey;
  }
}
