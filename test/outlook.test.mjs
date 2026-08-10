import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('outlook module', async () => {
  const mod = await import('../lib/outlook.mjs');
  it('exports createOutlookFetcher', () => {
    assert.equal(typeof mod.createOutlookFetcher, 'function');
  });
});
