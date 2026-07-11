import { requestUrl } from 'obsidian';
import { healthResponseSchema, HealthResponse } from '@vault-sync/shared';

// REST client. Uses Obsidian's requestUrl (not fetch): it bypasses webview
// CORS restrictions, which matters on mobile and for self-signed/VPN setups.

export class RestClient {
  constructor(
    private baseUrl: string,
    private token: string | null = null,
  ) {}

  async health(): Promise<HealthResponse> {
    const res = await requestUrl({ url: `${this.baseUrl}/healthz` });
    return healthResponseSchema.parse(res.json);
  }

  // login / vaults / items / revisions / blobs methods land with the sync
  // engine, all request/response shapes parsed via @vault-sync/shared schemas.
}
