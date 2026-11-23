# Jobs: details from invites, production packs and purchase orders

**Status: built and tested with fakes; not yet run against a live stack.**
The service is `infra/self-hosted/ops/jobs`; how the stack runs it, and what
of that has been checked, is in the stack's README
([The jobs profile](../../infra/self-hosted/README.md#the-jobs-profile)).

The owner receives job invites, production packs and purchase orders by email
and as attachments. This feature reads them as they arrive and keeps the
details that matter on the day (where, when, travel, accommodation, who to
call, the PO) in one place, each linked to the page it came from, so the owner
and the assistant find a detail in seconds instead of searching mail.

**Rule zero: nothing is invented.** The service stores a detail as *found* only
when its own checks find the words in the source, and says exactly that:
found in this document, on this page, not yet confirmed by you. Only the owner
confirms. An estimate or a calculation is only ever shown as one, with what it
is based on. Where the data does not hold an answer, the answer says so.

## What the owner does

- Forwards an email with its attachments to the jobs mailbox, sends a file,
  photo or forwarded message to the SupaMac bot on Telegram, or drops a PDF,
  spreadsheet or image into the **Job intake** folder in SupaMac.
- Gets one Telegram message per source: the job it was filed under, how many
  details were found, what changed (from what to what), and a **Review** button
  that steps through the details that need a look, one at a time, each with its
  quote and page, and Confirm, Reject and Skip.
- Opens the **Jobs** database in SupaMac (shared with the owner) to see every
  job, its details and their sources, and asks the assistant, in SupaMac or on
  Telegram, things like "where am I staying in Leeds?".

## How it works

```
 forwarded email ──┐                             ┌─ Jobs database (SupaMac)
 Telegram file ────┼─► jobs service ─────────────┤   Jobs     one row per job
 Job intake folder ┘   1 record the source       │   Details  one row per detail:
                       2 read its text            │            quote, page, source,
                       3 ask Claude (no tools)    │            status
                       4 check every detail       │   Sources  one row per email
                       5 file under a job, or ask │            or file
                       6 update the Jobs row      │   Status   the service's health
                       │                          └─ Job sources folder: originals
                       └─► Telegram: summary, review, answers   and their text
```

The jobs service is a Bun program in the ops image (`infra/self-hosted/ops/jobs`),
run as its own container in a `jobs` compose profile. It works in SupaMac as
**its own account**, not the owner's (see Security), through the ordinary
storage routes (`POST /documents/upload`, `POST /databases`,
`POST /databases/query`, `/projects`, `/databases/{id}/tables/{id}/changes`).
That account owns the Jobs database and the two folders and shares them with
the owner, so everything is visible and permission-checked like anything made
by hand.

## 1. Sources

| Way in | How it is read | Accepted from |
|---|---|---|
| Jobs mailbox | IMAP over TLS, every minute | Allowed senders whose message passes the mail check below |
| Telegram | Long polling (no public route) | The owner's Telegram account only, in a private chat |
| Job intake folder | Listed every minute | Documents owned by the owner or the service |

**What counts as a source.** An email (with each attachment), a file or photo
sent to the bot, a message forwarded to the bot, `/add <text>`, or a document
in Job intake. **Plain text typed to the bot is a question, never a source.**
Text the owner adds with `/add` is filed as "your note", never as found in a
document, and never replaces a document's value without a confirmation.

**The mail check**, made on the headers alone, before the body is fetched:

1. The message has exactly one From header holding one address, and that
   address (compared case-insensitively) is in `JOBS_MAIL_ALLOWED_SENDERS`.
2. The topmost `Authentication-Results` header carries the authserv-id of the
   mailbox provider (`JOBS_MAIL_AUTHSERV_ID`) and shows `dkim=pass` for a
   domain aligned with the From address. A DMARC or SPF pass alone is not
   enough. With no such header the message is refused.
3. The DKIM signature covers To, and To holds the jobs address, so mail
   signed for someone else cannot be replayed into the mailbox.

A refused message is moved to a `Refused` folder unread and the owner gets a
Telegram note with the sender and the check that failed. The check is only as
strong as the mailbox's password: use a mailbox nothing else uses, with an app
password.

**Telegram.** Updates are accepted only from a private chat whose id equals the
sender's id equals the linked owner id, and only messages and button presses
are requested. The owner links once: on first start with no linked account the
service writes a single-use code into a **Jobs setup** document in the Job
sources folder; the owner sends `/start <code>`. The link is stored, the code
is spent, and every later `/start` is ignored. (`JOBS_TELEGRAM_OWNER_ID` sets
the id directly instead.) Group joins are turned off in BotFather.

**Each source is recorded once.** A Sources row is written first, with status
Processing and the source's content hash, Message-ID and thread references;
a source whose hash is already recorded is not processed again.

## 2. Text

The service extracts text itself, in a child process with a time and memory
limit, so it can check quotes against what it read:

| Kind | Text | Notes |
|---|---|---|
| PDF | per page, in reading order, by line | A page with little or no text layer, or with invisible text over an image, counts as a scan |
| Scan, photo, image (JPEG, PNG, WebP) | none | Read by the model from the image; every detail needs review |
| Word (`.docx`) | paragraphs; tables cell by cell | Hidden text and deleted tracked changes are dropped |
| Excel (`.xlsx`), CSV | each cell as `<column header>: <value>`, with the row's first cell | Hidden sheets, rows and columns are dropped; numbers keep their display format |
| Email | the HTML part as text, else the plain part | Quoted history and forwarded messages become pages of their own, each with its own date |
| Calendar file (`.ics`) | as text | |
| Plain text | as written | How a forwarded message's text arrives; a `.eml` file or a `message/rfc822` part is read as an email |

Accepted attachment types are exactly these; anything else is recorded as
skipped and never parsed. HEIC and HEIF photos are skipped with advice to
send them as JPEG (on an iPhone: Settings, Camera, Formats, Most Compatible)
or as a screenshot: the service has no image decoder to convert them. A zip-based file (docx, xlsx) is refused above 500
entries or 50 MB unpacked, counted while unpacking. A PDF over 600 pages, or a
file over 25 MiB, is processed from its page text only, and the Sources row
says so. Telegram bots cannot receive files over 20 MB; the bot says to email
them instead. Inline images under 20 KB in emails (signatures, logos) are kept
with the email and not sent to the model.

The text is numbered by source and page (`[S2 p3]`). For each PDF, Word and
Excel source the service also stores this text as a Markdown document
`<file> · text`, so the assistant in SupaMac can read it: on this stack it
cannot read those originals itself.

## 3. Extraction

One request per source, to `claude-opus-5-5` (`JOBS_AI_MODEL`) at effort
`high`, through the official Anthropic SDK, with structured outputs
(`output_config.format`) holding the reply to a schema. **The request has no
tools**, so a document can only be read, never obeyed. The PDF itself is sent
only for pages that count as scans; other pages go as text.

The schema asks for:

- what the source is: invite, production pack, purchase order, call sheet,
  travel confirmation, accommodation confirmation, other, or not about a job;
- the jobs it describes (usually one), each with the names, references and
  dates that identify it, and the existing job it may be, with the words that
  show it;
- the source's own date (the original message's date in a forward, or an
  issue or revision date written in the document), with its quote;
- every detail, as `{field, label, value, day?, day_quote?, quote, page}`,
  where `quote` is copied character for character from one line or table cell
  of the source, holding the label and the value.

The prompt says: copy, never infer; leave out anything not written; never
fill a gap from what is usual; keep words such as "TBC", "approx." or "plus
VAT" in the value; one detail per value.

The model's reply is saved before anything else is written, keyed by the
source's hash, so a retry never pays for the same source twice. A refusal,
an answer cut short, or an invalid one sets the source Failed with the reason;
an overloaded or unreachable API keeps it Processing and retries with backoff.
After three failed attempts the source is Failed, the email moves to a
`Failed` folder, and the owner gets one Telegram message with a Retry button.

## 4. Checks

Made by the service on every detail, without the model, against its own
extracted text (never the rendered document). Text is compared after
normalising both sides: Unicode NFKC, case, whitespace within a line, quote
marks and dashes; matches fall on word boundaries; lines are never joined.

1. **The quote is there.** It occurs on the page it names (a paged source must
   name one), and either once on that page or with the same value every time.
   It is at least one label word plus the value.
2. **It names the field.** The quote holds a label word for the detail's field
   from a fixed list (call, load-in or get-in, PO or purchase order or order
   no., rate or fee, hotel or accommodation, ...); for `Other`, the model's
   own label.
3. **The value is in the quote, and nothing more.**
   - A text value is one contiguous run of the quote's words. If the quote
     holds a word that hedges or negates (not, no, without, TBC, TBA, TBD,
     provisional, approx., likely, option, or, subject to, if, unless,
     pending) that the value leaves out, the detail needs review.
   - Dates, times, amounts and references are parsed from the value and from
     the quote, and must agree. The quote must hold exactly one of that kind.
     Only what is written counts: a date's missing year, a time's missing
     am/pm, an amount's missing currency are never filled in. A completion the
     same page states in full is allowed and named in Check ("year from p1");
     any other completion needs review. A numeric date that reads two ways
     (03/04) needs review unless the same source writes that date with the
     month in words. A bare number is never a time. A weekday that is given
     must agree with the date. Tax words stay in the value.
4. **The day is written.** It is in the quote, or the model gives a
   `day_quote` that is the nearest date heading above the quote on the same
   page, with no other date between them. A relative day ("Day 2", "the
   following day") needs review, with the calculation shown as a calculation.

A detail passing every check is **Found**. Any other is **Needs review**, with
the check that failed in its Check column. A detail read from an image or a
scan, or from a PDF's text layer that does not match what the page shows, is
always Needs review, and its review card carries the page image and the line
"read by the model from an image; no text was checked".

**Confirmed and Rejected** come only from the owner: a Review button press on
Telegram, or the owner's own edit in SupaMac (see Edits in SupaMac). A detail
that equals one the owner rejected (same job, field, day and value) is stored
Needs review with "you rejected this on <date>".

Every surface words Found as what it is: "found in <source>, p<n>, not
confirmed by you". The Jobs row marks which of its values are not confirmed.

## 5. Filing under a job

The service files a source under an existing job by itself only when:

- it carries a Found PO number or job reference of at least five characters,
  one of them a digit, equal to one on that job, and the same client (a Found
  client, or the original sender's domain); or
- it is a reply in a thread already filed under that job (its References
  chain holds a filed Message-ID) and it names no dates the job does not have.

An attachment files with its email unless its own references conflict.
Anything else, including a match the model proposes, becomes a question on
Telegram ("File under <job>?" with Yes and New job), and its details do not
touch any Jobs row until the owner answers. A travel or accommodation
confirmation never starts a job by itself. A source that describes several jobs
waits for the owner.

## 6. The Jobs row

Each column has one rule, over Found and Confirmed details only:

| Column | Rule |
|---|---|
| Venue, Venue address, Client, Production company, Event, Role, PO number, Job reference, Payment terms, Invoice to | The value of the newest detail of that field |
| Dates | Only from one quote that states a contiguous range; otherwise empty, and the days go in Days |
| Days | Every day a detail names, as a list |
| Call times | "day: value" for every Call time detail |
| Travel | Every Travel detail, by day |
| Accommodation | Hotel, with Check-in and Check-out |
| Contacts | Every Contact detail |
| Rate, Currency, Rate basis | Rate from its detail; Currency and basis only from the Rate quote's own symbol or code and its "/day", "per hour" or "flat"; otherwise empty |
| Not confirmed | The columns whose value rests on a Found detail the owner has not confirmed |
| Needs review | The number of details awaiting review |
| Booking | Written by the owner only (Enquiry, Pencilled, Booked, Completed, Cancelled); empty on a new job |

**Newer means the source's own date**, never processing order. A value
replaces another only within the same job, field, day and label, only for a
single-valued field, and only when its source is dated later. When the order
is unknown, both values stay, the newer one needs review, and the cell shows
both. A value from quoted history never replaces one from a later message.
Contacts, travel, nights and call times accumulate. A value that would replace
one the owner confirmed, and any change to Rate, Per diem, Payment terms,
Invoice to or Booking reference, waits for review and is shown as "07:00
(confirmed); a newer source says 08:00, not confirmed".

The service writes a Jobs cell only when it is empty or still holds what the
service last wrote; a value the owner typed stays, and the summary says a
source disagrees.

## The Jobs database

Owned by the service's account and shared with the owner with edit access.
Created on the first run with the tables, columns and saved views below; their
ids are pinned in the service's state and names are only used on that first
run, so renaming a column or table is safe. If the pinned database is missing
or trashed the service stops and says so; it never creates a second one.

**Jobs**: Name (title), Booking (select), Dates (date range), Days, Client,
Production company, Event, Role, Venue, Venue address, Call times, Travel,
Accommodation, Contacts, PO number, Job reference, Rate (number), Currency,
Rate basis, Payment terms, Invoice to, Not confirmed (tags), Needs review
(number), Updated (date). Views: Timeline (Dates), Board (Booking).

**Details**: Name (title: "Field: value", starting "Unconfirmed · " unless
Found or Confirmed), Job (relation), Source row (relation), Field (select),
Label, Value, Day (date), Quote, Source (document), Page (number), Status
(select: Found, Needs review, Confirmed, Rejected, Replaced), Check, Received
(date). View: Needs review.

**Sources**: Name (title), Document (document), Text (document), Kind (select),
Via (select: Email, Telegram, Folder, Note), From, Sent (date: the source's own
date), Received (date), Job (relation), Status (select: Processing, Processed,
Needs review, Not a job, Skipped, Failed), Hash, Message ID, Thread IDs,
Attempts (number), Input tokens, Output tokens (numbers), Note. View: Problems.

**Status**: one row: last mail check, last Telegram poll, last change poll,
last error, AI spend this month (computed from token counts at the configured
prices, labelled as computed).

Dates are calendar dates in the owner's time zone (`JOBS_TIME_ZONE`, default
`Europe/London`, changed on the go with `/tz`). Times are kept as written, as
text, and always reported as written in the source (venue local time); a
converted time is only shown as an estimate naming the zone it assumes.

## Edits in SupaMac

Every minute the service reads each table's changes since the version it last
saw (`/changes`), skipping the versions its own writes produced. Row history
says who made each change and whether an agent acted for them:

- **The owner, with no agent**: a Status set to Confirmed or Rejected is
  recorded as the owner's decision; a changed Value, Quote or Day is the
  owner's value ("entered by you"), and the job is recomputed.
- **An agent** (the assistant, a routine): a Status change is undone and a
  value change is set Needs review with "changed by the assistant"; the owner
  is told on Telegram. Documents can carry instructions; only the owner
  decides.

Row history names an agent only when the assistant writes through its own
tools. A program the assistant runs in code mode, or a routine's code step,
uses the owner's credentials and is recorded as the owner. So a status set in
SupaMac counts as **confirmed in SupaMac**, not as confirmed on Telegram, and
the next Telegram summary lists every detail confirmed or rejected in SupaMac
since the last one, so a change the owner did not make shows up. Only a Review
button press is certain to be the owner.

Before acting on a Review button the service re-reads the detail; if it
changed in SupaMac, the button reports its current state instead.

## Asking

**On Telegram** a question goes to Claude (`JOBS_AI_MODEL`, effort `medium`)
with three fixed tools that the service turns into its own queries over the
pinned tables: `jobs(from?, to?, name?)`, `details(job, field?, day?)` and
`source_text(source)`. The model never writes SQL and reads nothing outside the
Jobs database. Every query is narrowed by job or status, and a result the
server reports as partial is answered as partial.

The answer comes back as statements, each a set of detail ids with connecting
words. The service writes every value itself, verbatim from its detail, with
its status and source ("the call sheet, p2, says 'Crew call 07:00'; not
confirmed by you"); the model never types a value. A replaced or rejected
detail is shown only as "was ...". Any other text the model adds is shown as
"(not checked)", and a number or date in it is refused unless it is labelled
as an estimate with its basis. "Nothing found" is decided by the service from
the query results, and the answer always lists details awaiting review and
failed sources for that job. "Today", "tomorrow" and weekdays are worked out by
the service in the owner's time zone. Links in an answer are dropped unless
they appear verbatim in a cited detail, and messages are sent with link
previews off.

**In SupaMac** the assistant reads the Jobs database with its SQL tool and the
`· text` documents with its document tools. The setup document asks the owner
to add one line to their SupaMac memory: read job details from the Jobs
database, quote the source and status of each, and call anything that is not
Confirmed unconfirmed. **These answers are not checked by the service.**

## Security

- **Its own account.** The service signs in as the jobs mailbox's own SupaMac
  account (added to the sign-up allow-list), and holds that account's API key.
  The key reaches only what that account owns or is shared: the Jobs database
  and its two folders, not the owner's mail, CRM or documents.
- **Its own container and secrets.** It reads only `/etc/supamac/jobs.env`
  (optional, so the stack deploys without it) and refuses to start if the
  stack's internal key or database URL is in its environment. It runs as a
  non-root user with a read-only root, no capabilities, no new privileges, a
  process and memory limit, and one state volume. It reaches SupaMac through
  the gateway, never a service directly, on a port of its own that serves
  the storage API and its object links and nothing else, and that takes no
  `X-Forwarded-For` from it, so the services see its own address. It
  reaches the internet only through an egress proxy (`jobs-egress`,
  `infra/self-hosted/ops/src/egress-proxy.ts`) on a network with no other
  way out, whose bridge has no address, so nothing listening on the server
  itself is reachable either. The proxy opens a tunnel only for
  `CONNECT` to `api.anthropic.com:443`, `api.telegram.org:443` and the
  mailbox's host and port, resolves the name itself and refuses one whose
  address is private, loopback or link-local; it gets no secret.
- **Documents are data.** Extraction has no tools; questions have only the
  three read-only tools; nothing the service does sends mail, accepts work,
  shares, or deletes.
- **Hostile files.** Parsing runs in a child process with limits and an
  empty environment, on the type allow-list above; PDF.js runs with
  `isEvalSupported: false`; XML is parsed with entities off. The child runs
  as the service's user, and the service makes itself not dumpable before it
  starts any, so a parser that is made to run code cannot read the
  service's environment, which holds its keys, or its memory through
  `/proc`. It still shares the service's network and state volume.
- **Spending.** A dedicated Anthropic key (in its own Console workspace with a
  monthly limit is best), token counting before each request, `max_tokens` on
  every request, a cap on tool rounds per question, and
  `JOBS_MONTHLY_LIMIT_USD`: above it the service stops calling the model and
  says so.
- **The bot token** is masked in every log line, files are downloaded by the
  service and never linked, and a second poller (HTTP 409) or a webhook set on
  the bot stops the service with a message to revoke the token.
- **SQL** is built by the service only: one literal function (quotes
  doubled, NUL and unpaired surrogates removed), batches under 256 KiB,
  `databaseId` always set, no identifiers or select options taken from model
  output.

## Settings

`/etc/supamac/jobs.env`, read only by the jobs container, each setting
saved with `add_secret jobs` (the stack's README, Adding third-party keys):

| Setting | What |
|---|---|
| `JOBS_SUPAMAC_API_KEY` | The jobs account's API key (created in SupaMac, Settings, API keys, signed in as that account) |
| `ANTHROPIC_API_KEY` | An Anthropic key for this service |
| `JOBS_AI_MODEL` | `claude-opus-5-5` unless set |
| `JOBS_MONTHLY_LIMIT_USD` | The AI spend at which the service stops |
| `JOBS_AI_FALLBACKS` | `on` unless set: a request the model declines is answered by a fallback model |
| `JOBS_AI_FALLBACK_MODELS` | The fallback models the spending check counts (each one can bill); fewer hold back less of the limit |
| `JOBS_AI_PRICES` | Optional: the prices the cost and the monthly limit are computed with, as JSON from model id to `{"input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"}` in USD per million tokens (`cacheWrite1h` is twice `input` unless given). It replaces the built-in table, which prices the default model and its fallbacks; a model it does not list is priced at the highest price it holds. Set it when `JOBS_AI_MODEL` names another model or the prices change |
| `JOBS_TELEGRAM_BOT_TOKEN` | From BotFather |
| `JOBS_TELEGRAM_OWNER_ID` | Optional: the owner's numeric Telegram id, instead of the link code |
| `JOBS_MAIL_USER`, `JOBS_MAIL_PASSWORD` | The jobs mailbox's login |
| `JOBS_MAIL_AUTHSERV_ID` | The provider's name in its `Authentication-Results` headers |
| `JOBS_MAIL_ALLOWED_SENDERS` | The addresses whose forwards are read |
| `JOBS_OWNER_EMAIL` | The owner's SupaMac account, to share the database and folders with |
| `JOBS_TIME_ZONE` | `Europe/London` unless set |

A way in whose settings are missing is off; the Status row says which.

The mailbox's host and port are not in `jobs.env`: they are the deploy
variables `SUPAMAC_JOBS_MAIL_HOST` and `SUPAMAC_JOBS_MAIL_PORT` (993 unless
set), which `compose.yaml` hands to the service as `JOBS_MAIL_HOST` and
`JOBS_MAIL_PORT` and to the egress proxy as its third allowed pair, so the
proxy needs no file of secrets. `compose.yaml` also sets the wiring:
`JOBS_SUPAMAC_URL` (`http://gateway:8081/dss`), `JOBS_WEB_APP_URL` (the UI's
origin and folder), `JOBS_STATE_DIR`, `JOBS_HEALTH_PORT`, `HTTPS_PROXY` and
`NO_PROXY`. A name set there wins over `jobs.env`.

## Setup

1. Create the jobs mailbox with an app password, at a provider that writes
   `Authentication-Results`. The address you forward from must be on a
   domain that signs its mail (DKIM) and publishes a DMARC record (`p=none`
   is enough); Gmail and Outlook addresses do.
2. Create the bot with BotFather and turn its group joins off.
3. Add the mailbox address to the sign-up allow-list, sign in to SupaMac as it
   (the sign-in code arrives in that mailbox), and create an API key.
4. Put the settings in `jobs.env` with `add_secret jobs`; in the deploy
   tool set `SUPAMAC_JOBS_MAIL_HOST` (and `SUPAMAC_JOBS_MAIL_PORT` unless it
   is 993) and add `jobs` to `COMPOSE_PROFILES`; redeploy.
5. Open **Jobs setup** in the shared Job sources folder: it lists a check of
   each setting (SupaMac key, mailbox login, Telegram, Anthropic) and the link
   code. Send `/start <code>` to the bot.
6. Forward a test email and see its summary arrive.

## Operations

- **State**: the `jobs_state` volume (`supamac_jobs_state`) holds the Telegram link and offset, the
  pinned ids, the last table versions, the saved model replies, the attempt
  counts, and what the checks need about each detail and source that has no
  column (its source's own date, whether it came from quoted history, a note
  or the owner, when the owner decided, the page kind, the day quote). It is
  in the backup and restore scripts; a backup from before the service
  restores it empty. The dedupe keys also live in Sources rows, so they
  survive in the database backup.
- **Restarts**: every Processing source resumes from what its rows show;
  details of one source are written in one statement; a Telegram update is
  acknowledged only after it is handled, and its id is recorded so a repeat is
  ignored. A stop waits for an extraction in flight, and compose gives it
  five minutes: one still streaming then is cut, and its source is asked
  again, and paid for again, at the next start. The service starts once the
  storage service behind the gateway is healthy.
- **Health**: `/health` for the compose healthcheck: 503 while any loop (the
  ways in, the folder, edit and resume polls, the Status tick) has not
  succeeded for five of its intervals, with each loop's last success and
  error in its body; the Status row, which cannot be written while SupaMac
  is down, when the body and the service's log say which loop failed; a
  Telegram note (at most hourly) when the mailbox, Telegram, SupaMac or
  Anthropic stops answering, and another when it recovers.
- **Memory**: 640 MB limit as an estimate, one source at a time: about 85 MB
  for the service, up to 384 MB for its extraction child (read every 25 ms,
  so it can pass that before it is stopped), the source and its copy for the
  child, and the health check's own process; 128 MB for the egress proxy.
  Measured at the next rehearsal.
- **Cost**: computed per source from its token counts and the configured
  prices, and totalled monthly on the Status row. As an estimate, at $4 per
  million input and $20 per million output tokens: a 40-page pack sent as text
  is in the order of 30,000 input tokens (about $0.12), and the reply with its
  thinking 5,000 to 20,000 output tokens ($0.10 to $0.40). Scanned pages cost
  more, because they go as images.

## What it does not do

- It never sends email, accepts or declines a job, changes a calendar,
  shares beyond the owner, or deletes; a rejected detail stays, marked Rejected.
- It does not read the owner's inbox, only what is forwarded or sent.
- It has no OCR: details from scans and photos always wait for review.
- It does not convert HEIC or HEIF photos: it skips them and asks for a JPEG
  or a screenshot.
- On this stack a `.docx` cannot be dropped into Job intake from the browser,
  and a `.docx` original cannot be opened in SupaMac: forward Word files by
  email or Telegram; their text document is the source, and the original stays
  in the service's state.

## Privacy

Sources go to Anthropic to be read; Telegram messages and files pass through
Telegram's servers. Questions asked in SupaMac go to whichever model that chat
uses: choose an Anthropic model for job questions there. Nothing else leaves the
server.
