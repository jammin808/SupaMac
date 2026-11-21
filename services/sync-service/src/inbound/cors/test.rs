use super::*;

#[test]
fn built_in_list_allows_upstream_hosts_dev_ports_and_previews() {
    for origin in [
        "http://localhost:5173",
        "http://localhost:3000",
        "http://localhost:3999",
        "http://localhost:20010",
        "http://alice.localhost:3005",
        "http://host.local:3000",
        "https://dev.macro.com",
        "https://macro.com",
        "capacitor://localhost",
        "https://my-feature-branch.preview.macro.com",
    ] {
        assert!(OriginAllowList::BuiltIn.allows(origin), "{origin}");
    }
}

#[test]
fn built_in_list_rejects_other_origins() {
    for origin in [
        "https://malicious.com",
        "http://localhost:8080",
        "https://evil.macro.com",
        "http://evil.preview.macro.com",
        "https://preview.macro.com",
        "https://evil.preview.macro.com.attacker.com",
        "https://example.com",
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
        "https://macro.com",
        "capacitor://localhost",
        "https://my-feature-branch.preview.macro.com",
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
