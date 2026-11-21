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

## Verified, and not

Verified on a development machine, without starting the stack: the Compose
files parse with example values; the bootstrap script creates its files once
and prints no values; the ops image builds, and its build validates the
gateway configuration and runs the tests of the two small programs in it.
Inside image build steps, against servers that lived only for the step: the
object store's and the database's health checks, the creation of the event
topics, and one backup and restore of both databases, the objects and the
state volumes.

Not verified: everything that needs the stack running. It has not been
started, so sign-in, uploads, collaborative editing, the AI assistant,
backups and restore have not been observed working on it. A restore brings
back the objects' bytes but not their content types. No security scanner
result is claimed for it. The full list is in the README's
[Not covered, not verified](../../infra/self-hosted/README.md#not-covered-not-verified).

Deploying, and any action that resets data, is the operator's decision on the
server; preparing these files performs neither.
