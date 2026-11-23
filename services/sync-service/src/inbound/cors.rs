#[cfg(test)]
mod test;

use worker::{Cors, Env};

/// The worker variable that names the allowed origins, comma-separated, each
/// as a browser sends it in `Origin`: `scheme://host[:port]`.
const ALLOWED_ORIGINS_VAR: &str = "ALLOWED_ORIGINS";

/// Origins of a developer's machine and the mobile app's webview. A
/// deployment names its own origins in `ALLOWED_ORIGINS`.
static BUILT_IN_ORIGINS: &[&str] = &[
    "http://localhost:5173",
    "http://localhost:3000",
    "http://host.local:3000",
    "capacitor://localhost",
];

/// Which browser origins may call this worker. Follows
/// `macro_cors::OriginAllowList`, which the axum services use; this worker
/// can't share that type because its crate is built on tower-http.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OriginAllowList {
    /// `ALLOWED_ORIGINS` names no origin: the built-in origins and loopback
    /// development ports, and no public origin.
    BuiltIn,
    /// `ALLOWED_ORIGINS` names these origins: they are allowed, compared
    /// exactly, and nothing else is.
    Exact(Vec<String>),
}

impl OriginAllowList {
    /// Reads the allow-list from the `ALLOWED_ORIGINS` worker variable.
    pub fn from_env(env: &Env) -> Self {
        let configured = env
            .var(ALLOWED_ORIGINS_VAR)
            .ok()
            .map(|value| value.to_string());

        Self::parse(configured.as_deref())
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
}

fn is_built_in_origin(origin: &str) -> bool {
    if BUILT_IN_ORIGINS.contains(&origin) {
        return true;
    }
    // `localhost` and `*.localhost` (loopback-reserved; local dev uses
    // per-persona hostnames so each seeded user gets its own cookie jar).
    if let Some(rest) = origin.strip_prefix("http://")
        && let Some((host, port)) = rest.rsplit_once(':')
        && (host == "localhost" || host.ends_with(".localhost"))
        && let Ok(port) = port.parse::<u16>()
    {
        return (3000..=3999).contains(&port) || (20000..=60000).contains(&port);
    }
    false
}

/// Workaround for this bug: <https://github.com/cloudflare/workers-rs/issues/554>
pub fn cors(origins: &OriginAllowList, request_origin: Option<&str>) -> Cors {
    use worker::Method;
    let cors_origins = request_origin
        .map(|o| {
            if origins.allows(o) {
                vec![o.to_string()]
            } else {
                vec![]
            }
        })
        .unwrap_or_default();

    Cors::new()
        .with_credentials(true)
        // `traceparent`/`tracestate` are injected by the web client's traced
        // fetch wrapper (see `safeFetch`), so they must be preflight-allowed or
        // the browser blocks every instrumented call. Kept in sync with
        // `macro_cors::EXTRA_HEADERS`, which the axum services use; this worker
        // can't share that list because it's built on tower-http.
        .with_allowed_headers(vec![
            "authorization",
            "content-type",
            "traceparent",
            "tracestate",
        ])
        .with_methods(vec![
            Method::Get,
            Method::Post,
            Method::Put,
            Method::Patch,
            Method::Delete,
            Method::Options,
        ])
        .with_origins(cors_origins)
}
