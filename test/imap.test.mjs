import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('imap module', async () => {
  const mod = await import('../lib/imap.mjs');
  it('exports createImapFetcher', () => {
    assert.equal(typeof mod.createImapFetcher, 'function');
  });
});
