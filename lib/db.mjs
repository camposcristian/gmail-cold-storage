// lib/db.mjs
import Database from 'better-sqlite3';

export function createDb(filepath) {
  const db = new Database(filepath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY,
      thread_id TEXT,
      subject TEXT NOT NULL DEFAULT '',
      sender TEXT NOT NULL DEFAULT '',
      recipient TEXT NOT NULL DEFAULT '',
      cc TEXT DEFAULT '',
      date TEXT,
      date_unix INTEGER,
      snippet TEXT DEFAULT '',
      labels TEXT DEFAULT '[]',
      size_estimate INTEGER DEFAULT 0,
      r2_key TEXT UNIQUE NOT NULL,
      archived_at TEXT,
      source TEXT DEFAULT 'gmail',
      category TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_date_unix ON emails(date_unix DESC);
    CREATE INDEX IF NOT EXISTS idx_sender ON emails(sender);
    CREATE INDEX IF NOT EXISTS idx_r2_key ON emails(r2_key);
    CREATE INDEX IF NOT EXISTS idx_category ON emails(category);
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
      subject, sender, recipient, snippet,
      content=emails, content_rowid=rowid
    );
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS emails_ai AFTER INSERT ON emails BEGIN
      INSERT INTO emails_fts(rowid, subject, sender, recipient, snippet)
      VALUES (new.rowid, new.subject, new.sender, new.recipient, new.snippet);
    END;
    CREATE TRIGGER IF NOT EXISTS emails_ad AFTER DELETE ON emails BEGIN
      INSERT INTO emails_fts(emails_fts, rowid, subject, sender, recipient, snippet)
      VALUES ('delete', old.rowid, old.subject, old.sender, old.recipient, old.snippet);
    END;
    CREATE TRIGGER IF NOT EXISTS emails_au AFTER UPDATE ON emails BEGIN
      INSERT INTO emails_fts(emails_fts, rowid, subject, sender, recipient, snippet)
      VALUES ('delete', old.rowid, old.subject, old.sender, old.recipient, old.snippet);
      INSERT INTO emails_fts(rowid, subject, sender, recipient, snippet)
      VALUES (new.rowid, new.subject, new.sender, new.recipient, new.snippet);
    END;
  `);

  const stmts = {
    upsert: db.prepare(`
      INSERT INTO emails (id, thread_id, subject, sender, recipient, cc, date, date_unix, snippet, labels, size_estimate, r2_key, archived_at, source)
      VALUES (@id, @threadId, @subject, @from, @to, @cc, @date, @dateUnix, @snippet, @labels, @sizeEstimate, @r2Key, @archivedAt, @source)
      ON CONFLICT(id) DO UPDATE SET
        subject=excluded.subject, sender=excluded.sender, recipient=excluded.recipient,
        cc=excluded.cc, snippet=excluded.snippet, labels=excluded.labels,
        size_estimate=excluded.size_estimate
    `),
    getById: db.prepare('SELECT * FROM emails WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) as total FROM emails'),
    allIds: db.prepare('SELECT id FROM emails'),
  };

  function parseDate(dateStr) {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000);
  }

  function rowToEmail(row) {
    if (!row) return null;
    return {
      id: row.id,
      threadId: row.thread_id,
      subject: row.subject,
      from: row.sender,
      to: row.recipient,
      cc: row.cc,
      date: row.date,
      snippet: row.snippet,
      labels: JSON.parse(row.labels || '[]'),
      sizeEstimate: row.size_estimate,
      r2Key: row.r2_key,
      archivedAt: row.archived_at,
      source: row.source,
    };
  }

  return {
    upsert(entry) {
      stmts.upsert.run({
        id: entry.id,
        threadId: entry.threadId,
        subject: entry.subject,
        from: entry.from,
        to: entry.to,
        cc: entry.cc || '',
        date: entry.date,
        dateUnix: parseDate(entry.date),
        snippet: entry.snippet || '',
        labels: JSON.stringify(entry.labels || []),
        sizeEstimate: entry.sizeEstimate || 0,
        r2Key: entry.r2Key,
        archivedAt: entry.archivedAt || new Date().toISOString(),
        source: entry.source || 'gmail',
      });
    },

    getById(id) {
      return rowToEmail(stmts.getById.get(id));
    },

    has(id) {
      return !!stmts.getById.get(id);
    },

    allIds() {
      return new Set(stmts.allIds.all().map(r => r.id));
    },

    search(query, { page = 1, perPage = 50, sort = 'date_unix', order = 'desc' } = {}) {
      const offset = (page - 1) * perPage;
      const allowedSort = ['date_unix', 'sender', 'subject', 'size_estimate'];
      const col = allowedSort.includes(sort) ? sort : 'date_unix';
      const dir = order === 'asc' ? 'ASC' : 'DESC';

      const countRow = db.prepare(
        'SELECT COUNT(*) as total FROM emails WHERE rowid IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?)'
      ).get(query);

      const rows = db.prepare(`
        SELECT e.* FROM emails e
        WHERE e.rowid IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?)
        ORDER BY e.${col} ${dir}
        LIMIT ? OFFSET ?
      `).all(query, perPage, offset);

      return {
        emails: rows.map(rowToEmail),
        total: countRow.total,
        page,
        pages: Math.ceil(countRow.total / perPage),
      };
    },

    query({ page = 1, perPage = 50, sort = 'date_unix', order = 'desc' } = {}) {
      const offset = (page - 1) * perPage;
      const allowedSort = ['date_unix', 'sender', 'subject', 'size_estimate'];
      const col = allowedSort.includes(sort) ? sort : 'date_unix';
      const dir = order === 'asc' ? 'ASC' : 'DESC';

      const total = stmts.count.get().total;
      const rows = db.prepare(`SELECT * FROM emails ORDER BY ${col} ${dir} LIMIT ? OFFSET ?`).all(perPage, offset);

      return {
        emails: rows.map(rowToEmail),
        total,
        page,
        pages: Math.ceil(total / perPage),
      };
    },

    stats() {
      const total = stmts.count.get().total;
      const sizeRow = db.prepare('SELECT COALESCE(SUM(size_estimate), 0) as s FROM emails').get();
      const domains = db.prepare(`
        SELECT
          LOWER(REPLACE(SUBSTR(sender, INSTR(sender, '@') + 1), '>', '')) as domain,
          COUNT(*) as count
        FROM emails WHERE sender LIKE '%@%'
        GROUP BY domain ORDER BY count DESC LIMIT 20
      `).all();

      return {
        total,
        totalSize: sizeRow.s,
        topDomains: domains.map(d => [d.domain, d.count]),
      };
    },

    exportBuffer() {
      return Buffer.from(db.serialize());
    },

    close() {
      db.close();
    },
  };
}
