use super::*;

#[tokio::test]
async fn document_link_expires_when_its_caller_says_and_a_snapshot_link_after_five_minutes() {
    let config = macro_aws_config::local_aws_config("http://127.0.0.1:9000").await;
    // `macro_aws_config::s3_client` forces path-style addressing under local AWS.
    let client = s3::Client::from_conf(
        s3::config::Builder::from(&config)
            .force_path_style(true)
            .build(),
    );
    let storage = S3Client::new(client, "doc-storage", "docx-upload", "upload-staging");

    let document_link = storage
        .get_document_presigned_url("macro|user@example.com/doc-1/7", 900)
        .await
        .unwrap();
    let snapshot_link = storage
        .get_snapshot_presigned_url("snapshots/doc-1")
        .await
        .unwrap();

    let (document_resource, document_query) = document_link.split_once('?').unwrap();
    assert_eq!(
        document_resource,
        "http://127.0.0.1:9000/doc-storage/macro%7Cuser%40example.com/doc-1/7"
    );
    let document_parameters: Vec<&str> = document_query.split('&').collect();
    assert!(document_parameters.contains(&"X-Amz-Expires=900"));
    assert!(document_parameters.contains(&"X-Amz-SignedHeaders=host"));

    let (snapshot_resource, snapshot_query) = snapshot_link.split_once('?').unwrap();
    assert_eq!(
        snapshot_resource,
        "http://127.0.0.1:9000/doc-storage/snapshots/doc-1"
    );
    let snapshot_parameters: Vec<&str> = snapshot_query.split('&').collect();
    assert!(snapshot_parameters.contains(&"X-Amz-Expires=300"));
}
