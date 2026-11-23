use super::*;

#[test]
fn built_in_list_allows_development_origins() {
    for origin in [
        "http://localhost:5173",
        "http://localhost:3000",
        "http://localhost:3999",
        "http://localhost:20010",
        "http://alice.localhost:3005",
        "http://host.local:3000",
        "capacitor://localhost",
    ] {
        assert!(OriginAllowList::BuiltIn.allows(origin), "{origin}");
    }
}

#[test]
fn built_in_list_allows_no_public_origin() {
    for origin in [
        "https://example.com",
        "https://www.example.com",
        "https://app.example.com",
        "https://my-feature-branch.preview.example.com",
        "https://example.com.evil.test",
        "http://localhost:8080",
        "https://localhost:3000",
        "",
    ] {
        assert!(!OriginAllowList::BuiltIn.allows(origin), "{origin}");
    }
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
        "capacitor://localhost",
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
