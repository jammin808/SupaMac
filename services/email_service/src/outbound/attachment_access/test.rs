use super::*;

#[tokio::test]
async fn store_signed_link_is_an_expiring_get_for_the_stored_key() {
    let config = macro_aws_config::local_aws_config("http://127.0.0.1:9000").await;
    let s3 = s3_client::S3::new(aws_sdk_s3::Client::from_conf(
        aws_sdk_s3::config::Builder::from(&config)
            .force_path_style(true)
            .build(),
    ));

    let link = store_signed_url(
        &s3,
        "email-attachments",
        "temp/7b0f6c1e-2f5d-4a59-9d57-0c1c2f0e9a11/41d6c0de-93f1-4f0a-8c2b-5a1f3b7d9e20-quarterly report.pdf",
        3600,
    )
    .await
    .unwrap();

    let link = url::Url::parse(&link).unwrap();
    assert_eq!(
        link.path(),
        "/email-attachments/temp/7b0f6c1e-2f5d-4a59-9d57-0c1c2f0e9a11/41d6c0de-93f1-4f0a-8c2b-5a1f3b7d9e20-quarterly%20report.pdf"
    );
    let query_value = |name: &str| {
        link.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    assert_eq!(query_value("X-Amz-Expires").as_deref(), Some("3600"));
    assert_eq!(query_value("X-Amz-SignedHeaders").as_deref(), Some("host"));
    assert!(query_value("X-Amz-Signature").is_some());
}
