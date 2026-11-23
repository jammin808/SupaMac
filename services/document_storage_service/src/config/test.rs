use super::{Config, Environment, webhook_endpoint_scheme_policy};
use webhook::domain::models::WebhookEndpointSchemePolicy;

#[test]
fn missing_posthog_key_fails_config_loading() {
    let error = serde_json::from_value::<Config>(serde_json::json!({}))
        .err()
        .expect("missing PostHog configuration must fail startup");

    assert!(
        error
            .to_string()
            .contains("missing field `POSTHOG_API_KEY`")
    );
}

#[test]
fn webhook_endpoints_may_be_http_or_private_only_by_local_opt_in() {
    assert_eq!(
        webhook_endpoint_scheme_policy(Environment::Local, false).unwrap(),
        WebhookEndpointSchemePolicy::HttpsOnly
    );
    assert_eq!(
        webhook_endpoint_scheme_policy(Environment::Local, true).unwrap(),
        WebhookEndpointSchemePolicy::HttpAndHttps
    );

    for environment in [Environment::Develop, Environment::Production] {
        assert_eq!(
            webhook_endpoint_scheme_policy(environment, false).unwrap(),
            WebhookEndpointSchemePolicy::HttpsOnly,
            "{environment:?}"
        );
        let error = webhook_endpoint_scheme_policy(environment, true).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("DEV_DANGEROUS_PRIVATE_WEBHOOK_ENDPOINTS"),
            "{environment:?}: the error names the setting: {error}"
        );
    }
}
