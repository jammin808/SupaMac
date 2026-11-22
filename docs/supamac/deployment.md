# Deploying SupaMac on one server

This page is the overview for whoever operates a SupaMac instance. The
working instructions are in
[`infra/self-hosted/README.md`](../../infra/self-hosted/README.md).

## What is deployed

- **The web UI** is a static bundle on ordinary web hosting, in a folder of
  the operator's site. See [static publishing](static-publishing.md).
- **The backend** is one Docker Compose project on one server, published at
  `https://api.<domain>` through the Traefik that server already runs. One
  gateway container is the only thing reachable from outside.
- **Nothing runs in the upstream company's cloud.** Postgres, Redis, Kafka,
  an object store and stand-ins for the AWS queue, table and key services run
  on the server, with their data on Docker volumes.

The developer stack described in [self-hosting](self-hosting.md) is a
different thing and must not be put on the internet: it has fixed secrets and
returns sign-in codes in its responses.

## How a deployment goes

1. Run the one-shot bootstrap project. It generates every internal secret on
   the server, into `/etc/supamac`; no secret passes through the deploy tool
   or this repository.
2. Point `api.<domain>` at the server.
3. Deploy the stack with the domain, the UI's address, the list of addresses
   allowed to sign up, and the image references.
4. Add the SMTP provider's login and any AI keys on the server, and deploy
   again.
5. Publish the web bundle and sign in.

Sign-in is by a code sent to an allow-listed address. There is no password
sign-in and no Google sign-in in this deployment.

## Upgrading

An upgrade is a new set of images and a new web bundle, all built from one
commit. The order matters:

1. **Take a backup.** Restart the `backup` container: it makes a backup as
   it starts. Wait for `backup <time> complete` in its log, and keep the copy
   of `/etc/supamac` current. There is no downgrade: the way back is the
   [restore](../../infra/self-hosted/README.md#backup-and-restore) and the
   old images.
2. **Deploy the stack with the new image references**, every one of them from
   the same commit, the ops image included. The jobs run first: `migrate`
   applies the new migrations, `init-aws` creates missing queues and sets
   their attributes, `init-kafka-topics` creates missing topics. The services
   start when the jobs are done.
3. **Read the jobs' logs.** A job that failed stops the deployment, and the
   services that wait for it are not replaced; deploying again runs it
   again. A migration that gave up waiting for a lock (most set a timeout of
   a few seconds) is safe to run again.
4. **Publish the web bundle last**, built from the same commit, once the
   services are healthy. Upstream releases in this order too, so the old
   bundle is expected to work against the new backend for the time between;
   a new bundle calls endpoints an older backend does not have. Never publish
   a bundle ahead of its backend.

The SQL below is run as the database owner inside the database's container,
whose name `docker ps` shows:

```sh
docker exec -i <postgres container> psql -U supamac -d macrodb
```

None of this section has been run on a deployed stack.

### The snapshot of 2026-11-21

The update from the snapshot of 2026-11-19 adds 24 migrations (852 to 876),
one event topic, two queues of upstream's and two dead-letter queues of the
stack's own. No migration drops a table, a column or a row, and one changes
rows: the CRM outcome below. With the `email` profile
the ops image must not stay behind: the hourly mailbox maintenance (renewing
Gmail's push subscriptions among it) now goes to one of the new queues, and
without that queue it is lost with nothing but a line in a log. Three more
things need a look beyond the order above.

**Indexes built without a lock.** Seven migrations build an index with
`CREATE INDEX CONCURRENTLY`. If the `migrate` job is stopped while one is
building, an invalid index stays behind. After any run of `migrate` that did
not finish, also when the next one is green, look for one:

```sql
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
```

What to do depends on the name it prints:

- `idx_document_trashed_id_owner`, `email_sync_streams_import_round_claim`,
  `idx_activity_events_own`, `email_message_reconciliation_live_queued` or
  `email_sync_streams_link_import_rounds`: `DROP INDEX CONCURRENTLY <name>;`,
  then deploy again. The migration fails every run while the invalid index
  is there, and builds the index on the run after the drop.
- `scheduling_booking_processing` or `idx_ep_crm_record_references_gin`:
  `REINDEX INDEX CONCURRENTLY <name>;`, which builds the index again where
  it is. Do not drop these two. Their migrations say `IF NOT EXISTS`: the
  next run passes over the invalid index and is recorded as applied, and no
  later deployment builds an index that was dropped after that.
- A name ending in `_ccnew`: what a `REINDEX` that was itself stopped left
  beside the index. `DROP INDEX CONCURRENTLY <name>;`, then run the
  `REINDEX` again.

If one of those two was dropped all the same, nothing reports it missing.
`SELECT to_regclass('<name>');` is null for an index that is not there, and
the migration's own file builds it, run the way the CRM remedy below runs
its file: `20261119171842_scheduling_booking_processing.up.sql` or
`20261119222316_crm_record_references_gin.up.sql`.

Tried on a scratch Postgres 16, on indexes of other names left invalid by a
build stopped half-way: each of the three remedies, that a statement with
`IF NOT EXISTS` passes over an invalid index and one without fails on it,
and the first of the two files piped into `psql`. The stack runs Postgres
18, and the `migrate` job was not part of the trial.

**The CRM outcome "Declined".** Migration `20261120183025` adds the option
"Declined" to the Outcome field of every CRM pipeline. It does not wait: a
pipeline that someone is editing while it runs is skipped without a word,
and the migration still counts as applied. Upgrade while nobody edits a
pipeline, and check afterwards. This lists the pipelines without the option:

```sql
SELECT p.id
FROM crm_pipeline_entities p
JOIN database_columns c
  ON c.id = (p.commercial_fields ->> 'outcome')::uuid
 AND c.table_id = p.table_id
WHERE NOT EXISTS (
  SELECT 1 FROM property_options o
  WHERE o.property_definition_id = c.property_definition_id
    AND lower(o.string_value) = 'declined'
);
```

If it prints a row, run the migration's statement again. It adds the option
where it is missing and changes nothing else:

```sh
docker run --rm <ops image> \
  cat /opt/supamac/migrations/20261120183025_crm_pipeline_outcome_declined.sql |
  docker exec -i <postgres container> psql -U supamac -d macrodb -v ON_ERROR_STOP=1
```

**Deleted chat messages in search.** Only where the `search` profile ran
before this update. Until now, deleting one message of an AI chat left it in
the search index, where the chat was still found by it. New deletions are
removed; the ones from before need the repair job, once. It is an internal
route, so it is called from inside the indexer's container, first as a dry
run, which only counts:

```sh
docker exec <search-processing-service container> sh -c 'curl -fsS -X POST \
  http://localhost:8080/internal/backfill/deleted-chat-messages \
  -H "Content-Type: application/json" \
  -H "x-internal-auth-key: $INTERNAL_API_KEY" -d "{}"'
```

The answer carries a job id. `GET /internal/backfill/<job id>`, called the
same way, reports `missing`: the messages a run would remove. If that is not
zero, send `{"dry_run": false}` in place of `{}`.

Two features are on after this update without anyone switching them on:
agents can send notifications, and contact lists are written. See
[Features](../../infra/self-hosted/README.md#not-covered-not-verified) in
the stack's README. How a new upstream snapshot is taken into the fork is in
[upstream updates](upstream-updates.md).

## Verified, and not

The repository has held two upstream snapshots, of 2026-11-19 and of
2026-11-21. The stack was started only on the first.

Verified in one rehearsal on a development machine, on the snapshot of
2026-11-19: the five images were built, the bootstrap project wrote its
secrets into a scratch directory, and the stack was started from empty
volumes behind a stand-in for Traefik, with the packaged web bundle on a
sibling hostname and a mail catcher in place of the SMTP provider. In a
headless browser a person's path worked end to end: a sign-in code
requested, mailed, and accepted; onboarding and a team; a document typed
into and read back; a file uploaded and finalised; a CRM company and
contact; sign-out. An address outside the allow-list was refused and got no
mail, the code was never in a response, a second request within 30 seconds
was throttled, and internal, webhook and documentation paths answered 404.
The stack came back healthy from a restart with its data, and used 3.3 GB
of memory idle.

Run again on the snapshot of 2026-11-21: the Compose files parse with
example values, the tests pass, and the scripts pass a syntax check. The
tests now also hold the stack's queues to the developer stack's and run the
queue script against a stand-in for the AWS command line. The stack was not
started on it: its 876 migrations have not been applied, and no topic or
queue of this snapshot has been created in a broker or a queue service. The
stack's README lists what was run under
[After the snapshot of 2026-11-21](../../infra/self-hosted/README.md#after-the-snapshot-of-2026-11-21).

Not verified: a real server, Traefik, a real domain and a real SMTP
provider; the `email` and `search` profiles; the AI assistant answering
(the rehearsal had no provider key); restore on a started stack; anything
under load. Known to be wrong, and outside these files: signing out does not
revoke the session on the server, so a copied session cookie works until its
tokens expire. No security scanner result is claimed. The full list is in
the README's
[Not covered, not verified](../../infra/self-hosted/README.md#not-covered-not-verified).

Deploying, and any action that resets data, is the operator's decision on the
server; preparing these files performs neither.
