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

Verified in one rehearsal on a development machine: the five images were
built, the bootstrap project wrote its secrets into a scratch directory, and
the stack was started from empty volumes behind a stand-in for Traefik, with
the packaged web bundle on a sibling hostname and a mail catcher in place of
the SMTP provider. In a headless browser a person's path worked end to end:
a sign-in code requested, mailed, and accepted; onboarding and a team; a
document typed into and read back; a file uploaded and finalised; a CRM
company and contact; sign-out. An address outside the allow-list was refused
and got no mail, the code was never in a response, a second request within
30 seconds was throttled, and internal, webhook and documentation paths
answered 404. The stack came back healthy from a restart with its data, and
used 3.3 GB of memory idle.

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
