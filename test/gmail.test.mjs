import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('gmail module exports', async () => {
  const mod = await import('../lib/gmail.mjs');
  it('exports createGmailFetcher', () => {
    assert.equal(typeof mod.createGmailFetcher, 'function');
  });
});
