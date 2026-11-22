# Jobs: details from invites, production packs and purchase orders

**Status: design under review. Nothing described here is built yet.**

The owner receives job invites, production packs and purchase orders by email
and as attachments. This feature reads them as they arrive and keeps the
details that matter on the day (where, when, travel, accommodation, who to
call, the PO) in one place, each detail linked to the page it came from. The
owner and the assistant then find a detail in seconds instead of searching
mail and attachments.

Rule zero: **nothing is invented.** A detail is stored as checked only when the
server finds the words it came from in the source. Everything else waits for
the owner. An estimate or projection is only ever written as one, with what it
is based on.

## What the owner does

- Forwards an email (with its attachments) to the jobs mailbox, sends a file,
  photo or text to the SupaMac bot on Telegram, or drops a file into the
  **Job intake** folder in SupaMac.
- Gets a Telegram summary: the job it was filed under, the details checked,
  and the details that need a look, each with Confirm and Reject buttons.
- Opens the **Jobs** database in SupaMac to see every job, its details and
  their sources, and asks the assistant (in SupaMac or on Telegram) things like
  "where am I staying in Leeds?" or "what time is load-in on the 14th?".

## How it works

```
 forwarded email ─┐                         ┌─ Jobs database (SupaMac)
 Telegram file ───┼─► jobs service ─────────┤    Jobs    one row per job
 Job intake folder┘    │  1 store the source │    Details one row per detail,
                       │  2 read its text    │            with quote, page,
                       │  3 ask Claude for   │            source and status
                       │    details + quotes │    Sources one row per email
                       │  4 check each quote │            or file received
                       │    against the text └─ the source files, as documents
                       │  5 file under a job
                       └─► Telegram summary, review buttons, answers
```

The jobs service is a Bun program in the ops image (`infra/self-hosted/ops/jobs`),
run as its own container. It acts in SupaMac as the owner through a user API
key and the ordinary storage routes (`POST /documents/upload`,
`POST /databases/query`), so everything it writes is visible, editable and
permission-checked like anything the owner makes by hand, and the assistant
reads it with the tools it already has.

### 1. Sources

| Way in | How it is read | Who is accepted |
|---|---|---|
| Jobs mailbox | IMAP, checked every minute; a processed message moves to a `Processed` folder, a refused one to `Refused` | Senders on `JOBS_MAIL_ALLOWED_SENDERS`, and only when the receiving server's `Authentication-Results` shows DMARC, or DKIM aligned with the From domain, passing |
| Telegram | Long polling (no public route) | The one Telegram account linked with the link code; every other update is dropped unread |
| Job intake folder | The service lists the folder every minute and processes documents it has not seen | The owner (it is the owner's folder) |

Each source is stored once, by content hash. An email becomes a Markdown
document holding its headers and text, beside each attachment uploaded as its
own document. Every source gets a row in **Sources**.

### 2. Text

The service extracts text itself, so it can check quotes against it:

| Kind | Text | Sent to Claude as |
|---|---|---|
| PDF with a text layer | per page | the page texts, plus the PDF itself |
| Scanned PDF, photo, image | none | the PDF or image only |
| Word (`.docx`) | paragraphs and tables | the text |
| Excel (`.xlsx`), CSV | cells, sheet by sheet, row by row | the text |
| Email | the plain text part, or the HTML converted to text | the text |

The text sent is numbered by source and page (`[S2 p3]`), so a quote can
point at where it came from.

### 3. Extraction

One request per source, to `claude-opus-5-5` (setting `JOBS_AI_MODEL`) at
effort `high`, through the official Anthropic SDK, with structured outputs
(`output_config.format`) holding the reply to a schema. The request has no
tools: a document cannot make the model do anything but answer. The schema
asks for:

- what the source is (invite, production pack, purchase order, call sheet,
  travel or accommodation confirmation, other, not about a job);
- the job it describes: names, references, PO numbers and dates that identify
  it, and which of the owner's existing jobs it matches, if any, with the words
  that show it;
- every detail found, each as `{field, value, day?, quote, source, page?}`,
  where `quote` is copied character for character from the source and `value`
  is no more than the quote says.

The prompt says: copy, never infer; leave out anything not written in the
source; never fill a gap from what is usual; a detail that is only implied is
left out. The list of fields is fixed (below); a detail that fits none is
`Other` with its own label.

A refusal (`stop_reason: "refusal"`) or an answer cut short is recorded on the
source's row as failed, with the reason, and the owner is told. Nothing is
saved from it.

### 4. Checks

Run by the service on every detail, without the model:

1. **The quote is in the source.** After normalising both (Unicode NFKC,
   case, whitespace, quotes, dashes), the quote must occur in the text of the
   source it names, on the page it names when it names one.
2. **The value is in the quote.** Dates, times, amounts and references are
   parsed from the value and must be parsed from the quote too, to the same
   result. A text value's words must all appear in the quote, so the model can
   shorten a quote into a value but not add to it.
3. **The day, if given, is written in the source** (on the same page, or in
   the quote).

A detail passing all three is stored **Checked**. Any other is stored **Needs
review**, with what failed. A detail read from an image or a scan has no text
to check against and is always **Needs review**. Only the owner moves a detail
to **Confirmed** or **Rejected**.

### 5. Filing under a job

A source joins an existing job when one of these is true, checked by the
service:

- it is a reply in an email thread already filed under that job;
- a checked PO number or job reference equals one already on that job;
- the model named that job, its quote passes the checks, and the dates overlap.

Otherwise it starts a new job. When the model names a job the checks do not
support, the source starts a new job and its row says which job it may
duplicate, for the owner to merge.

The **Jobs** row shows, for each field, the value from the newest Checked or
Confirmed detail; a detail awaiting review never reaches it. When a newer
source changes a value (a call time moved), the older detail becomes
**Superseded** and the Telegram summary says what changed, from what to what,
and where.

## The Jobs database

One database named **Jobs**, owned by the owner, created by the service on its
first run. The service finds it again by name and checks its tables and
columns before writing; it adds what is missing and never removes or retypes
anything the owner added.

**Jobs**: Name (title), Status (select: Enquiry, Pencilled, Confirmed,
Completed, Cancelled), Dates (date range), Client, Production company, Event,
Role, Venue, Venue address, Call times, Travel, Accommodation, Contacts, PO
number, Job reference, Rate, Currency, Rate basis, Payment terms, Needs review
(number of details awaiting review), Updated (date).

**Details**: Name (title, "Field: value"), Job (relation to Jobs), Field
(select), Value, Day (date), Quote, Source (document), Page (number), Status
(select: Checked, Needs review, Confirmed, Rejected, Superseded), Check (what
the checks found), Received (date).

**Sources**: Name (title: subject or file name), Document (document), Kind
(select), Via (select: Email, Telegram, Folder), From, Received (date), Job
(relation to Jobs), Status (select: Processed, Needs review, Not a job,
Failed), Note.

The fields a detail can have: Event, Client, Production company, Role, Job
reference, PO number, Dates, Venue, Venue address, Access and parking, Call
time, Load-in, Show time, Load-out, Finish, Travel, Travel booked by, Hotel,
Hotel address, Check-in, Check-out, Booking reference, Per diem, Rate,
Overtime, Payment terms, Invoice to, Contact, Dress code, Catering, Kit to
bring, Credentials and passes, Health and safety, Other.

## Asking

The assistant in SupaMac reads the Jobs database with the SQL tool it already
has, and the source documents with its document tools; its instructions say
to state a detail with its source and status, and to call anything that is not
Checked or Confirmed unconfirmed.

On Telegram, a question goes to Claude with read-only tools over the same data
(a `SELECT` on the Jobs database, the text of one source). The answer comes
back as statements, each naming the details it rests on. The service checks
each statement against those details before sending it: a statement whose
details do not say it is sent marked as unchecked. An estimate is sent only
labelled as one, with what it is based on. When the data does not hold the
answer, the answer says so.

## Settings

In `/etc/supamac/jobs.env`, read only by the jobs container:

| Setting | What |
|---|---|
| `JOBS_SUPAMAC_API_KEY` | A user API key the owner creates in SupaMac (Settings, API keys) |
| `ANTHROPIC_API_KEY` | The Anthropic key |
| `JOBS_AI_MODEL` | `claude-opus-5-5` unless set |
| `JOBS_TELEGRAM_BOT_TOKEN` | From Telegram's BotFather |
| `JOBS_TELEGRAM_LINK_CODE` | Generated at bootstrap; sent once as `/start <code>` to link the owner's Telegram account |
| `JOBS_MAIL_HOST`, `JOBS_MAIL_PORT`, `JOBS_MAIL_USER`, `JOBS_MAIL_PASSWORD` | The jobs mailbox (IMAP over TLS) |
| `JOBS_MAIL_ALLOWED_SENDERS` | The addresses whose forwards are read |

Each source can be turned off by leaving its settings out.

## What it does not do

- It never sends email, accepts or declines a job, or changes a calendar.
- It never deletes: a rejected detail stays, marked Rejected.
- It does not read the owner's whole inbox; only what is forwarded or sent.
- It does not read text in scans and photos with OCR: those details always
  wait for review.

## Privacy

Sources go to Anthropic to be read, and Telegram messages and files pass
through Telegram's servers. Nothing else leaves the server.
