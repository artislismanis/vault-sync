import {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { Config } from '../config';

// The ONLY module that touches storage (CLAUDE.md hard rule 5). Everything
// persistent lives in the bucket; the SQLite index is derived and expendable.

export interface ObjectStore {
  checkBucket(): Promise<boolean>;
  put(key: string, body: Uint8Array | string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export function createObjectStore(config: Config): ObjectStore {
  const client = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
    },
    // MinIO and most self-hosted S3 implementations need path-style URLs.
    forcePathStyle: true,
  });
  const Bucket = config.S3_BUCKET;

  return {
    async checkBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
        return true;
      } catch {
        return false;
      }
    },
    async put(Key, Body) {
      await client.send(new PutObjectCommand({ Bucket, Key, Body }));
    },
    async get(Key) {
      const res = await client.send(new GetObjectCommand({ Bucket, Key }));
      return res.Body!.transformToByteArray();
    },
    async exists(Key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket, Key }));
        return true;
      } catch {
        return false;
      }
    },
    async delete(Key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key }));
    },
    async list(prefix) {
      const keys: string[] = [];
      let ContinuationToken: string | undefined;
      do {
        const res = await client.send(
          new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken }),
        );
        for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key);
        ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return keys;
    },
  };
}
