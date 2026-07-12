import { requestUrl } from 'obsidian';
import {
  CreateVaultRequest,
  HeadsResponse,
  headsResponseSchema,
  HistoryResponse,
  historyResponseSchema,
  HealthResponse,
  healthResponseSchema,
  ListDevicesResponse,
  listDevicesResponseSchema,
  ListVaultsResponse,
  listVaultsResponseSchema,
  LoginResponse,
  loginResponseSchema,
  PushRevisionRequest,
  Revision,
  revisionSchema,
} from '@vault-sync/shared';

// REST client. Uses Obsidian's requestUrl (not fetch): it bypasses webview
// CORS restrictions, which matters on mobile and for self-signed/VPN setups.

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export class RestClient {
  constructor(
    private baseUrl: string,
    private token: string | null = null,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  setToken(token: string): void {
    this.token = token;
  }

  private async request(options: {
    path: string;
    method?: string;
    json?: unknown;
    binary?: Uint8Array;
  }): Promise<{ status: number; json: unknown; arrayBuffer: ArrayBuffer }> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await requestUrl({
      url: `${this.baseUrl}${options.path}`,
      method: options.method ?? 'GET',
      headers,
      contentType: options.binary
        ? 'application/octet-stream'
        : options.json !== undefined
          ? 'application/json'
          : undefined,
      body: options.binary
        ? toArrayBuffer(options.binary)
        : options.json !== undefined
          ? JSON.stringify(options.json)
          : undefined,
      throw: false,
    });
    if (res.status >= 400) {
      let detail = '';
      try {
        detail = (res.json as { error?: string })?.error ?? '';
      } catch {
        // non-JSON error body
      }
      throw new Error(
        `${options.method ?? 'GET'} ${options.path} failed (${res.status}) ${detail}`,
      );
    }
    return {
      status: res.status,
      get json() {
        return res.status === 204 ? undefined : res.json;
      },
      get arrayBuffer() {
        return res.arrayBuffer;
      },
    };
  }

  async health(): Promise<HealthResponse> {
    return healthResponseSchema.parse((await this.request({ path: '/healthz' })).json);
  }

  async login(password: string, deviceName: string): Promise<LoginResponse> {
    const res = await this.request({
      path: '/login',
      method: 'POST',
      json: { password, deviceName },
    });
    const parsed = loginResponseSchema.parse(res.json);
    this.token = parsed.token;
    return parsed;
  }

  async listDevices(): Promise<ListDevicesResponse> {
    return listDevicesResponseSchema.parse((await this.request({ path: '/devices' })).json);
  }

  async renameDevice(name: string): Promise<void> {
    await this.request({ path: '/devices/self', method: 'PATCH', json: { name } });
  }

  async listVaults(): Promise<ListVaultsResponse> {
    return listVaultsResponseSchema.parse((await this.request({ path: '/vaults' })).json);
  }

  async createVault(request: CreateVaultRequest): Promise<{ id: string }> {
    const res = await this.request({ path: '/vaults', method: 'POST', json: request });
    return res.json as { id: string };
  }

  async heads(vaultId: string): Promise<HeadsResponse> {
    return headsResponseSchema.parse(
      (await this.request({ path: `/vaults/${vaultId}/heads` })).json,
    );
  }

  async history(vaultId: string, pathHmac: string): Promise<HistoryResponse> {
    return historyResponseSchema.parse(
      (await this.request({ path: `/vaults/${vaultId}/items/${pathHmac}/history` })).json,
    );
  }

  async putChunk(
    vaultId: string,
    revisionId: string,
    seq: number,
    ciphertext: Uint8Array,
  ): Promise<void> {
    await this.request({
      path: `/vaults/${vaultId}/blobs/${revisionId}/chunks/${seq}`,
      method: 'PUT',
      binary: ciphertext,
    });
  }

  async getChunk(vaultId: string, revisionId: string, seq: number): Promise<Uint8Array> {
    const res = await this.request({
      path: `/vaults/${vaultId}/blobs/${revisionId}/chunks/${seq}`,
    });
    return new Uint8Array(res.arrayBuffer);
  }

  /** Legacy v1 whole-blob read — pre-0.0.4 revisions only. */
  async getBlob(vaultId: string, revisionId: string): Promise<Uint8Array> {
    const res = await this.request({ path: `/vaults/${vaultId}/blobs/${revisionId}` });
    return new Uint8Array(res.arrayBuffer);
  }

  async postRevision(vaultId: string, request: PushRevisionRequest): Promise<Revision> {
    const res = await this.request({
      path: `/vaults/${vaultId}/revisions`,
      method: 'POST',
      json: request,
    });
    return revisionSchema.parse(res.json);
  }
}
