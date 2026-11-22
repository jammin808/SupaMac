#[cfg(test)]
mod test;

use super::{
    context::{ApiContext, AuthorizationService},
    jwt_session::JwtSessionContext,
};
use crate::api::utils::{
    create_access_token_cookie, create_refresh_token_cookie, refresh_token_cookie_name,
};
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use fusionauth::FusionAuthClient;
use macro_auth::constant::MACRO_REFRESH_TOKEN_HEADER;
use macro_authorization::{MacroAuthorizationExtractor, UserOrInternal};
use model::response::EmptyResponse;
use tower_cookies::{CookieManagerLayer, Cookies};

pub fn router() -> Router<ApiContext> {
    Router::new()
        .route("/", post(handler))
        .route("/", get(handler))
        .layer(CookieManagerLayer::new())
}

/// Initiates a passwordless login
#[utoipa::path(
        post,
        operation_id = "logout",
        path = "/logout",
        responses(
            (status = 200, body= EmptyResponse),
        )
    )]
#[tracing::instrument(
    skip(ctx, authorization, jwt_session, headers, cookies),
    fields(
        user_id=%authorization.authorization.user.user_context.user_id,
        organization_id=?authorization.authorization.user.user_context.organization_id,
        refresh_token_revoked=tracing::field::Empty,
    )
)]
pub async fn handler(
    State(ctx): State<ApiContext>,
    authorization: MacroAuthorizationExtractor<AuthorizationService, UserOrInternal>,
    JwtSessionContext(jwt_session): JwtSessionContext,
    headers: HeaderMap,
    cookies: Cookies,
) -> Result<Response, Response> {
    // End the session at the identity server before the browser forgets it:
    // clearing the cookies alone leaves a copied refresh token able to mint
    // access tokens until it expires.
    let refresh_token = session_refresh_token(&headers, &cookies);
    let revoked = revoke_session(&ctx.auth_client, refresh_token.as_deref()).await;
    tracing::Span::current().record("refresh_token_revoked", revoked.as_str());

    // Remove access token cookie
    let mut access_token_cookie = create_access_token_cookie("", ctx.session_cookie_same_site);
    access_token_cookie.set_expires(Some(time::OffsetDateTime::now_utc()));
    cookies.add(access_token_cookie);

    // Remove refresh token cookie
    let mut refresh_token_cookie = create_refresh_token_cookie("", ctx.session_cookie_same_site);
    refresh_token_cookie.set_expires(Some(time::OffsetDateTime::now_utc()));
    cookies.add(refresh_token_cookie);

    // Logout of fusionauth when the request used a FusionAuth session.
    if let Some(jwt_context) = jwt_session
        && let Err(e) = ctx.auth_client.logout(&jwt_context.tid).await
    {
        tracing::warn!(error=?e, "error logging out");
    }

    Ok((StatusCode::OK, Json(EmptyResponse::default())).into_response())
}

/// The refresh token of the session being signed out: the header the native
/// apps send, else the cookie the browser sends.
fn session_refresh_token(headers: &HeaderMap, cookies: &Cookies) -> Option<String> {
    headers
        .get(MACRO_REFRESH_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .or_else(|| {
            cookies
                .get(&refresh_token_cookie_name())
                .map(|cookie| cookie.value().to_owned())
        })
        .filter(|token| !token.trim().is_empty())
}

/// What became of a signed-out session's refresh token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Revocation {
    /// The identity server no longer accepts it.
    Revoked,
    /// The request carried none.
    NoToken,
    /// The identity server could not be asked; the token stays valid until it
    /// expires.
    Failed,
}

impl Revocation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Revoked => "revoked",
            Self::NoToken => "no_token",
            Self::Failed => "failed",
        }
    }
}

/// Revokes the session's refresh token. Signing out still clears the
/// cookies when this fails, so a failure is logged, not returned.
async fn revoke_session(auth_client: &FusionAuthClient, refresh_token: Option<&str>) -> Revocation {
    let Some(refresh_token) = refresh_token else {
        return Revocation::NoToken;
    };
    match auth_client.revoke_refresh_token(refresh_token).await {
        Ok(()) => Revocation::Revoked,
        Err(error) => {
            tracing::warn!(error = ?error, "could not revoke the refresh token at sign-out");
            Revocation::Failed
        }
    }
}
