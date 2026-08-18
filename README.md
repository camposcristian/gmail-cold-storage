# gmail-cold-storage

> Move old email to cheap S3-compatible cold storage. Keep a searchable index. Cancel Google One. Redirect the savings to your AI token budget.

A typical 10-year Gmail account carries **20–60 GB** of emails, most of it receipts, newsletters, CI notifications, 2016 conversation threads, and bank PDFs you haven't opened since. Gmail bills that at **Google Drive rates** — a 2 TB Google One subscription (~$10 USD / $15 AUD per month, $120–180 / year) to store data you actually touch maybe 20 times a year.

S3-compatible object storage is **50–100× cheaper** for the same data, and several providers offer **free egress** — so opening an archived email later doesn't cost you a cent. This repo is the methodology + scripts + cost math for making the switch.

---

## The idea

```
┌──────────────┐   1. fetch raw .eml      ┌──────────────────┐
│              │ ──────────────────────▶  │                  │
│  Email (IMAP)│   2. upload to S3        │  S3-compatible   │
│  or Gmail API│                          │  cold storage    │
└──────────────┘                          │  (any provider)   │
                                          └───────┬──────────┘
                                                  │
                                                  ▼
                                          ┌──────────────────┐
                                          │  index.db        │
                                          │  (SQLite + FTS5) │
                                          │  search locally  │
                                          └──────────────────┘
```

1. Fetch old emails via IMAP, the Gmail API, or Outlook OAuth2 as raw `.eml` — mime-preserving, attachments intact.
2. Upload each one to an S3-compatible bucket at `emails/gmail/YYYY/MM/<msgid>.eml`.
3. Build a SQLite index with FTS5 full-text search (subject, from, to, snippet) for fast local search.
4. Only after upload succeeds, optionally delete from Gmail (Gmail API mode only).
5. Serve the archive through **[email-archive](https://github.com/camposcristian/email-archive)** — a viewer app that reads the bucket on demand.

---

## Why this costs almost nothing

| Service | 10 GB/month | 100 GB/month | Egress |
|---|---|---|---|
| **Google One** (min. 100 GB tier) | $1.99 | $1.99 | free |
| **Google One 2 TB** | — | — | $9.99/mo |
| **Backblaze B2** | **$0.06** | **$0.60** | **free** (up to 3× storage) |
| **Cloudflare R2** | $0.15 | $1.50 | **free** (always) |
| **AWS S3 Standard** | $0.23 | $2.30 | $0.09/GB |
| **S3 Glacier Deep Archive** | $0.01 | $0.10 | 12 h restore + fees |
| **MinIO** (self-hosted) | free | free | free |

At typical email archive sizes (20–200 GB), any S3-compatible provider beats Google One by **50–100×**. B2 is the cheapest hosted option; R2 has unlimited free egress; Glacier is cheapest at rest but you pay every time you fetch a message.

### Worked example (40 GB account, 10-year history)

A 40 GB Gmail account paying for Google One 2 TB vs moving old mail to an S3 bucket and dropping to the free 15 GB tier:

| | Google One 2 TB | S3 cold storage (R2) | S3 cold storage (B2) |
|---|---|---|---|
| Storage for 40 GB | ~$120–180/yr | **$7.20/yr** | **$2.88/yr** |
| Egress when you look something up | free | **free** | **free** (up to 3×) |
| Search | Gmail UI | FTS5 full-text across every field |
| Attachment retrieval | via Gmail | direct `.eml` download |

**Net savings: ~$115–175/year, forever.** That's a lot of AI tokens.

The index is also better than Gmail's own search — subject, from, to, snippet, date, size, labels — all FTS5-indexed in SQLite, works offline, no operators to memorize.

---

## Finding cleanup targets

Not every email is worth archiving — some are worth deleting outright. Gmail's search operators are your friend:

### By size + age (biggest wins)
```
larger:10M older_than:3y              # big ones you haven't touched in years
has:attachment larger:25M             # the real whales
from:noreply@* has:attachment older_than:2y   # newsletter media
```

### By category
```
category:promotions has:attachment older_than:1y
category:social has:attachment
label:^all older_than:10y             # old everything
```

### By specific heavy senders
```
from:(linkedin.com OR facebookmail.com) older_than:1y
from:*@amazon.com subject:(shipped OR delivered) older_than:2y
```

### Before you delete, ask yourself
- Would I want to read this in 5 years?  → **archive**
- Would I want this to show up in a future legal discovery? → **archive**
- Is this a notification I already acted on?  → **delete**
- Is this a receipt for something I still own or might return? → **archive**

When in doubt, archive. Object storage is cheap enough that "save everything" is a valid strategy.

---

## Setup (5 minutes)

### 1. Configure via `.env`

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

**S3 config (required)**

```dotenv
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com   # see provider examples below
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
S3_BUCKET=your-bucket-name
S3_REGION=auto          # use 'auto' for R2, 'us-east-1' for AWS, etc.
EMAIL_PREFIX=emails/gmail
```

S3_ENDPOINT is what switches between providers — any S3-compatible service works:
- **Backblaze B2**: `https://s3.<region>.backblazeb2.com` — cheapest hosted option
- **Cloudflare R2**: `https://<account-id>.r2.cloudflarestorage.com` — free egress
- **AWS S3**: omit (defaults to AWS) — most familiar, priciest egress
- **MinIO**: `http://localhost:9000` — free, self-hosted

**IMAP config (default fetcher)**

```dotenv
FETCHER=imap
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=you@gmail.com
IMAP_PASS=your-app-password
```

**Gmail API config (optional, for `--delete-archived`)**

```dotenv
FETCHER=gmail-api
GOOGLE_CREDENTIALS_PATH=./credentials.json
GOOGLE_TOKEN_PATH=./token.json
```

**Outlook / Microsoft personal config (OAuth2 device-code)**

```dotenv
FETCHER=outlook
OUTLOOK_USER=you@outlook.com
OUTLOOK_TOKEN_PATH=./outlook-token.json   # cached token, auto-refreshed
OUTLOOK_MAILBOX=INBOX
EMAIL_PREFIX=emails/outlook               # keep providers in separate prefixes
```

### 2. Get an app password for IMAP

IMAP is the default and recommended mode — no OAuth dance, no API console. You need an **app password** (not your normal login password):

- **Gmail**: go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), create one for "Mail". Use host `imap.gmail.com:993`.
  - Note: 2-Step Verification must be enabled on your Google account first.
- **Fastmail**: Settings → Privacy & Security → App Passwords. Use host `imap.fastmail.com:993`.
- **Outlook / Hotmail / Microsoft personal**: app passwords and basic auth are **dead** for personal Microsoft accounts — IMAP now requires OAuth2. Don't use the `imap` fetcher for these; use the dedicated `outlook` fetcher instead (see [Outlook / Microsoft personal mode](#outlook--microsoft-personal-mode) below).

### 3. Install dependencies

```bash
npm install
```

---

## CLI reference

```bash
# Dry run — count what'd be archived, estimate total size (default)
node archive.mjs

# Archive to S3 (idempotent — skips already-archived by id)
node archive.mjs --archive --query="older_than:5y"

# Full-text search the local index
node archive.mjs --search="rental agreement"

# Rebuild local index.db from what's already in the bucket
node archive.mjs --rebuild-index

# Permanently delete everything already in S3 from Gmail
# (requires FETCHER=gmail-api and full Gmail scopes)
node archive.mjs --delete-archived
```

### Typical workflow

1. Dry run to see what would be archived:
   ```bash
   node archive.mjs --query="older_than:5y"
   ```

2. If the numbers look right, archive:
   ```bash
   node archive.mjs --archive --query="older_than:5y"
   ```

3. Verify the archive with a search:
   ```bash
   node archive.mjs --search="invoice"
   ```

4. Once confident, delete from Gmail (Gmail API mode only):
   ```bash
   node archive.mjs --delete-archived
   ```

### Safety notes

- The script is **idempotent** — the index tracks archived IDs, re-running won't re-upload.
- `--delete-archived` requires `FETCHER=gmail-api` — IMAP deletion is not implemented. Manage deletes via your email client if needed.
- `batchDelete` is **permanent** — not trash, it's gone. Only run `--delete-archived` after you've verified the archive.
- Always start with `--query` narrower than you think (`older_than:10y` first, then `5y`, etc.).
- Keep the local `.archive-staging/index.db` — it's your manifest. Back it up.

---

## Gmail API mode

IMAP covers 99% of use cases. The Gmail API mode exists for two reasons:
1. You want `--delete-archived` to permanently remove from Gmail after archiving.
2. You prefer OAuth over app passwords.

Setup:
1. Go to [Google Cloud Console](https://console.cloud.google.com/), enable Gmail API, create an OAuth 2.0 client (Desktop app), download `credentials.json`.
2. Set `FETCHER=gmail-api` in `.env`.
3. The script requests least-privilege scopes by mode:
   - `--archive` / dry-run / `--search` → `gmail.readonly`
   - `--delete-archived` → `https://mail.google.com/` (full access, required for `batchDelete`)
4. First run opens a browser for the OAuth flow; `token.json` is saved for subsequent runs.

---

## Outlook / Microsoft personal mode

For **Outlook.com / Hotmail / Live** (personal Microsoft accounts), Microsoft has
**killed basic auth and app passwords** — IMAP now *requires* OAuth2. The plain
`imap` fetcher will just fail to authenticate. Use `FETCHER=outlook` instead.

This mode uses the **OAuth2 device-code flow**, so it works headless and never
handles your password:

1. Set in `.env`:
   ```dotenv
   FETCHER=outlook
   OUTLOOK_USER=you@outlook.com
   EMAIL_PREFIX=emails/outlook
   ```
2. Run any command (`node archive.mjs`, `--archive`, etc.). On first run it prints:
   ```
   🔐 Microsoft sign-in required:

   To sign in, use a web browser to open https://microsoft.com/devicelogin
   and enter the code XXXXXXXX to authenticate.
   ```
3. Open that URL on any device, enter the code, approve access. Archiving then
   proceeds automatically.
4. The token (access + refresh) is cached to `OUTLOOK_TOKEN_PATH`
   (`./outlook-token.json` by default) and **refreshed silently** on later runs
   and mid-archive, so long archives don't break at the ~60 min token expiry.

Details:
- **Client**: uses Thunderbird's public `client_id`
  (`9e5f94bc-e8a4-4e73-b8be-63364c29d753`), which is approved for personal
  accounts and the `IMAP.AccessAsUser.All` scope — **no Azure app registration
  of your own is needed**.
- **Authority**: `login.microsoftonline.com/consumers` (personal accounts).
- **IMAP**: `outlook.office365.com:993`, SASL `XOAUTH2`.
- **Non-destructive**: same as every other mode — mailboxes are opened
  **read-only** and messages fetched with `BODY.PEEK[]`, so nothing is marked
  read or modified.
- `--delete-archived` is **not** supported for Outlook (read-only by design);
  delete from your mailbox via your own client if you want.

Everything downstream (raw `.eml` upload, `index.db` shape, search, rebuild) is
identical to the Gmail path — the viewer reads an Outlook archive unchanged.

---

## Migrating from v1

v1 stored an `index.json` flat file. v2 uses SQLite with FTS5. To migrate:

```bash
node migrate-json-to-sqlite.mjs
```

This reads `.archive-staging/index.json` and imports all records into `index.db`. The old JSON file is left in place.

---

## The viewer

Raw `.eml` files in a bucket are useless without a way to read them. The companion project is **[email-archive](https://github.com/camposcristian/email-archive)** — a Cloudflare Pages app that points at your S3 bucket and gives you:

- **Index listing** — all archived emails, sortable by date / from / subject / size, with deterministic color pills per sender domain
- **Instant client-side search** across subject, from, to, snippet
- **Sender-domain stats bar** — top domains as clickable filters
- **Full email reader** — parsed HTML body, inline CID images resolved, text fallback, attachment list
- **Per-attachment download** — click to download any single attachment without fetching the whole `.eml`
- **Raw `.eml` download** — if you want the original message-as-sent
- **Dark mode** — follows `prefers-color-scheme`
- **Self-hosted, gated** — deploy behind Cloudflare Access so only you can read

Stack: React + Vite + Tailwind SPA + Pages Functions + [`postal-mime`](https://github.com/postalsys/postal-mime) for server-side parsing.

### DIY viewer API shape

If you'd rather roll your own, here's the API contract email-archive exposes:

```
GET /api                                     → index.db from bucket (SQLite)
GET /api/email/emails/gmail/YYYY/MM/id.eml   → parsed {subject, from, html, attachments, ...}
GET /api/email/.../?raw=1                    → raw .eml download
GET /api/email/.../?attachment=N             → individual attachment download
```

Costs: Pages free tier, bucket reads are <$0.01/month for a single user.

---

## Alternatives considered

- **Takeout + local disk** — one-shot export works but you lose any structure, no search, have to maintain the disk.
- **Fastmail / ProtonMail migration** — solves the storage-price problem by moving to a provider that doesn't charge Drive rates, but you still have all the email in a single provider. Good if you're leaving Gmail entirely — orthogonal to this (you can still cold-storage the Gmail history before migrating).
- **imapsync + own IMAP server** — overkill for a read-only archive; a static object store is simpler.
- **Google Takeout + Glacier** — cheaper per GB at rest, but Glacier retrieval fees + 12h restore time make the viewer experience terrible.

S3-compatible storage hits the sweet spot: near-free storage, free or cheap egress, instant retrieval, searchable, scriptable.

---

## License

MIT. Do what you want. If this saved you a Google One subscription, open an issue — always curious how much people rescue.
