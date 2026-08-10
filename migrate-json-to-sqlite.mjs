#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createDb } from './lib/db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const jsonPath = process.argv[2] || path.join(__dirname, '.archive-staging', 'index.json');
const dbPath = process.argv[3] || path.join(__dirname, '.archive-staging', 'index.db');

if (!fs.existsSync(jsonPath)) {
  console.error(`index.json not found at ${jsonPath}`);
  console.error('Usage: node migrate-json-to-sqlite.mjs [path/to/index.json] [path/to/output.db]');
  process.exit(1);
}

const entries = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
console.log(`📋 Found ${entries.length} entries in ${jsonPath}`);

if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
const db = createDb(dbPath);

let migrated = 0;
for (const e of entries) {
  db.upsert({
    id: e.id,
    threadId: e.threadId,
    subject: e.subject,
    from: e.from,
    to: e.to,
    cc: e.cc || '',
    date: e.date,
    snippet: e.snippet || '',
    labels: e.labels || [],
    sizeEstimate: e.sizeEstimate || 0,
    r2Key: e.r2Key,
    archivedAt: e.archivedAt,
    source: 'gmail',
  });
  migrated++;
}

console.log(`✅ Migrated ${migrated} entries to ${dbPath}`);
console.log(`📊 DB size: ${(fs.statSync(dbPath).size / 1024).toFixed(0)} KB`);

const stats = db.stats();
console.log(`   Total emails: ${stats.total}`);
console.log(`   Top domains: ${stats.topDomains.slice(0, 5).map(([d, c]) => `${d} (${c})`).join(', ')}`);

db.close();
