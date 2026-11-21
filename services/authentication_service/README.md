# Authentication Service Configuration

## Development signup allowlist

The authentication service gates new signups with a startup-built `SignupPolicy`.
The policy is enforced authoritatively by the existing FusionAuth `user.create`
webhook at `/webhooks/user`. FusionAuth is configured for `user.create` with
`AbsoluteMajority`, so a non-2xx response from this service rejects the
transaction and aborts FusionAuth user creation.

The precheck in passwordless signup (`/login/passwordless`) exists only for a
faster user-facing `403` response. It is advisory. The transactional webhook
is the enforcement boundary for all signup paths, including SSO and future
FusionAuth-created users.

### Settings

- Doppler project: `authentication-service`
- Develop Doppler config: `dev`
- Production Doppler config: `prd`

| Setting | Format | Default |
| --- | --- | --- |
| `DEVELOPMENT_SIGNUP_ALLOWLIST_JSON` | JSON array of exact email-address strings | No default |
| `DEVELOPMENT_BYPASS_SIGNUP_ALLOWLIST` | Exactly `true` or `false` | `false` when absent |
| `SIGNUP_ALLOWLIST_JSON` | JSON array of exact email-address strings | Absent: Local allows every signup |

Synthetic allowlist example only:

```json
["allowed.user@example.com", "second.user@example.net"]
```

Do not commit or paste operational allowlist values into source, docs, logs, PRs,
or generated files.

### Environment behavior

| Runtime environment | Doppler slug | Bypass | Effective signup policy |
| --- | --- | --- | --- |
| `Environment::Develop` | `dev` | Off | Allows `@macro.com` addresses and the addresses in `DEVELOPMENT_SIGNUP_ALLOWLIST_JSON`, which must be present, nonblank, valid, and non-empty. Denies every other signup. |
| `Environment::Develop` | `dev` | On | Allows all public signups. The allowlist setting is ignored even if missing or malformed. |
| `Environment::Production` | `prd` | No effect | Allows all public signups. The allowlist setting is ignored even if present or malformed. |
| `Environment::Local` | `lcl` | No effect | Without `SIGNUP_ALLOWLIST_JSON`, allows all public signups. With it, allows only the addresses it lists and denies every other signup, `@macro.com` addresses included. `DEVELOPMENT_SIGNUP_ALLOWLIST_JSON` is ignored even if present or malformed. |

With the bypass off, Develop startup fails if the allowlist setting is missing,
blank, malformed JSON, not a JSON array, empty, contains a non-string entry,
contains a blank entry, or contains an invalid email address. With the bypass
on, Develop neither requires nor parses the allowlist setting, so the bypass
takes precedence over any allowlist value. Production and Local do not require
`DEVELOPMENT_SIGNUP_ALLOWLIST_JSON` and do not parse it.

`SIGNUP_ALLOWLIST_JSON` is read only in Local, and only its absence means
"allow everyone": when the variable is present, startup fails if it is blank,
malformed JSON, not a JSON array, empty, or contains a non-string, blank, or
invalid entry. The config loader reads the literal value `null` as absent. A developer stack leaves it unset. A Local deployment that
strangers can reach sets it; see
[Running as Local on the internet](#running-as-local-on-the-internet).
Production and Develop ignore it even if it is present or malformed.

The bypass accepts only the exact values `true` and `false`. Values such as
`True`, `1`, `yes`, or an empty string fail startup in every environment,
including Production and Local, where the bypass otherwise has no effect.

### Matching and validation semantics

With the bypass off, the service parses the allowlist once at startup and
stores it in memory. Request handlers perform hash lookups only.

Normalization rules:

- Trim leading and trailing whitespace from each configured entry.
- Validate each entry with the service email parser.
- Lowercase the address after validation.
- Deduplicate normalized addresses.

Matching rules:

- Matching is exact after normalization.
- Case differences do not matter.
- `+` aliases remain distinct addresses.
- In Develop, every `@macro.com` address is allowed without being listed;
  subdomains and look-alike domains are not. In Local, no address is allowed
  without being listed.
- Domains, wildcards, suffixes, patterns, and regular expressions are not
  supported in the allowlist.
- Denial responses and policy errors must not disclose configured addresses.

## GTM invite links

Macro staff (any `@macro.com` account) mint personal, 48-hour signup links from
`/app/internal/invite-links`. The recipient opens `/app/invite?token=…`, signs up,
and the account is attributed to the staff member who created the link. At the
plan step of onboarding the account sees a free-month offer instead of the plan
picker, and checkout applies a Stripe promotion code server-side. The Stripe
subscription webhook then marks the link converted.

Both settings are optional plain Doppler values (project
`authentication-service`); the service falls back to the defaults when unset.

| Setting | Default | Meaning |
| --- | --- | --- |
| `GTM_INVITE_PROMO_CODE` | `1MF` | Customer-facing Stripe promotion code applied at checkout. Must exist and be active in Stripe (`1MF` is 100% off the first month). |
| `GTM_INVITE_LINK_TTL_HOURS` | `48` | How long a link can be opened and redeemed after creation. |

Links live in the `gtm_invite_link` MacroDB table (crate `gtm_invite`); the
dashboard reads it through `GET /gtm-invite/links`.

## Running as Local on the internet

`ENVIRONMENT=local` is also how a deployment outside Macro's own
infrastructure runs. Local's defaults suit a developer machine; a deployment
that strangers can reach changes them with these settings. All are optional
and read once at startup. Production and Develop ignore the first and refuse
the second; the last two apply in every environment.

| Setting | Format | When absent | Internet-facing deployment |
| --- | --- | --- | --- |
| `SIGNUP_ALLOWLIST_JSON` | JSON array of exact email-address strings | Anyone can create an account | Set to the addresses that may sign up |
| `DEV_DANGEROUS_CROSS_SITE_COOKIES` | Exactly `true` or `false` | `false`: session cookies are `SameSite=Strict` | Leave unset |
| `SUPPORT_CHANNEL_PARTICIPANTS_JSON` | JSON array of email-address strings | The Macro support team joins every new person's support channel and posts its welcome | Set to `[]`, or to the deployment's own support addresses |
| `AUTH_SENDER_ADDRESS` | One email address | `auth@macro.com` | Set to an address the deployment's mail relay may send from |

- **Signup.** The allowlist is the same policy Develop enforces, without the
  `@macro.com` exception, at the same boundary: the `user.create` webhook, so
  FusionAuth must call it with `AbsoluteMajority` as the local kickstart and
  the hosted stack configure it. No signup path is exempt. A person invited to
  a team, a shared mailbox being relocated, and an agent signing up by email
  must each be listed before their account can be created. Accounts created
  before the allowlist was set remain.
- **Session cookies.** `SameSite=Strict` requires the app and this service to
  share a registrable domain, such as `example.com` and `api.example.com`.
  `DEV_DANGEROUS_CROSS_SITE_COOKIES=true` sends the cookies on requests from
  any site, so any page a signed-in person opens can act as them. `just
  run_local` sets it, because a developer stack may serve the app and the API
  from different sites. Startup fails if it is `true` outside Local.
- **Support channel.** Every person's new account gets a private channel named
  `Macro Support x <name>`. Unset, its participants are the Macro support team,
  one of whom posts the welcome message. A configured list replaces that team
  and posts no welcome; `[]` creates no channel, and the app then hides its
  support link. Only the absence of the variable keeps the Macro team: a blank
  or malformed value fails startup.
- **Mail sender.** `AUTH_SENDER_ADDRESS` is the From address of the mail this
  service sends itself (`/mobile-welcome-email`). Sign-in codes are sent by
  FusionAuth, from the tenant's `emailConfiguration.defaultFromEmail` and the
  passwordless email template's `fromEmail`, which are set in FusionAuth.

Sign-up analytics and marketing are already off in Local unless configured:
Loops is never called, and PostHog, Meta, and Google Analytics are called only
when their keys are set.

## Shared mailboxes

Internal shared-mailbox grant relocation creates ordinary FusionAuth users for
mailbox grants. In Develop with the bypass off, those mailbox addresses must be
listed explicitly in `DEVELOPMENT_SIGNUP_ALLOWLIST_JSON` before relocation
creates the FusionAuth user. With the bypass on, Develop allows those addresses
like any other signup. In Local with `SIGNUP_ALLOWLIST_JSON` set, they must be
listed there. Shared mailboxes get no metadata-based exemption from the
signup policy.

## Rollout

1. Configure `DEVELOPMENT_SIGNUP_ALLOWLIST_JSON` in Doppler project
   `authentication-service`, config `dev`, using only the approved operational
   addresses for the deployment. Keep values out of source control and chat.
2. Validate the Doppler configs and semantic policy resolution. The validator
   reads configs `dev` and `prd` with the Doppler token in the `DOPPLER_TOKEN`
   environment variable:

   ```bash
   nix develop --command cargo run -p authentication_service --bin authentication_service_doppler_config
   ```

3. Deploy the authentication service build that contains the signup policy.
4. Restart or replace all Develop authentication service tasks. The service
   reads both settings once at startup. Changing Doppler after deployment does
   not update running tasks.
5. Confirm Develop signups for allowed synthetic/test accounts succeed and
   unlisted synthetic/test accounts receive a generic `403` without onboarding
   side effects.

Production, and Local without `SIGNUP_ALLOWLIST_JSON`, remain allow-all and can
deploy independently of the Develop allowlist value.

### Change the bypass

To allow every public signup in Develop:

1. Set `DEVELOPMENT_BYPASS_SIGNUP_ALLOWLIST` to `true` in Doppler project
   `authentication-service`, config `dev`.
2. Restart or replace all Develop authentication service tasks.
3. Confirm that an unlisted synthetic test account can sign up.

To enforce the allowlist again:

1. Confirm that `DEVELOPMENT_SIGNUP_ALLOWLIST_JSON` lists every non-Macro
   address that still needs to sign up in Develop, including shared mailboxes.
2. Set `DEVELOPMENT_BYPASS_SIGNUP_ALLOWLIST` to `false` in config `dev`, or
   delete it.
3. Run the Doppler config validator from rollout step 2.
4. Restart or replace all Develop authentication service tasks. If the
   allowlist is missing or invalid, Develop startup fails until you fix it.
5. Confirm that an unlisted synthetic test account receives a generic `403`.

The validator skips `DEVELOPMENT_SIGNUP_ALLOWLIST_JSON` while the bypass is on.
The allowlist can become invalid without detection, so validate it before you
turn the bypass off. Accounts created while the bypass is on remain afterward.

## Rollback

- If Develop startup fails because of the allowlist, fix the Doppler JSON value
  and restart the service tasks. The service will not accept traffic until the
  Develop value is valid. Turning the bypass on also lets Develop start, but
  Develop then allows every public signup until you turn the bypass off.
- If startup fails because of `DEVELOPMENT_BYPASS_SIGNUP_ALLOWLIST`, set it to
  exactly `true` or `false`, or delete it. Then restart or replace the service
  tasks. This failure can happen in any environment.
- If a legitimate Develop signup is denied, add the address to the Doppler JSON
  array and restart or replace the authentication service tasks.
- If Develop must stop allowing every public signup, follow
  [Change the bypass](#change-the-bypass) to enforce the allowlist again.
- If the release must be reverted, roll Develop back to the previous
  authentication service deployment or task definition. Builds from before the
  bypass ignore `DEVELOPMENT_BYPASS_SIGNUP_ALLOWLIST` and enforce the allowlist,
  so keep a valid Develop allowlist configured even while the bypass is on.

## Focused verification

Useful checks after editing signup configuration behavior:

```bash
nix develop --command cargo test -p authentication_service --lib config::test  # needs a live DATABASE_URL
nix develop --command cargo check -p authentication_service --bin authentication_service_doppler_config
cargo fmt --check
```

Review this README and related logs before rollout to confirm they contain only
placeholders or reserved synthetic examples, never operational email addresses
or copied Doppler values.
