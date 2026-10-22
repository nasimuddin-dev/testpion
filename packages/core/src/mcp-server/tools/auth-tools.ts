import { oauth2TokenOf } from '../../protocols/http/auth-token.js';
import type { AppSettings } from '../../model/types.js';
import type { SecretStore } from '../../storage/secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { str, type Tool } from '../tool.js';
import { withEngine } from './server-kit.js';

/** `auth_token`: the MCP twin of "Get token" in the Authorization tab and `testpion auth token`. */
export function authTools({ store, secrets, settings }: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings }): Tool[] {
  return [
    {
      name: 'auth_token',
      description:
        'Run the OAuth 2.0 grant of a collection, or of one of its requests (its own auth, else its folder\'s or the collection\'s), now: whether the token call works, when the token ends (expiresAt, expiresInSeconds), its scope and the token masked (never in full). The variables of the auth fields are filled from `environment`. The token is cached for the next send. A failing token endpoint comes back as the error, with its (redacted) answer.',
      inputSchema: {
        type: 'object',
        properties: { collection: str('Collection name or id'), request: str('A request of it: name or id (default: the collection\'s own auth)'), environment: str('Environment whose variables fill the auth fields'), cached: { type: 'boolean', description: 'Use a token that is cached already (default: ask the server for a new one)' } },
        required: ['collection'],
      },
      run: (a) => withEngine({ store, secrets, settings }, { environment: a.environment ? String(a.environment) : undefined }, (ctx) => oauth2TokenOf(store, ctx, { collection: String(a.collection), request: a.request ? String(a.request) : undefined, fresh: a.cached !== true })),
    },
  ];
}
