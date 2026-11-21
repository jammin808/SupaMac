use super::*;

#[tokio::test]
async fn download_link_is_an_expiring_get_for_the_document_storage_bucket() {
    let config = macro_aws_config::local_aws_config("http://127.0.0.1:9000").await;
    // `macro_aws_config::s3_client` forces path-style addressing under local AWS.
    let client = aws_sdk_s3::Client::from_conf(
        aws_sdk_s3::config::Builder::from(&config)
            .force_path_style(true)
            .build(),
    );
    let adapter = S3UploadUrlAdapter::new(client, "doc-storage", "docx-upload");

    let link = adapter
        .get_document_storage_presigned_url("macro|user@example.com/doc-1/7", 900)
        .await
        .unwrap();

    let (resource, query) = link.split_once('?').unwrap();
    assert_eq!(
        resource,
        "http://127.0.0.1:9000/doc-storage/macro%7Cuser%40example.com/doc-1/7"
    );
    let signed_parameters: Vec<&str> = query.split('&').collect();
    assert!(signed_parameters.contains(&"X-Amz-Expires=900"));
    assert!(signed_parameters.contains(&"X-Amz-SignedHeaders=host"));
}
