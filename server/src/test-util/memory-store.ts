import { Readable } from 'node:stream';
import type { ObjectStore, ObjectMeta } from '../store/s3';

/** In-memory ObjectStore for tests. */
export function memoryStore(): ObjectStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const toBytes = (body: Uint8Array | string) =>
    typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    objects,
    async checkBucket() {
      return true;
    },
    async put(key, body) {
      objects.set(key, toBytes(body));
    },
    async get(key) {
      const value = objects.get(key);
      if (!value) throw new Error(`no such key: ${key}`);
      return value;
    },
    async getStream(key) {
      const value = objects.get(key);
      if (!value) throw new Error(`no such key: ${key}`);
      return Readable.from(Buffer.from(value));
    },
    async exists(key) {
      return objects.has(key);
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    async listWithMeta(prefix) {
      const metas: ObjectMeta[] = [];
      for (const [key, value] of objects) {
        if (key.startsWith(prefix)) {
          metas.push({ key, lastModified: new Date(), sizeBytes: value.byteLength });
        }
      }
      return metas.sort((a, b) => a.key.localeCompare(b.key));
    },
  };
}
