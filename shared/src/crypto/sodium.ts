// Sumo build: the standard libsodium-wrappers excludes crypto_pwhash
// (Argon2id), which the KDF needs. Wasm is embedded as base64 in the JS, so
// it still bundles into the plugin's single main.js.
import _sodium from 'libsodium-wrappers-sumo';

// Single init point for all crypto. libsodium's wasm loads asynchronously;
// every consumer must go through getSodium(), which fails closed until
// initSodium() has resolved. The plugin calls initSodium() in onload before
// starting any sync activity; the server calls it at boot.
let ready = false;

export async function initSodium(): Promise<void> {
  await _sodium.ready;
  ready = true;
}

export function getSodium(): typeof _sodium {
  if (!ready) {
    throw new Error('libsodium not initialized — call initSodium() first');
  }
  return _sodium;
}
