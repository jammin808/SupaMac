# macro_aws_config

## What it is

Shared infrastructure: the one place AWS SDK configs and the S3 and SQS clients
are built. `LOCAL_AWS_URL` points every client of a process at one endpoint
instead of AWS: an emulator on a developer machine, or an S3-compatible store
behind an in-network router.

## Start here

- `src/lib.rs`: `get_macro_aws_config` / `local_aws_config` (endpoint, region,
  credentials), `s3_client` (path-style under local AWS), and the URL rewrites
  between the in-network endpoint and the one a browser reaches
  (`transform_aws_url`, `transform_aws_url_for_internal_fetch`).

## Local AWS variables

All optional, read from the process environment or `APP_SECRETS_JSON`.

| Variable | Unset | Set |
| --- | --- | --- |
| `LOCAL_AWS_URL` | AWS, default credential chain | every client uses this endpoint, region `us-east-1`, path-style S3 |
| `LOCAL_AWS_PUBLIC_URL` | browser URLs use `http://localhost:<endpoint port>` | origin and path prefix a browser reaches the endpoint under |
| `LOCAL_AWS_ACCESS_KEY_ID`, `LOCAL_AWS_SECRET_ACCESS_KEY` | the SDK's public test credentials, which only an emulator accepts | static credentials for the endpoint |

## Checks

- `cargo test -p macro_aws_config --features s3,sqs` (no network, no database).
- `SQLX_OFFLINE=true cargo check -p macro_aws_config --tests`: most services
  build it without either feature.

## Gotchas

- The key pair is all or nothing. One without the other, or an empty value,
  panics where the config is built, which for a service is startup: falling
  back to the public test credentials would hide the mistake. The developer
  stack sets neither. Don't derive `Debug` on `LocalAwsSecretAccessKey`.
- One pair signs every service behind `LOCAL_AWS_URL` (S3, SQS, DynamoDB, KMS),
  so whatever answers there must accept it for each of them.
- A presigned URL is rewritten for browsers only when the endpoint's host is
  `localstack` or `localhost`; any other host is returned as signed, which a
  browser outside the network cannot reach. A store under another name needs
  `localstack` as a network alias.
- The browser URL is `<LOCAL_AWS_PUBLIC_URL>/<bucket>/<key>?<signed query>`.
  The signature covers the host and port of `LOCAL_AWS_URL`, the path
  `/<bucket>/<key>` and the query; `host` is the only signed header. The proxy
  behind `LOCAL_AWS_PUBLIC_URL` must strip only its own prefix, keep the path's
  percent-encoding and the query byte for byte, and send the store
  `Host: <host[:port] of LOCAL_AWS_URL>`, not the public host. An emulator that
  skips signature checks hides a proxy that gets this wrong;
  `src/test/presigned_get.rs` pins the shape.

## Related

- Rules: `.agents/rules/config-and-service-urls.md`
