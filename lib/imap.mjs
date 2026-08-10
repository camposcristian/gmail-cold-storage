import { ImapFlow } from 'imapflow';

export async function createImapFetcher({ host, port, user, pass, mailbox = 'INBOX' }) {
  const client = new ImapFlow({
    host,
    port: parseInt(port, 10),
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  await client.connect();

  return {
    name: 'imap',
    account: user,

    async search(query) {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const criteria = parseQuery(query);
        const uids = await client.search(criteria, { uid: true });
        return uids.map(String);
      } finally {
        lock.release();
      }
    },

    async getMetadata(uid) {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const msg = await client.fetchOne(uid, {
          uid: true,
          envelope: true,
          size: true,
          flags: true,
        }, { uid: true });

        const env = msg.envelope;
        return {
          id: `imap-${uid}`,
          threadId: env.messageId || `imap-${uid}`,
          subject: env.subject || '',
          from: formatAddr(env.from),
          to: formatAddr(env.to),
          cc: formatAddr(env.cc),
          date: env.date?.toUTCString() || '',
          snippet: '',
          labels: [...(msg.flags || [])],
          sizeEstimate: msg.size || 0,
        };
      } finally {
        lock.release();
      }
    },

    async getRaw(uid) {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const { content } = await client.download(uid, undefined, { uid: true });
        const chunks = [];
        for await (const chunk of content) chunks.push(chunk);
        return Buffer.concat(chunks);
      } finally {
        lock.release();
      }
    },

    async close() {
      await client.logout();
    },
  };
}

function formatAddr(addrs) {
  if (!addrs || addrs.length === 0) return '';
  return addrs.map(a => {
    if (a.name) return `${a.name} <${a.address}>`;
    return a.address || '';
  }).join(', ');
}

function parseQuery(query) {
  // Translate common Gmail-style queries to IMAP SEARCH criteria
  const criteria = {};

  const olderMatch = query.match(/older_than:(\d+)([ymd])/);
  if (olderMatch) {
    const [, num, unit] = olderMatch;
    const d = new Date();
    if (unit === 'y') d.setFullYear(d.getFullYear() - parseInt(num));
    else if (unit === 'm') d.setMonth(d.getMonth() - parseInt(num));
    else if (unit === 'd') d.setDate(d.getDate() - parseInt(num));
    criteria.before = d;
  }

  const fromMatch = query.match(/from:(\S+)/);
  if (fromMatch) criteria.from = fromMatch[1];

  const subjectMatch = query.match(/subject:(.+?)(?:\s+\w+:|$)/);
  if (subjectMatch) criteria.subject = subjectMatch[1].trim();

  const textOnly = query
    .replace(/older_than:\S+/g, '')
    .replace(/from:\S+/g, '')
    .replace(/subject:\S+/g, '')
    .trim();
  if (textOnly) criteria.body = textOnly;

  // Default: all messages before 5 years ago
  if (Object.keys(criteria).length === 0) {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 5);
    criteria.before = d;
  }

  return criteria;
}
