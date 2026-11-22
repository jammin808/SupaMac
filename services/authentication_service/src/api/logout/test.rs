use super::{Revocation, revoke_session, session_refresh_token};
use axum::http::{HeaderMap, HeaderValue};
use cookie::Cookie;
use fusionauth::FusionAuthClient;
use macro_auth::constant::MACRO_REFRESH_TOKEN_HEADER;
use tower_cookies::Cookies;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{body_json, method, path},
};

fn client(fusionauth: &MockServer) -> FusionAuthClient {
    FusionAuthClient::new(
        "api-key".into(),
        "client-id".into(),
        "client-secret".into(),
        fusionauth.uri(),
        "http://localhost/oauth/redirect".into(),
        "google-client-id".into(),
        "google-client-secret".into(),
    )
}

/// FusionAuth's refresh token revocation for `token`, answering `status`
/// exactly `calls` times.
async fn revocation(token: &str, status: u16, calls: u64) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/api/jwt/refresh"))
        .and(body_json(serde_json::json!({ "token": token })))
        .respond_with(ResponseTemplate::new(status))
        .expect(calls)
        .mount(&server)
        .await;
    server
}

#[tokio::test]
async fn signing_out_revokes_the_sessions_refresh_token() {
    let fusionauth = revocation("refresh-token", 200, 1).await;

    let outcome = revoke_session(&client(&fusionauth), Some("refresh-token")).await;

    assert_eq!(outcome, Revocation::Revoked);
}

#[tokio::test]
async fn a_token_the_identity_server_no_longer_knows_counts_as_revoked() {
    let fusionauth = revocation("refresh-token", 404, 1).await;

    let outcome = revoke_session(&client(&fusionauth), Some("refresh-token")).await;

    assert_eq!(outcome, Revocation::Revoked);
}

#[tokio::test]
async fn a_failed_revocation_is_reported_and_does_not_stop_the_sign_out() {
    let fusionauth = revocation("refresh-token", 503, 1).await;

    let outcome = revoke_session(&client(&fusionauth), Some("refresh-token")).await;

    assert_eq!(outcome, Revocation::Failed);
}

#[tokio::test]
async fn a_session_without_a_refresh_token_calls_nothing() {
    let fusionauth = revocation("refresh-token", 200, 0).await;

    let outcome = revoke_session(&client(&fusionauth), None).await;

    assert_eq!(outcome, Revocation::NoToken);
}

#[test]
fn the_refresh_token_comes_from_the_header_before_the_cookie() {
    let cookies = Cookies::default();
    cookies.add(Cookie::new(
        crate::api::utils::refresh_token_cookie_name(),
        "cookie-token",
    ));
    let mut headers = HeaderMap::new();

    assert_eq!(
        session_refresh_token(&headers, &cookies).as_deref(),
        Some("cookie-token")
    );

    headers.insert(
        MACRO_REFRESH_TOKEN_HEADER,
        HeaderValue::from_static("header-token"),
    );
    assert_eq!(
        session_refresh_token(&headers, &cookies).as_deref(),
        Some("header-token")
    );

    assert_eq!(
        session_refresh_token(&HeaderMap::new(), &Cookies::default()),
        None
    );
}
