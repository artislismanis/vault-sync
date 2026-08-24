// Local-only fingerprint for the engine's write guards — never transmitted,
// so plain SHA-256 via Web Crypto is enough (no need for the shared crypto
// stack, which is scoped to protocol data).

export async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
