import { google } from 'googleapis';
import fs from 'fs';
import readline from 'readline';

export async function createGmailFetcher({ credentialsPath, tokenPath, scopes }) {
  const credentials = JSON.parse(fs.readFileSync(credentialsPath));
  const { client_id, client_secret } = credentials.installed || credentials.web;
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3333');

  if (fs.existsSync(tokenPath)) {
    const token = JSON.parse(fs.readFileSync(tokenPath));
    oauth2Client.setCredentials(token);
    if (token.expiry_date && token.expiry_date < Date.now()) {
      const { credentials: refreshed } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(refreshed);
      fs.writeFileSync(tokenPath, JSON.stringify(refreshed));
    }
  } else {
    const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: scopes });
    console.log('Open this URL in your browser:\n', authUrl);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const code = await new Promise(resolve => rl.question('Paste the code: ', resolve));
    rl.close();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(tokenPath, JSON.stringify(tokens));
  }

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const profile = await gmail.users.getProfile({ userId: 'me' });

  return {
    name: 'gmail-api',
    account: profile.data.emailAddress,

    async search(query) {
      const ids = [];
      let pageToken;
      do {
        const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 500, pageToken });
        if (res.data.messages) ids.push(...res.data.messages.map(m => m.id));
        pageToken = res.data.nextPageToken;
        await new Promise(r => setTimeout(r, 200));
      } while (pageToken);
      return ids;
    },

    async getMetadata(messageId) {
      const res = await gmail.users.messages.get({
        userId: 'me', id: messageId, format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'To', 'Date', 'Cc'],
      });
      const headers = res.data.payload.headers || [];
      const get = (name) => headers.find(h => h.name === name)?.value || '';
      return {
        id: messageId,
        subject: get('Subject'),
        from: get('From'),
        to: get('To'),
        cc: get('Cc'),
        date: get('Date'),
        snippet: res.data.snippet || '',
        labels: res.data.labelIds || [],
        sizeEstimate: res.data.sizeEstimate || 0,
        threadId: res.data.threadId,
      };
    },

    async getRaw(messageId) {
      const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'raw' });
      return Buffer.from(res.data.raw, 'base64url');
    },

    async batchDelete(ids) {
      const CHUNK = 1000;
      for (let i = 0; i < ids.length; i += CHUNK) {
        await gmail.users.messages.batchDelete({ userId: 'me', requestBody: { ids: ids.slice(i, i + CHUNK) } });
        await new Promise(r => setTimeout(r, 500));
      }
    },
  };
}
