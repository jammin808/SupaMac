use super::*;

#[test]
fn built_in_list_allows_localhost_and_subdomain_localhost_dev_ports() {
    for origin in [
        "http://localhost:3000",
        "http://localhost:3999",
        "http://localhost:20000",
        "http://alice.localhost:3000",
        "http://carol.localhost:3005",
    ] {
        assert!(OriginAllowList::BuiltIn.allows(origin), "{origin}");
    }
}

#[test]
fn built_in_list_rejects_non_local_and_out_of_range_origins() {
    for origin in [
        "http://localhost:2999",
        "http://localhost:9000",
        "http://alice.localhost:9000",
        "https://alice.localhost:3000",
        "http://evil-localhost:3000",
        "http://alice.localhost.evil.com:3000",
        "http://example.com:3000",
    ] {
        assert!(!OriginAllowList::BuiltIn.allows(origin), "{origin}");
    }
}

#[test]
fn built_in_list_allows_static_and_preview_origins() {
    assert!(OriginAllowList::BuiltIn.allows("https://macro.com"));
    assert!(OriginAllowList::BuiltIn.allows("tauri://localhost"));
    assert!(OriginAllowList::BuiltIn.allows("https://feature.preview.macro.com"));
}

#[test]
fn configuration_naming_no_origin_is_the_built_in_list() {
    assert_eq!(OriginAllowList::parse(None), OriginAllowList::BuiltIn);
    assert_eq!(OriginAllowList::parse(Some("")), OriginAllowList::BuiltIn);
    assert_eq!(
        OriginAllowList::parse(Some(" , ")),
        OriginAllowList::BuiltIn
    );
}

#[test]
fn configured_origins_are_the_whole_list() {
    let origins = OriginAllowList::parse(Some("https://example.com, https://app.example.com"));

    assert!(origins.allows("https://example.com"));
    assert!(origins.allows("https://app.example.com"));

    for origin in [
        "https://macro.com",
        "tauri://localhost",
        "https://feature.preview.macro.com",
        "http://localhost:3000",
        "http://alice.localhost:3005",
        "http://example.com",
        "https://example.com:8443",
        "https://example.com/",
        "https://evil.example.com",
        "https://example.com.evil.test",
        "",
    ] {
        assert!(!origins.allows(origin), "{origin}");
    }
}

#[test]
fn configured_list_admits_upgrades_only_from_listed_origins() {
    let origins = OriginAllowList::parse(Some("https://example.com, tauri://localhost"));

    for origin in ["https://example.com", "tauri://localhost"] {
        assert!(
            origins.allows_upgrade(Some(&HeaderValue::from_static(origin))),
            "{origin}"
        );
    }

    for origin in [
        "https://attacker.example",
        "https://api.example.com",
        "http://example.com",
        "https://example.com:8443",
        "https://macro.com",
        "https://feature.preview.macro.com",
        "http://localhost:3000",
        "null",
    ] {
        assert!(
            !origins.allows_upgrade(Some(&HeaderValue::from_static(origin))),
            "{origin}"
        );
    }
}

#[test]
fn configured_list_refuses_an_upgrade_whose_origin_is_not_text() {
    let origins = OriginAllowList::parse(Some("https://example.com"));
    let origin = HeaderValue::from_bytes(b"https://example.com\xff").unwrap();

    assert!(!origins.allows_upgrade(Some(&origin)));
}

#[test]
fn upgrade_without_an_origin_passes_either_list() {
    let configured = OriginAllowList::parse(Some("https://example.com"));

    assert!(configured.allows_upgrade(None));
    assert!(OriginAllowList::BuiltIn.allows_upgrade(None));
}

#[test]
fn built_in_list_leaves_upgrades_unchecked() {
    for origin in [
        "https://macro.com",
        "https://localhost:8443",
        "https://attacker.example",
    ] {
        assert!(
            OriginAllowList::BuiltIn.allows_upgrade(Some(&HeaderValue::from_static(origin))),
            "{origin}"
        );
    }
}

#[tokio::test]
async fn configured_list_answers_only_listed_origins() {
    use axum::{
        Router,
        body::Body,
        http::{Request, header},
        routing::get,
    };
    use tower::ServiceExt;

    let app = Router::new()
        .route("/items", get(|| async {}))
        .layer(cors_layer_for(
            OriginAllowList::parse(Some("https://example.com")),
            vec![],
        ));

    let listed = Request::builder()
        .uri("/items")
        .header(header::ORIGIN, "https://example.com")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(listed).await.unwrap();

    assert_eq!(
        response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
        "https://example.com"
    );
    assert_eq!(
        response.headers()[header::ACCESS_CONTROL_ALLOW_CREDENTIALS],
        "true"
    );

    for origin in [
        "https://macro.com",
        "https://feature.preview.macro.com",
        "http://localhost:3000",
    ] {
        let unlisted = Request::builder()
            .uri("/items")
            .header(header::ORIGIN, origin)
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(unlisted).await.unwrap();

        assert!(
            !response
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            "{origin}"
        );
    }
}

#[tokio::test]
async fn preflight_is_cacheable_for_two_hours() {
    use axum::{
        Router,
        body::Body,
        http::{Request, header},
        routing::post,
    };
    use tower::ServiceExt;

    let app = Router::new()
        .route("/items/soup/graphql", post(|| async {}))
        .layer(cors_layer_for(OriginAllowList::BuiltIn, vec![]));
    let preflight = Request::builder()
        .method(Method::OPTIONS)
        .uri("/items/soup/graphql")
        .header(header::ORIGIN, "https://macro.com")
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
        .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "content-type")
        .body(Body::empty())
        .unwrap();

    let response = app.oneshot(preflight).await.unwrap();

    assert_eq!(response.headers()[header::ACCESS_CONTROL_MAX_AGE], "7200");
}
