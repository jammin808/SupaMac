# FusionAuth kickstart

FusionAuth applies `kickstart.json` once, against an empty database, and never
again: a later change to this file reaches a running instance only through
FusionAuth's API or a fresh `fusionauth` database.

It follows the local stack's kickstart
(`tooling/xtask/crates/xtask_local/src/local/kickstart.rs`) and keeps its fixed,
non-secret ids, so the services' `FUSIONAUTH_CLIENT_ID` and `AUDIENCE` are the
same values in both. The differences are what an internet-facing instance needs:

- Every secret is `#{ENV.NAME}`, read from the container's environment. A
  kickstart file allows no comments, hence this file.
- Redirect URLs are matched exactly and the OAuth client must authenticate.
- Sign-in codes go out through the in-network mail relay and expire after ten
  minutes.
- Sign-in is by emailed code. The one identity provider, `google_gmail`, is
  disabled and enabled for no application, with a client nobody accepts: it
  exists because the agent harness looks it up by name when it starts and
  exits without it. Nobody can sign in through it.
- The admin account's address is not one a person signs in to the app with. An
  address that exists in FusionAuth before its first app sign-in gets no app
  profile.

Request order matters: the admin user comes before the webhooks, because once
the `user.create` webhook exists a new user is rolled back unless the
authentication service answers.

The populate-JWT lambda is copied into the image from
`infra/stacks/fusionauth-instance/templates/populate_jwt_local.js`, the variant
that needs no FusionAuth licence.
