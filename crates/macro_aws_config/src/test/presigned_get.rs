//! The shape of a presigned GET as a browser receives it. A store that
//! verifies signatures recomputes one from the request it is sent, so whatever
//! publishes the store has to hand it the request that was signed.

use std::time::Duration;

use aws_sdk_s3::presigning::PresigningConfig;

use super::*;

#[tokio::test]
async fn presigned_get_keeps_its_signed_path_and_query_below_the_public_prefix() {
    let credentials =
        local_static_credentials(Some("example-access-key"), Some("example-secret-key"));
    let config = local_aws_config_with("http://localstack:9000", credentials).await;
    // `s3_client` forces path-style addressing under local AWS.
    let client = aws_sdk_s3::Client::from_conf(
        aws_sdk_s3::config::Builder::from(&config)
            .force_path_style(true)
            .build(),
    );

    let presigned = client
        .get_object()
        .bucket("doc-storage")
        .key("macro|user@example.com/doc-1/1")
        .presigned(PresigningConfig::expires_in(Duration::from_secs(300)).unwrap())
        .await
        .unwrap();

    // What the store verifies: the endpoint's own host and port, the bucket as
    // the first path segment, and `host` as the only header a client must send.
    let (signed_resource, signed_query) = presigned.uri().split_once('?').unwrap();
    assert_eq!(
        signed_resource,
        "http://localstack:9000/doc-storage/macro%7Cuser%40example.com/doc-1/1"
    );
    let signed_url = url::Url::parse(presigned.uri()).unwrap();
    let query_value = |name: &str| {
        signed_url
            .query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    assert_eq!(query_value("X-Amz-SignedHeaders").as_deref(), Some("host"));
    assert_eq!(query_value("X-Amz-Expires").as_deref(), Some("300"));
    let credential = query_value("X-Amz-Credential").unwrap();
    assert!(credential.starts_with("example-access-key/"));
    assert!(credential.ends_with("/us-east-1/s3/aws4_request"));

    // What the browser is given: the public endpoint and its path prefix in
    // place of the endpoint, the path and the query untouched.
    let public_url = "https://example.com/local-storage";
    let browser_url = transform_local_url(presigned.uri(), Some(public_url));
    assert_eq!(
        browser_url,
        format!(
            "https://example.com/local-storage/doc-storage/macro%7Cuser%40example.com/doc-1/1?{signed_query}"
        )
    );

    // A service fetching the same link gets back the URL that was signed.
    assert_eq!(
        transform_internal_url(&browser_url, "http://localstack:9000", Some(public_url)),
        presigned.uri()
    );
}
