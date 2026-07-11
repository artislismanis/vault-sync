import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const validEnv = {
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_ACCESS_KEY: 'ak',
  S3_SECRET_KEY: 'sk',
  S3_BUCKET: 'vault-sync-dev',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(validEnv);
    expect(config.PORT).toBe(8080);
    expect(config.HOST).toBe('0.0.0.0');
    expect(config.S3_REGION).toBe('us-east-1');
  });

  it('coerces PORT from string', () => {
    expect(loadConfig({ ...validEnv, PORT: '9090' }).PORT).toBe(9090);
  });

  it('rejects missing S3 settings with a readable message', () => {
    expect(() => loadConfig({})).toThrow(/S3_ENDPOINT/);
  });
});
