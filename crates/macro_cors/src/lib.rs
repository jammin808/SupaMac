//! The browser-origin policy the HTTP services share: the origin allow-list,
//! the CORS layer that enforces it, and its answer for WebSocket upgrades,
//! which CORS does not cover.
//!
//! `ALLOWED_ORIGINS` (comma-separated, each entry as a browser sends it in
//! `Origin`: `scheme://host[:port]`, no path or trailing slash) makes the
//! allow-list exactly those origins. Unset or blank, the built-in policy
//! applies: upstream's hosts, its preview deployments, and loopback
//! development ports.

#[cfg(test)]
mod test;

use std::time::Duration;

use axum::http::{
    HeaderName, HeaderValue, Method,
    header::{AUTHORIZATION, CONTENT_TYPE},
};
use tower_http::cors::{AllowOrigin, CorsLayer};

static BUILT_IN_ORIGINS: [&str; 11] = [
    "http://localhost:5173",
    "https://dashboarddev.macro.com",
    "https://dashboard.macro.com",
    "http://host.local:3000",
    "https://dev.macro.com",
    "https://staging.macro.com",
    "https://www.macro.com",
    "https://macro.com",
    "http://tauri.localhost",
    "tauri://localhost",
    "https://apollo-testing.macro.com",
];

static EXTRA_HEADERS: [&str; 4] = [
    "x-permissions-token",
    "traceparent",
    "tracestate",
    "x-email-link-id",
];

/// Chrome caps preflight caching at two hours. Without a max age it caches for
/// five seconds, so any API call after a short idle pays an extra round trip.
const PREFLIGHT_MAX_AGE: Duration = Duration::from_secs(2 * 60 * 60);

macro_env_var::maybe_env_var! {
    struct AllowedOrigins;
}

/// Which browser origins may make credentialed cross-origin requests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OriginAllowList {
    /// `ALLOWED_ORIGINS` names no origin: the built-in origins, preview
    /// deployments, and loopback development ports.
    BuiltIn,
    /// `ALLOWED_ORIGINS` names these origins: they are allowed, compared
    /// exactly, and nothing else is.
    Exact(Vec<String>),
}

impl OriginAllowList {
    /// Reads the allow-list from `ALLOWED_ORIGINS`.
    pub fn from_env() -> Self {
        let configured = AllowedOrigins::new();

        Self::parse(configured.as_ref().and_then(AllowedOrigins::value))
    }

    fn parse(configured: Option<&str>) -> Self {
        let origins: Vec<String> = configured
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|origin| !origin.is_empty())
            .map(str::to_owned)
            .collect();

        if origins.is_empty() {
            Self::BuiltIn
        } else {
            Self::Exact(origins)
        }
    }

    /// Whether `origin`, the value of an `Origin` header, is on the list.
    pub fn allows(&self, origin: &str) -> bool {
        match self {
            Self::BuiltIn => is_built_in_origin(origin),
            Self::Exact(origins) => origins.iter().any(|allowed| allowed == origin),
        }
    }

    /// Whether a WebSocket upgrade that carries `origin` may proceed.
    ///
    /// A browser attaches the visitor's cookies to an upgrade from any page,
    /// and CORS does not apply to it, so `Origin` is all that tells the app's
    /// own page from someone else's. Browsers always send it; a request
    /// without one comes from a native shell or a server-side caller, which
    /// no foreign page can steer.
    ///
    /// The built-in list does not decide upgrades: it serves stacks whose
    /// local proxies and development servers present origins it cannot name.
    pub fn allows_upgrade(&self, origin: Option<&HeaderValue>) -> bool {
        let Some(origin) = origin else {
            return true;
        };

        match self {
            Self::BuiltIn => true,
            Self::Exact(_) => origin.to_str().is_ok_and(|origin| self.allows(origin)),
        }
    }
}

fn is_built_in_origin(origin: &str) -> bool {
    if BUILT_IN_ORIGINS.contains(&origin) {
        return true;
    }

    // Allow all preview endpoints `https://*preview.macro.com`
    if origin.ends_with("preview.macro.com") && origin.starts_with("https://") {
        return true;
    }

    // `localhost` and `*.localhost` (loopback-reserved per RFC 6761; used
    // locally to give each seeded persona its own cookie jar per hostname).
    if let Some(rest) = origin.strip_prefix("http://")
        && let Some((host, port_str)) = rest.rsplit_once(':')
        && (host == "localhost" || host.ends_with(".localhost"))
        && let Ok(port) = port_str.parse::<u16>()
    {
        return (3000..=3999).contains(&port) || (20000..=60000).contains(&port);
    }

    false
}

/// Generates the Cors layer which can be used in the `ServiceBuilder::layer` method.
pub fn cors_layer() -> CorsLayer {
    cors_layer_with_headers(vec![])
}

/// Generates the Cors layer with additional headers which can be used in the `ServiceBuilder::layer` method.
pub fn cors_layer_with_headers(additional_headers: Vec<HeaderName>) -> CorsLayer {
    cors_layer_for(OriginAllowList::from_env(), additional_headers)
}

fn cors_layer_for(origins: OriginAllowList, additional_headers: Vec<HeaderName>) -> CorsLayer {
    let mut headers = vec![AUTHORIZATION, CONTENT_TYPE];
    headers.extend(additional_headers);
    headers.extend(
        EXTRA_HEADERS
            .iter()
            .map(|header| HeaderName::from_static(header)),
    );

    // The layer answers with the request's own origin only when the
    // predicate accepts it, so an origin off the list never receives
    // `Access-Control-Allow-Origin` and the browser withholds the response.
    CorsLayer::new()
        .max_age(PREFLIGHT_MAX_AGE)
        .allow_credentials(true)
        .allow_headers(headers)
        .allow_methods(vec![
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_origin(AllowOrigin::predicate(
            move |origin: &HeaderValue, _request_parts| {
                origin.to_str().is_ok_and(|origin| origins.allows(origin))
            },
        ))
}
