//! Which credentials the local config signs with. The provider is read off
//! the built config; nothing here opens a connection.

use super::*;
use aws_credential_types::provider::ProvideCredentials;

#[tokio::test]
async fn configured_key_pair_signs_local_requests() {
    let credentials =
        local_static_credentials(Some("example-access-key"), Some("example-secret-key"));
    let config = local_aws_config_with("http://localstack:4566", credentials).await;

    let resolved = config
        .credentials_provider()
        .unwrap()
        .provide_credentials()
        .await
        .unwrap();
    assert_eq!(resolved.access_key_id(), "example-access-key");
    assert_eq!(resolved.secret_access_key(), "example-secret-key");
    assert!(!format!("{resolved:?}").contains("example-secret-key"));
    assert!(!format!("{config:?}").contains("example-secret-key"));
}

#[tokio::test]
async fn without_a_key_pair_the_sdk_test_credentials_sign() {
    let credentials = local_static_credentials(None, None);
    let config = local_aws_config_with("http://localstack:4566", credentials).await;

    let resolved = config
        .credentials_provider()
        .unwrap()
        .provide_credentials()
        .await
        .unwrap();
    assert_eq!(resolved.access_key_id(), "ANOTREAL");
}

#[test]
#[should_panic(
    expected = "LOCAL_AWS_ACCESS_KEY_ID and LOCAL_AWS_SECRET_ACCESS_KEY must both be set"
)]
fn an_access_key_without_its_secret_stops_config_construction() {
    local_static_credentials(Some("example-access-key"), None);
}

#[test]
#[should_panic(
    expected = "LOCAL_AWS_ACCESS_KEY_ID and LOCAL_AWS_SECRET_ACCESS_KEY must both be set"
)]
fn a_secret_without_its_access_key_stops_config_construction() {
    local_static_credentials(None, Some("example-secret-key"));
}

#[test]
#[should_panic(
    expected = "LOCAL_AWS_ACCESS_KEY_ID and LOCAL_AWS_SECRET_ACCESS_KEY must both be set"
)]
fn an_empty_value_is_not_half_of_a_key_pair() {
    local_static_credentials(Some("example-access-key"), Some(""));
}
