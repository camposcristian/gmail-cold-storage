#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createStorage } from './lib/storage.mjs';
import { createDb } from './lib/db.mjs';
import { createGmailFetcher } from './lib/gmail.mjs';
import { createImapFetcher } from './lib/imap.mjs';
import { createOutlookFetcher } from './lib/outlook.mjs';
import PostalMime from 'postal-mime';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STAGING_DIR = path.join(__dirname, '.archive-staging');
const DB_PATH = path.join(STAGING_DIR, 'index.db');

function getConfig() {
  return {
    s3: {
      endpoint: process.env.S3_ENDPOINT,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION || 'auto',
    },
    prefix: process.env.EMAIL_PREFIX || 'emails/gmail',
    fetcher: process.env.FETCHER || 'imap',
    gmail: {
      credentialsPath: process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json',
      tokenPath: process.env.GOOGLE_TOKEN_PATH || './token.json',
    },
    imap: {
      host: process.env.IMAP_HOST,
      port: process.env.IMAP_PORT || '993',
      user: process.env.IMAP_USER,
      pass: process.env.IMAP_PASS,
    },
    outlook: {
      user: process.env.OUTLOOK_USER,
      tokenCachePath: process.env.OUTLOOK_TOKEN_PATH || './outlook-token.json',
      mailbox: process.env.OUTLOOK_MAILBOX || 'INBOX',
    },
  };
}

function slugify(s, maxLen) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/[^\w\s.-]/g, '').replace(/\s+/g, '-').toLowerCase().slice(0, maxLen).replace(/[-.]+$/, '');
}

function emailKey(prefix, metadata) {
  const date = new Date(metadata.date);
  const year = isNaN(date.getFullYear()) ? 'unknown' : date.getFullYear();
  const month = isNaN(date.getMonth()) ? '00' : String(date.getMonth() + 1).padStart(2, '0');
  const isDraft = (metadata.labels || []).includes('DRAFT');
  if (isDraft) {
    const day = isNaN(date.getDate()) ? '00' : String(date.getDate()).padStart(2, '0');
    const fromSlug = slugify((metadata.from || 'unknown').split('@')[0], 20) || 'unknown';
    const subjSlug = slugify(metadata.subject || 'no-subject', 40) || 'no-subject';
    return `${prefix}/${year}/${month}/draft_${year}-${month}-${day}_${fromSlug}_${subjSlug}_${metadata.id}.eml`;
  }
  return `${prefix}/${year}/${month}/${metadata.id}.eml`;
}

async function createFetcher(config) {
  if (config.fetcher === 'gmail-api') {
    return createGmailFetcher({
      credentialsPath: config.gmail.credentialsPath,
      tokenPath: config.gmail.tokenPath,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    });
  }
  if (config.fetcher === 'outlook') {
    if (!config.outlook.user) {
      console.error('⚠️  FETCHER=outlook requires OUTLOOK_USER (your Outlook.com/Hotmail address).');
      process.exit(1);
    }
    return createOutlookFetcher(config.outlook);
  }
  return createImapFetcher(config.imap);
}

async function main() {
  const args = process.argv.slice(2);
  const config = getConfig();

  if (!config.s3.endpoint || !config.s3.accessKeyId) {
    console.error('⚠️  Missing S3 config. Copy .env.example to .env and fill in your values.');
    process.exit(1);
  }

  const mode = args.includes('--archive') ? 'archive'
    : args.includes('--delete-archived') ? 'delete-archived'
    : args.includes('--rebuild-index') ? 'rebuild-index'
    : args.find(a => a.startsWith('--search=')) ? 'search'
    : 'dry-run';

  const queryArg = args.find(a => a.startsWith('--query='));
  const searchArg = args.find(a => a.startsWith('--search='));
  const query = queryArg ? queryArg.split('=').slice(1).join('=') : 'older_than:5y';
  const searchTerm = searchArg ? searchArg.split('=').slice(1).join('=') : '';

  const storage = createStorage(config.s3);
  if (!fs.existsSync(STAGING_DIR)) fs.mkdirSync(STAGING_DIR, { recursive: true });
  const db = createDb(DB_PATH);

  // ── Search ──
  if (mode === 'search') {
    if (!searchTerm.trim()) { console.error('Usage: node archive.mjs --search="keyword"'); process.exit(1); }
    const results = db.search(searchTerm);
    console.log(`\n🔍 Found ${results.total} archived emails matching "${searchTerm}":\n`);
    for (const m of results.emails.slice(0, 50)) {
      const sizeMB = (m.sizeEstimate / (1024 * 1024)).toFixed(1);
      console.log(`  ${(m.date || '').substring(0, 16).padEnd(18)}| ${m.from.replace(/<.*>/, '').trim().substring(0, 25).padEnd(27)}| ${m.subject.substring(0, 50)}`);
      console.log(`  ${''.padEnd(18)}| R2: ${m.r2Key} (${sizeMB} MB)`);
    }
    if (results.total > 50) console.log(`\n  ... and ${results.total - 50} more`);
    db.close();
    return;
  }

  // ── Rebuild Index ──
  if (mode === 'rebuild-index') {
    console.log(`\n🔄 Rebuilding index from bucket...\n`);
    const keys = await storage.list(config.prefix);
    const emlKeys = keys.filter(k => k.endsWith('.eml'));
    console.log(`  Found ${emlKeys.length} .eml files\n`);

    let rebuilt = 0, failed = 0;
    for (const key of emlKeys) {
      try {
        const raw = await storage.get(key);
        if (!raw) { failed++; continue; }
        const parser = new PostalMime();
        const parsed = await parser.parse(raw);

        const idMatch = key.match(/([^/]+)\.eml$/);
        const id = idMatch ? idMatch[1] : key;

        db.upsert({
          id,
          threadId: parsed.messageId || id,
          subject: parsed.subject || '',
          from: parsed.from?.address ? `${parsed.from.name || ''} <${parsed.from.address}>`.trim() : '',
          to: (parsed.to || []).map(a => a.address).join(', '),
          cc: (parsed.cc || []).map(a => a.address).join(', '),
          date: parsed.date || '',
          snippet: (parsed.text || '').substring(0, 200),
          labels: [],
          sizeEstimate: raw.length,
          r2Key: key,
          source: 'rebuild',
        });
        rebuilt++;
        if (rebuilt % 100 === 0) process.stdout.write(`\r  📦 Rebuilt: ${rebuilt}/${emlKeys.length}`);
      } catch (e) {
        console.error(`\n  ⚠️  Failed to parse ${key}: ${e.message}`);
        failed++;
      }
    }

    const dbBuffer = db.exportBuffer();
    await storage.put(`${config.prefix}/index.db`, dbBuffer, 'application/x-sqlite3');
    console.log(`\n\n  ✅ Rebuilt index: ${rebuilt} emails, ${failed} failed`);
    console.log(`  ☁️  Uploaded index.db to ${config.prefix}/index.db`);
    db.close();
    return;
  }

  // ── Dry Run / Archive / Delete ──
  console.log(`\n${'='.repeat(60)}`);
  console.log(mode === 'dry-run' ? '  📋 DRY RUN' : mode === 'archive' ? '  📦 ARCHIVE' : '  🗑  DELETE-ARCHIVED');
  console.log(`${'='.repeat(60)}\n`);

  const fetcher = await createFetcher(config);
  console.log(`📧 Account: ${fetcher.account} (${fetcher.name})`);
  console.log(`🔍 Query: ${query}\n`);

  process.stdout.write('Searching...');
  const ids = await fetcher.search(query);
  console.log(`\r🔍 Found ${ids.length} emails matching query\n`);

  if (ids.length === 0) { db.close(); if (fetcher.close) await fetcher.close(); return; }

  if (mode === 'dry-run') {
    let totalSize = 0;
    const sample = Math.min(ids.length, 200);
    process.stdout.write(`📊 Sampling ${sample} emails...`);
    for (let i = 0; i < sample; i++) {
      const meta = await fetcher.getMetadata(ids[i]);
      totalSize += meta.sizeEstimate;
    }
    const avgSize = totalSize / sample;
    const estTotal = (avgSize * ids.length) / (1024 * 1024 * 1024);
    console.log(`\n\n📊 Estimated: ${estTotal.toFixed(2)} GB (avg ${(avgSize / 1024).toFixed(1)} KB/email)`);
    console.log(`💰 R2 cost: ~$${(estTotal * 0.015).toFixed(2)}/month`);
    console.log(`\n💡 To archive: node archive.mjs --archive --query="${query}"`);
  }

  if (mode === 'archive') {
    const archivedIds = db.allIds();
    let archived = 0, skipped = 0, failed = 0;

    for (let i = 0; i < ids.length; i++) {
      const msgId = ids[i];
      if (archivedIds.has(msgId)) { skipped++; continue; }

      try {
        const meta = await fetcher.getMetadata(msgId);
        const key = emailKey(config.prefix, meta);
        const raw = await fetcher.getRaw(msgId);
        await storage.put(key, raw, 'message/rfc822');

        db.upsert({
          id: meta.id, threadId: meta.threadId, subject: meta.subject,
          from: meta.from, to: meta.to, cc: meta.cc, date: meta.date,
          snippet: meta.snippet, labels: meta.labels, sizeEstimate: meta.sizeEstimate,
          r2Key: key, source: fetcher.name,
        });
        archived++;
        if ((archived + skipped + failed) % 10 === 0) {
          process.stdout.write(`\r  📦 Archived: ${archived} | Skipped: ${skipped} | Failed: ${failed} | ${i + 1}/${ids.length}`);
        }
        await new Promise(r => setTimeout(r, 100));
      } catch (e) {
        console.error(`\n  ⚠️  ${msgId}: ${e.message}`);
        failed++;
      }
    }

    const dbBuffer = db.exportBuffer();
    await storage.put(`${config.prefix}/index.db`, dbBuffer, 'application/x-sqlite3');
    console.log(`\n\n  ✅ Done: ${archived} archived, ${skipped} skipped, ${failed} failed`);
    console.log(`  ☁️  Uploaded index.db`);
  }

  if (mode === 'delete-archived') {
    if (fetcher.name !== 'gmail-api') {
      console.log('⚠️  Delete mode requires Gmail API fetcher (FETCHER=gmail-api)');
      console.log('   IMAP delete is not implemented — manage via your email client.');
      db.close();
      if (fetcher.close) await fetcher.close();
      return;
    }
    const archivedIds = [...db.allIds()];
    console.log(`🗑  Deleting ${archivedIds.length} archived emails from Gmail...`);
    await fetcher.batchDelete(archivedIds);
    console.log(`✅ Deleted ${archivedIds.length} emails`);
  }

  if (fetcher.close) await fetcher.close();
  db.close();
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
