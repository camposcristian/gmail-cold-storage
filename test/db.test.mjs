import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../lib/db.mjs';
import fs from 'fs';

const TEST_DB = '/tmp/test-email-index.db';

describe('db', () => {
  let db;

  before(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = createDb(TEST_DB);
  });

  after(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('inserts and retrieves an email', () => {
    db.upsert({
      id: 'msg001', threadId: 'thr001', subject: 'Hello World',
      from: 'alice@example.com', to: 'bob@example.com', cc: '',
      date: 'Mon, 1 Jan 2024 10:00:00 +0000',
      snippet: 'This is a test email', labels: ['INBOX'],
      sizeEstimate: 1024, r2Key: 'emails/gmail/2024/01/msg001.eml', source: 'gmail',
    });
    const row = db.getById('msg001');
    assert.equal(row.subject, 'Hello World');
    assert.equal(row.from, 'alice@example.com');
  });

  it('upserts (updates on conflict)', () => {
    db.upsert({
      id: 'msg001', threadId: 'thr001', subject: 'Updated Subject',
      from: 'alice@example.com', to: 'bob@example.com', cc: '',
      date: 'Mon, 1 Jan 2024 10:00:00 +0000', snippet: 'Updated snippet',
      labels: [], sizeEstimate: 2048,
      r2Key: 'emails/gmail/2024/01/msg001.eml', source: 'gmail',
    });
    const row = db.getById('msg001');
    assert.equal(row.subject, 'Updated Subject');
    assert.equal(row.sizeEstimate, 2048);
  });

  it('has() checks existence', () => {
    assert.equal(db.has('msg001'), true);
    assert.equal(db.has('nonexistent'), false);
  });

  it('searches with FTS5', () => {
    db.upsert({
      id: 'msg002', threadId: 'thr002',
      subject: 'Rental Agreement for 42 Smith St',
      from: 'landlord@realestate.com', to: 'bob@example.com', cc: '',
      date: 'Tue, 15 Mar 2019 08:00:00 +0000',
      snippet: 'Please find attached the rental agreement for your new property',
      labels: ['INBOX'], sizeEstimate: 45000,
      r2Key: 'emails/gmail/2019/03/msg002.eml', source: 'gmail',
    });

    const results = db.search('rental agreement');
    assert.ok(results.total >= 1);
    assert.ok(results.emails.some(e => e.id === 'msg002'));
  });

  it('paginates results', () => {
    for (let i = 10; i < 30; i++) {
      db.upsert({
        id: `msg${i}`, threadId: `thr${i}`, subject: `Email number ${i}`,
        from: 'sender@example.com', to: 'me@example.com', cc: '',
        date: `Mon, ${i} Jan 2024 10:00:00 +0000`, snippet: `Content ${i}`,
        labels: [], sizeEstimate: 500,
        r2Key: `emails/gmail/2024/01/msg${i}.eml`, source: 'gmail',
      });
    }
    const page1 = db.query({ page: 1, perPage: 5, sort: 'date_unix', order: 'desc' });
    assert.equal(page1.emails.length, 5);
    assert.ok(page1.total >= 20);
    assert.ok(page1.pages >= 4);

    const page2 = db.query({ page: 2, perPage: 5, sort: 'date_unix', order: 'desc' });
    assert.equal(page2.emails.length, 5);
    assert.notEqual(page1.emails[0].id, page2.emails[0].id);
  });

  it('returns stats with top domains', () => {
    const stats = db.stats();
    assert.ok(stats.total >= 20);
    assert.ok(stats.totalSize > 0);
    assert.ok(Array.isArray(stats.topDomains));
    assert.ok(stats.topDomains.length > 0);
  });

  it('allIds returns a Set of all IDs', () => {
    const ids = db.allIds();
    assert.ok(ids instanceof Set);
    assert.ok(ids.has('msg001'));
    assert.ok(ids.size >= 20);
  });

  it('exports as buffer', () => {
    const buf = db.exportBuffer();
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 0);
  });
});
