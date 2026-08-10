import fs from 'fs';
import { ImapFlow } from 'imapflow';
import { PublicClientApplication, LogLevel } from '@azure/msal-node';
import { createImapFetcherFromClient } from './imap.mjs';

// Microsoft killed basic auth / app passwords for personal Outlook.com / Hotmail
// accounts — IMAP now REQUIRES OAuth2. We use the device-code flow so archiving
// works headless without ever handling the user's password.
//
// The client_id below is Thunderbird's public client, which is approved for
// personal (consumers) accounts and the IMAP.AccessAsUser.All scope. No app
// registration of your own is needed.
const THUNDERBIRD_CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const AUTHORITY = 'https://login.microsoftonline.com/consumers';
const IMAP_SCOPE = 'https://outlook.office.com/IMAP.AccessAsUser.All';
const IMAP_HOST = 'outlook.office365.com';
const IMAP_PORT = 993;

function isReauthError(err) {
  const msg = (err && err.message ? err.message : String(err)).toLowerCase();
  return (
    err?.authenticationFailed ||
    err?.code === 'NoConnection' ||
    err?.code === 'ClosedConnection' ||
    msg.includes('authenticationfailed') ||
    msg.includes('command failed') ||
    msg.includes('connection not available') ||
    msg.includes('socket') ||
    msg.includes('closed') ||
    msg.includes('timeout') ||
    msg.includes('expired')
  );
}

export async function createOutlookFetcher({ user, tokenCachePath = './outlook-token.json', mailbox = 'INBOX' }) {
  // Persist MSAL's token cache (access + refresh token) to disk so silent
  // refresh works across runs and across mid-archive reconnects — long archives
  // don't die at the ~60 min access-token expiry.
  const cachePlugin = {
    beforeCacheAccess: async (ctx) => {
      if (fs.existsSync(tokenCachePath)) {
        ctx.tokenCache.deserialize(fs.readFileSync(tokenCachePath, 'utf8'));
      }
    },
    afterCacheAccess: async (ctx) => {
      if (ctx.cacheHasChanged) {
        fs.writeFileSync(tokenCachePath, ctx.tokenCache.serialize());
      }
    },
  };

  const pca = new PublicClientApplication({
    auth: { clientId: THUNDERBIRD_CLIENT_ID, authority: AUTHORITY },
    cache: { cachePlugin },
    system: {
      loggerOptions: {
        loggerCallback: () => {},
        piiLoggingEnabled: false,
        logLevel: LogLevel.Error,
      },
    },
  });

  // Acquire an access token: silently from the cached refresh token when
  // possible (msal adds offline_access automatically), otherwise fall back to
  // the interactive device-code flow.
  async function acquireToken() {
    const accounts = await pca.getTokenCache().getAllAccounts();
    const account = user
      ? accounts.find(a => (a.username || '').toLowerCase() === user.toLowerCase()) || accounts[0]
      : accounts[0];

    if (account) {
      try {
        const res = await pca.acquireTokenSilent({ account, scopes: [IMAP_SCOPE] });
        if (res?.accessToken) return { token: res.accessToken, username: res.account?.username || account.username };
      } catch {
        // cache miss / refresh token expired — fall through to device code
      }
    }

    const res = await pca.acquireTokenByDeviceCode({
      scopes: [IMAP_SCOPE],
      deviceCodeCallback: (info) => {
        // info.message is the human-readable "go to <url> and enter <code>" text.
        console.log(`\n🔐 Microsoft sign-in required:\n\n${info.message}\n`);
      },
    });
    return { token: res.accessToken, username: res.account?.username || user };
  }

  let { token, username } = await acquireToken();
  const account = username || user;

  async function connect(accessToken) {
    const client = new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: true,
      // imapflow speaks SASL XOAUTH2 when given an accessToken, i.e. it sends
      // "user=<email>\x01auth=Bearer <token>\x01\x01" for us.
      auth: { user: account, accessToken },
      logger: false,
    });
    await client.connect();
    return client;
  }

  let client = await connect(token);

  async function reconnect() {
    try { await client.logout(); } catch { /* already gone */ }
    const fresh = await acquireToken();
    token = fresh.token;
    client = await connect(token);
  }

  // Pass a getter so the shared fetcher always uses the current (possibly
  // reconnected) client.
  const inner = createImapFetcherFromClient(() => client, {
    name: 'outlook',
    account,
    mailbox,
    readOnly: true,
  });

  // Wrap the network ops with a one-shot reconnect+retry: when the access token
  // expires mid-archive the server drops the connection; we transparently
  // re-acquire a token (silently) and reconnect.
  const withRetry = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (!isReauthError(err)) throw err;
      await reconnect();
      return await fn(...args);
    }
  };

  return {
    ...inner,
    search: withRetry(inner.search),
    getMetadata: withRetry(inner.getMetadata),
    getRaw: withRetry(inner.getRaw),
    async close() {
      try { await client.logout(); } catch { /* ignore */ }
    },
  };
}
