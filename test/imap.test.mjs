import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('imap module', async () => {
  const mod = await import('../lib/imap.mjs');
  it('exports createImapFetcher', () => {
    assert.equal(typeof mod.createImapFetcher, 'function');
  });
  it('exports shared helpers reused by the outlook provider', () => {
    assert.equal(typeof mod.createImapFetcherFromClient, 'function');
    assert.equal(typeof mod.parseQuery, 'function');
    assert.equal(typeof mod.formatAddr, 'function');
  });
  it('parseQuery translates older_than into a before-date criterion', () => {
    const c = mod.parseQuery('older_than:5y');
    assert.ok(c.before instanceof Date);
  });
  it('formatAddr renders name + address pairs', () => {
    assert.equal(mod.formatAddr([{ name: 'Ada', address: 'ada@x.com' }]), 'Ada <ada@x.com>');
    assert.equal(mod.formatAddr([]), '');
  });
});
