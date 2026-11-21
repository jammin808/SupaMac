//! Document download links, shared by document locations and exports.

use cloudfront_sign::{SignedOptions, get_signed_url};
use s3_key::document_key_url_path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::Config;
use crate::service::s3::S3;

/// Creates signed options for the cloudfront presigned url
#[tracing::instrument(skip(private_key), err)]
pub(crate) fn get_cloudfront_signed_options(
    public_key_id: &str,
    private_key: &str,
    presigned_url_expiry_seconds: u64,
) -> anyhow::Result<SignedOptions> {
    let current_unix_timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let date_less_than = current_unix_timestamp + presigned_url_expiry_seconds;

    Ok(SignedOptions {
        key_pair_id: public_key_id.to_string(),
        date_less_than,
        private_key: private_key.to_string(),
        ..Default::default()
    })
}

/// Makes a cloudfront presigned url for the provided key
#[tracing::instrument(skip(options), err)]
pub(crate) fn get_presigned_url(
    cloudfront_distribution_url: &str,
    key: &str,
    options: &SignedOptions,
) -> anyhow::Result<String> {
    let constructed_url = format!("{}/{}", cloudfront_distribution_url, key);

    Ok(get_signed_url(&constructed_url, options)?)
}

/// The link the document object at `key` is read from, good for the configured
/// expiry.
///
/// Under local AWS no CDN stands in front of the bucket to verify a CloudFront
/// signature, so the link is a presigned GET that the store itself checks.
// The key holds its owner's user id, so no argument is recorded.
#[tracing::instrument(skip_all, err)]
pub(crate) async fn document_url(s3: &S3, config: &Config, key: &str) -> anyhow::Result<String> {
    let expiry_seconds = config.document_storage_service_presigned_url_expiry_seconds;

    if macro_aws_config::is_local_aws() {
        return s3.get_document_presigned_url(key, expiry_seconds).await;
    }

    let signed_options = get_cloudfront_signed_options(
        &config.document_storage_service_cloudfront_signer_public_key_id,
        config
            .document_storage_service_cloudfront_signer_private_key
            .as_ref(),
        expiry_seconds,
    )?;

    get_presigned_url(
        &config.document_storage_service_cloudfront_distribution_url,
        &document_key_url_path(key),
        &signed_options,
    )
}
