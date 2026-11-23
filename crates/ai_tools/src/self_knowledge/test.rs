use super::{ABOUT_MACRO, SelfKnowledge};

/// The page and the tool's schema are what the model reads; neither may send
/// it, or the user it answers, to a documentation site off this deployment.
#[test]
fn about_page_and_schema_link_no_site() {
    let schema = schemars::schema_for!(SelfKnowledge).to_value();
    let description = schema["description"].as_str().expect("a tool description");
    for (name, text) in [("about page", ABOUT_MACRO), ("description", description)] {
        for needle in ["://", "macro.com"] {
            assert!(!text.contains(needle), "{name} mentions {needle:?}");
        }
    }
    assert!(!schema.to_string().contains("macro.com"), "{schema}");
}

#[test]
fn about_page_still_describes_every_block() {
    for block in [
        "**Email**",
        "**Channels**",
        "**Tasks**",
        "**Docs**",
        "**Canvas**",
        "**Calls**",
        "**CRM**",
        "**Folders**",
        "**Agents**",
    ] {
        assert!(ABOUT_MACRO.contains(block), "about page is missing {block}");
    }
}

#[test]
fn about_page_never_teaches_the_retired_webhook_setup() {
    for retired in [
        "macro-events",
        "8790",
        "bot_token",
        "bot_scope",
        "public_url",
        "available soon",
        "Make this bot a coding agent",
        "npx -y @agentclientprotocol",
        "macro.toml",
        "trycloudflare",
    ] {
        assert!(
            !ABOUT_MACRO.contains(retired),
            "about page mentions retired setup detail {retired:?}"
        );
    }
}
