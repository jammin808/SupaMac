#![deny(missing_docs)]

//! This crate creates a standard way to make AWS configs.

pub use aws_config::SdkConfig;
use aws_credential_types::Credentials;
use macro_env_var::maybe_env_var;

maybe_env_var! {
    #[derive(Clone)]
    pub struct LocalAwsUrl;
}

maybe_env_var! {
    /// Browser-facing LocalStack endpoint, including any reverse-proxy path prefix.
    #[derive(Clone)]
    pub struct LocalAwsPublicUrl;
}

maybe_env_var! {
    /// Access key of the store behind `LOCAL_AWS_URL`, set together with
    /// `LOCAL_AWS_SECRET_ACCESS_KEY`. With neither set, requests are signed
    /// with the SDK's public test credentials, which only an emulator accepts.
    struct LocalAwsAccessKeyId;
}

maybe_env_var! {
    /// Secret key paired with `LOCAL_AWS_ACCESS_KEY_ID`. The type is private
    /// and has no `Debug`, so the value cannot be formatted into a log or an
    /// error, here or by a caller.
    struct LocalAwsSecretAccessKey;
}

/// Creates an S3 client
#[cfg(feature = "s3")]
pub async fn s3_client() -> aws_sdk_s3::Client {
    let s3_config = aws_sdk_s3::config::Builder::from(&get_macro_aws_config().await)
        .force_path_style(is_local_aws())
        .build();
    aws_sdk_s3::Client::from_conf(s3_config)
}

/// Creates an SQS client
#[cfg(feature = "sqs")]
pub async fn sqs_client() -> aws_sdk_sqs::Client {
    aws_sdk_sqs::Client::new(&get_macro_aws_config().await)
}

/// Creates a aws_config to use.
/// If you provide `LOCAL_AWS_URL` environment variable we create a local aws
/// config, see [`local_aws_config`].
/// Otherwise we load normally.
pub async fn get_macro_aws_config() -> aws_config::SdkConfig {
    if let Some(local_aws_url) = LocalAwsUrl::new() {
        local_aws_config(local_aws_url.as_ref()).await
    } else {
        aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region("us-east-1")
            .load()
            .await
    }
}

/// Creates an AWS SDK config pointed at a LocalStack endpoint.
///
/// Requests are signed with `LOCAL_AWS_ACCESS_KEY_ID` and
/// `LOCAL_AWS_SECRET_ACCESS_KEY` when both are set, and with the SDK's test
/// credentials when neither is.
///
/// # Panics
///
/// When only one of the two is set, or either is empty.
pub async fn local_aws_config(local_aws_url: &str) -> aws_config::SdkConfig {
    let access_key_id = LocalAwsAccessKeyId::new();
    let secret_access_key = LocalAwsSecretAccessKey::new();
    let credentials =
        local_static_credentials(access_key_id.as_deref(), secret_access_key.as_deref());

    local_aws_config_with(local_aws_url, credentials).await
}

/// The key pair configured for the local endpoint, or `None` when requests are
/// to be signed with the SDK's test credentials.
///
/// Half a pair, or an empty value, is a deployment mistake that the public
/// test credentials would hide, so it stops the process where the config is
/// built. The message names the variables and never a value.
fn local_static_credentials(
    access_key_id: Option<&str>,
    secret_access_key: Option<&str>,
) -> Option<Credentials> {
    match (access_key_id, secret_access_key) {
        (None, None) => None,
        (Some(access_key_id), Some(secret_access_key))
            if !access_key_id.is_empty() && !secret_access_key.is_empty() =>
        {
            Some(Credentials::new(
                access_key_id,
                secret_access_key,
                None,
                None,
                "LocalAwsEnvironment",
            ))
        }
        _ => panic!(
            "LOCAL_AWS_ACCESS_KEY_ID and LOCAL_AWS_SECRET_ACCESS_KEY must both be set and non-empty, or both be unset"
        ),
    }
}

async fn local_aws_config_with(
    local_aws_url: &str,
    credentials: Option<Credentials>,
) -> aws_config::SdkConfig {
    let loader = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .region("us-east-1")
        .endpoint_url(local_aws_url);

    let loader = match credentials {
        Some(credentials) => loader.credentials_provider(credentials),
        None => loader.test_credentials(),
    };

    loader.load().await
}

/// Returns if the aws config is local or not
pub fn is_local_aws() -> bool {
    LocalAwsUrl::new().is_some()
}

/// internal method to transform the local aws url
fn transform_local_url(url: &str, public_url: Option<&str>) -> String {
    // NOTE: it is ok to use expect as this is only run locally
    let parsed = url::Url::parse(url).expect("valid url");
    let host = parsed.host_str().unwrap();
    let port = parsed.port().unwrap_or(4566);
    let path = parsed.path();
    let query = parsed.query().map(|q| format!("?{q}")).unwrap_or_default();

    let origin = public_url
        .map(|url| url.trim_end_matches('/').to_owned())
        .unwrap_or_else(|| format!("http://localhost:{port}"));

    // Path-style LocalStack URLs generated inside Docker use `localstack` as
    // the host, which the browser on the host machine cannot resolve. Keep the
    // existing path (`/{bucket}/{key}`) and use the browser-facing origin.
    if host == "localstack" || host == "localhost" {
        return format!("{origin}{path}{query}");
    }

    // hostname should be in the form {asset}.localstack or {asset}.localhost;
    // any other endpoint (a test's own, by address) is reachable as it is.
    let Some(asset) = host
        .strip_suffix(".localstack")
        .or_else(|| host.strip_suffix(".localhost"))
    else {
        return url.to_owned();
    };

    format!("{origin}/{asset}{path}{query}")
}

/// Transforms a localstack url into one that will work within the app
/// For example, presigned urls for localstack come out as `http://{BUCKET_NAME}.localstack:{PORT}`
/// but we need them to be formulated as `http://localhost:{PORT}/bucket-name`.
/// `LOCAL_AWS_PUBLIC_URL`, when set by the local stack, supplies the browser-facing
/// endpoint so named instances can use their HTTPS storage proxy.
///
/// Only the origin changes: the path and the query stay as the SDK signed
/// them, and the signature covers the host of `LOCAL_AWS_URL`. A store that
/// verifies signatures therefore accepts the link only if whatever serves the
/// public endpoint removes its own path prefix, passes the rest of the path
/// and the query through untouched, and sends that host upstream.
pub fn transform_aws_url(url: &str) -> String {
    if is_local_aws() {
        let public_url = LocalAwsPublicUrl::new();
        return transform_local_url(url, public_url.as_ref().map(|url| url.as_ref()));
    }
    url.to_string()
}

/// internal method to transform a browser-facing local url into one reachable
/// from inside the docker network
fn transform_internal_url(url: &str, local_aws_url: &str, public_url: Option<&str>) -> String {
    // NOTE: it is ok to use expect as this is only run locally
    let parsed = url::Url::parse(url).expect("valid url");
    let host = parsed.host_str().unwrap();
    let path = parsed.path();
    let query = parsed.query().map(|q| format!("?{q}")).unwrap_or_default();

    // The HTTPS app proxy exposes storage below a path prefix. Match only
    // that configured endpoint and remove its prefix before calling S3.
    if let Some(public) = public_url.and_then(|url| url::Url::parse(url).ok())
        && parsed.origin() == public.origin()
        && let Some(key) = path.strip_prefix(&format!("{}/", public.path().trim_end_matches('/')))
    {
        return format!("{}/{key}{query}", local_aws_url.trim_end_matches('/'));
    }

    // Browser-facing local URLs use `localhost`, which inside a container
    // resolves to the container itself. Use the SDK endpoint, including its
    // internal port, so service-to-service fetches reach LocalStack. Leave any other
    // host untouched.
    if host == "localhost" || host == "localstack" {
        return format!("{}{path}{query}", local_aws_url.trim_end_matches('/'));
    }

    url.to_string()
}

/// Transforms a browser-facing local URL into one reachable from inside the
/// app's own containers when fetching an object server-side.
///
/// The inverse of [`transform_aws_url`]: remove the configured public endpoint's
/// origin and proxy prefix so container clients reach LocalStack directly.
/// Legacy localhost URLs are also supported. No-op outside local AWS.
pub fn transform_aws_url_for_internal_fetch(url: &str) -> String {
    if let Some(local_aws_url) = LocalAwsUrl::new() {
        let public_url = LocalAwsPublicUrl::new();
        return transform_internal_url(
            url,
            local_aws_url.as_ref(),
            public_url.as_ref().map(|url| url.as_ref()),
        );
    }
    url.to_string()
}

#[cfg(test)]
mod test;
