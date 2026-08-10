#!/usr/bin/env node
/**
 * Categorize emails in the SQLite index by sender domain.
 *
 * Usage: node categorize.mjs [path-to-index.db]
 *
 * Edit the RULES below to match the senders in YOUR archive. The examples are
 * placeholders — replace them with the domains you actually receive mail from.
 */
import Database from 'better-sqlite3';

const dbPath = process.argv[2] || '.archive-staging/index.db';
const db = new Database(dbPath);

// Domain fragment → category mapping.
// Order matters: first match wins. More specific patterns go first.
// These are EXAMPLES — edit them for your own mailbox.
const RULES = [
  ['yourbank.example', 'Banking'],
  ['broker.example', 'Trading'],
  ['exchange.example', 'Crypto'],
  ['paypal.com', 'Payments'],
  ['card-issuer.example', 'Cards'],
  ['accountant.example', 'Accounting'],
  ['github.com', 'Dev'],
  ['newsletter.example', 'Newsletters'],
];

function categorize(sender) {
  const lower = (sender || '').toLowerCase();
  for (const [fragment, category] of RULES) {
    if (lower.includes(fragment)) return category;
  }
  return 'Other';
}

// Add column if missing
try {
  db.exec('ALTER TABLE emails ADD COLUMN category TEXT DEFAULT ""');
  console.log('Added category column');
} catch {
  // Column already exists
}
db.exec('CREATE INDEX IF NOT EXISTS idx_category ON emails(category)');

const rows = db.prepare('SELECT rowid, sender FROM emails').all();
const update = db.prepare('UPDATE emails SET category = ? WHERE rowid = ?');

const counts = {};
const tx = db.transaction(() => {
  for (const row of rows) {
    const cat = categorize(row.sender);
    update.run(cat, row.rowid);
    counts[cat] = (counts[cat] || 0) + 1;
  }
});
tx();

console.log(`\nCategorized ${rows.length} emails:\n`);
Object.entries(counts)
  .sort((a, b) => b[1] - a[1])
  .forEach(([cat, count]) => {
    console.log(`  ${count.toString().padStart(5)}  ${cat}`);
  });

db.close();
console.log(`\nDone. Updated: ${dbPath}`);
