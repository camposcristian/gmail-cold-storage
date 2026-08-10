import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../lib/storage.mjs';

const skip = !process.env.S3_ENDPOINT;

describe('storage', { skip }, () => {
  let storage;
  const testKey = `_test/${Date.now()}/test.txt`;

  before(() => {
    storage = createStorage({
      endpoint: process.env.S3_ENDPOINT,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION || 'auto',
    });
  });

  after(async () => {
    try { await storage.delete(testKey); } catch {}
  });

  it('puts and gets an object', async () => {
    await storage.put(testKey, Buffer.from('hello'), 'text/plain');
    const body = await storage.get(testKey);
    assert.equal(body.toString(), 'hello');
  });

  it('returns null for missing key', async () => {
    const body = await storage.get('_test/nonexistent-' + Date.now());
    assert.equal(body, null);
  });

  it('lists objects by prefix', async () => {
    const keys = await storage.list('_test/');
    assert.ok(Array.isArray(keys));
  });
});
