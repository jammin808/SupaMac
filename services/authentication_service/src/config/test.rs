use crate::service::signup_policy::SignupPolicyDenial;

use super::*;

fn config_values() -> serde_json::Value {
    let mut values = serde_json::json!({ "ENVIRONMENT": "local" });
    for key in [
        "BASE_URL",
        "DATABASE_URL",
        "REDIS_URI",
        "FUSIONAUTH_API_KEY_SECRET_KEY",
        "FUSIONAUTH_CLIENT_ID",
        "FUSIONAUTH_CLIENT_SECRET_KEY",
        "FUSIONAUTH_BASE_URL",
        "FUSIONAUTH_OAUTH_REDIRECT_URI",
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET_KEY",
        "MICROSOFT_CLIENT_ID",
        "MICROSOFT_CLIENT_SECRET",
        "MICROSOFT_TENANT_ID",
        "MICROSOFT_TOKEN_KMS_KEY_ID",
        "STRIPE_SECRET_KEY",
        "SERVICE_INTERNAL_AUTH_KEY",
        "GITHUB_CLIENT_ID",
        "GITHUB_CLIENT_SECRET",
        "GITHUB_IDP_ID",
        "ACCOUNT_LINK_STATE_SECRET",
        "STRIPE_PRICE_ID",
        "INTERNAL_API_KEY",
        "KAFKA_BROKERS",
    ] {
        values[key] = serde_json::json!("test");
    }
    values["AI_USAGE_FREE_INCLUDED_ALLOWANCE_CENTS"] = serde_json::json!(500);
    values["AI_USAGE_INCLUDED_ALLOWANCE_CENTS"] = serde_json::json!(2_000);
    values["AI_USAGE_MAX_INCLUDED_ALLOWANCE_CENTS"] = serde_json::json!(10_000);
    values["AI_USAGE_OVERAGE_MARKUP_PERCENT"] = serde_json::json!(5);
    values
}

#[test]
fn computer_retention_and_past_due_grace_default_to_two_weeks_and_a_week_and_refuse_zero() {
    let config: Config = serde_json::from_value(config_values()).unwrap();
    assert_eq!(
        config.computer_billing_policy().unwrap(),
        hosted_runtimes::domain::lifecycle::BillingPolicy::from_days(14, 7).unwrap()
    );
    for key in ["COMPUTER_RETENTION_DAYS", "COMPUTER_PAST_DUE_GRACE_DAYS"] {
        let mut missing = config_values();
        missing.as_object_mut().unwrap().remove(key);
        let config: Config = serde_json::from_value(missing).unwrap();
        assert_eq!(
            config.computer_billing_policy().unwrap(),
            hosted_runtimes::domain::lifecycle::BillingPolicy::from_days(14, 7).unwrap(),
            "{key} defaults"
        );
        let mut zero = config_values();
        zero[key] = serde_json::json!(0);
        let config: Config = serde_json::from_value(zero).unwrap();
        assert!(
            config
                .computer_billing_policy()
                .unwrap_err()
                .to_string()
                .contains(key),
            "{key}"
        );
    }
}

#[test]
fn ai_pricing_is_mandatory_and_validated() {
    use ai_billing::PlanTier;

    let config: Config = serde_json::from_value(config_values()).unwrap();
    let pricing = config.ai_pricing();
    assert_eq!(pricing.included_allowance_cents_for(PlanTier::Free), 500);
    assert_eq!(
        pricing.included_allowance_cents_for(PlanTier::Premium),
        2_000
    );
    assert_eq!(pricing.included_allowance_cents_for(PlanTier::Max), 10_000);
    assert_eq!(pricing.overage_markup_percent(), 5);

    for key in [
        "AI_USAGE_FREE_INCLUDED_ALLOWANCE_CENTS",
        "AI_USAGE_INCLUDED_ALLOWANCE_CENTS",
        "AI_USAGE_MAX_INCLUDED_ALLOWANCE_CENTS",
        "AI_USAGE_OVERAGE_MARKUP_PERCENT",
    ] {
        let mut values = config_values();
        values.as_object_mut().unwrap().remove(key);
        assert!(
            serde_json::from_value::<Config>(values.clone()).is_err(),
            "{key} must be mandatory"
        );
        values[key] = serde_json::json!("2000");
        assert!(
            serde_json::from_value::<Config>(values).is_err(),
            "{key} must be an integer"
        );
    }
    let mut values = config_values();
    values["AI_USAGE_OVERAGE_MARKUP_PERCENT"] = serde_json::json!(100);
    assert!(serde_json::from_value::<Config>(values).is_err());
    for key in [
        "AI_USAGE_FREE_INCLUDED_ALLOWANCE_CENTS",
        "AI_USAGE_INCLUDED_ALLOWANCE_CENTS",
        "AI_USAGE_MAX_INCLUDED_ALLOWANCE_CENTS",
    ] {
        let mut values = config_values();
        values[key] = serde_json::json!(-1);
        assert!(
            serde_json::from_value::<Config>(values).is_err(),
            "{key} must be non-negative"
        );
    }
}

#[test]
fn billing_enforcement_config_defaults_off_and_requires_a_boolean() {
    let mut values = config_values();
    let config: Config = serde_json::from_value(values.clone()).unwrap();
    assert_eq!(
        config.enable_ai_usage_enforcement,
        ai_billing::AiUsageEnforcement::Disabled
    );
    for enabled in [false, true] {
        values["ENABLE_AI_USAGE_ENFORCEMENT"] = serde_json::json!(enabled);
        let config: Config = serde_json::from_value(values.clone()).unwrap();
        assert_eq!(config.enable_ai_usage_enforcement.is_enabled(), enabled);
    }
    values["ENABLE_AI_USAGE_ENFORCEMENT"] = serde_json::json!("invalid");
    assert!(serde_json::from_value::<Config>(values).is_err());
}

#[test]
fn billing_settlement_config_defaults_off_and_requires_a_boolean() {
    let mut values = config_values();
    let config: Config = serde_json::from_value(values.clone()).unwrap();
    assert_eq!(
        config.enable_ai_usage_billing,
        ai_billing::AiUsageBilling::Disabled
    );
    for enabled in [false, true] {
        values["ENABLE_AI_USAGE_BILLING"] = serde_json::json!(enabled);
        let config: Config = serde_json::from_value(values.clone()).unwrap();
        assert_eq!(config.enable_ai_usage_billing.is_enabled(), enabled);
        // The two policies are independent.
        assert!(!config.enable_ai_usage_enforcement.is_enabled());
    }
    values["ENABLE_AI_USAGE_BILLING"] = serde_json::json!("invalid");
    assert!(serde_json::from_value::<Config>(values).is_err());
}

#[test]
fn account_link_state_secret_is_mandatory_and_must_be_long_enough() {
    let mut values = config_values();
    values
        .as_object_mut()
        .unwrap()
        .remove("ACCOUNT_LINK_STATE_SECRET");
    assert!(
        serde_json::from_value::<Config>(values).is_err(),
        "ACCOUNT_LINK_STATE_SECRET must be mandatory"
    );

    // The placeholder value every other key uses is far too short to sign with.
    let config: Config = serde_json::from_value(config_values()).unwrap();
    let error = config
        .validate_account_link_state_secret()
        .expect_err("a short signing secret must be rejected");
    assert!(error.to_string().contains("ACCOUNT_LINK_STATE_SECRET"));

    let mut values = config_values();
    values["ACCOUNT_LINK_STATE_SECRET"] = serde_json::json!("x".repeat(32));
    let config: Config = serde_json::from_value(values).unwrap();
    config.validate_account_link_state_secret().unwrap();
    config.account_link_state_key().unwrap();
}

#[test]
fn complete_microsoft_credentials_are_resolved() {
    let credentials = resolve(
        Some("microsoft-client-id"),
        Some("microsoft-client-secret"),
        Some("microsoft-tenant-id"),
    )
    .expect("complete credentials should be valid");
    let Some(credentials) = credentials else {
        panic!("complete credentials should enable Microsoft OAuth");
    };

    assert_eq!(credentials.client_id, "microsoft-client-id");
    assert_eq!(credentials.client_secret, "microsoft-client-secret");
    assert_eq!(credentials.tenant_id, "microsoft-tenant-id");
    assert_eq!(credentials.token_kms_key_id, "microsoft-kms-key");
}

#[test]
fn absent_or_blank_microsoft_credentials_are_disabled() {
    let missing_values = [None, Some(""), Some(" \t ")];

    for client_id in missing_values {
        for client_secret in missing_values {
            for tenant_id in missing_values {
                let credentials = resolve(client_id, client_secret, tenant_id)
                    .expect("absent or blank credentials should be valid");
                assert!(credentials.is_none());
            }
        }
    }
}

#[test]
fn every_partial_microsoft_credential_combination_is_rejected() {
    for configured_fields in 1_u8..=6 {
        let client_id = (configured_fields & 0b001 != 0).then_some("microsoft-client-id");
        let client_secret = (configured_fields & 0b010 != 0).then_some("microsoft-client-secret");
        let tenant_id = (configured_fields & 0b100 != 0).then_some("microsoft-tenant-id");

        let error = resolve(client_id, client_secret, tenant_id)
            .err()
            .expect("partial credentials should be rejected");

        assert!(error.to_string().contains("must all be set"));
    }
}

#[test]
fn kms_key_is_required_when_microsoft_oauth_is_enabled() {
    for kms_key_id in [None, Some(""), Some(" \t ")] {
        let error = resolve_with_kms(
            Some("microsoft-client-id"),
            Some("microsoft-client-secret"),
            Some("microsoft-tenant-id"),
            kms_key_id,
        )
        .err()
        .expect("a KMS key is required with Microsoft credentials");

        assert!(error.to_string().contains("MICROSOFT_TOKEN_KMS_KEY_ID"));
    }
}

#[test]
fn kms_key_alone_does_not_enable_microsoft_oauth() {
    let credentials = resolve_with_kms(None, None, None, Some("microsoft-kms-key"))
        .expect("an unused KMS key should not enable Microsoft OAuth");

    assert!(credentials.is_none());
}

#[test]
fn blank_values_are_rejected_when_other_credentials_are_configured() {
    let partial_credentials = [
        (Some(" "), Some("client-secret"), Some("tenant-id")),
        (Some("client-id"), Some(" "), Some("tenant-id")),
        (Some("client-id"), Some("client-secret"), Some(" ")),
    ];

    for (client_id, client_secret, tenant_id) in partial_credentials {
        assert!(resolve(client_id, client_secret, tenant_id).is_err());
    }
}

fn resolve(
    client_id: Option<&'static str>,
    client_secret: Option<&'static str>,
    tenant_id: Option<&'static str>,
) -> anyhow::Result<Option<MicrosoftCredentials>> {
    resolve_with_kms(
        client_id,
        client_secret,
        tenant_id,
        Some("microsoft-kms-key"),
    )
}

fn resolve_with_kms(
    client_id: Option<&'static str>,
    client_secret: Option<&'static str>,
    tenant_id: Option<&'static str>,
    token_kms_key_id: Option<&'static str>,
) -> anyhow::Result<Option<MicrosoftCredentials>> {
    resolve_microsoft_credentials(
        &microsoft_client_id(client_id),
        &microsoft_client_secret(client_secret),
        &microsoft_tenant_id(tenant_id),
        &microsoft_token_kms_key_id(token_kms_key_id),
    )
}

fn microsoft_client_id(value: Option<&'static str>) -> MicrosoftClientId {
    match value {
        Some(value) => MicrosoftClientId::new_testing(value),
        None => MicrosoftClientId::new_unset(),
    }
}

fn microsoft_client_secret(value: Option<&'static str>) -> MicrosoftClientSecret {
    match value {
        Some(value) => MicrosoftClientSecret::new_testing(value),
        None => MicrosoftClientSecret::new_unset(),
    }
}

fn microsoft_tenant_id(value: Option<&'static str>) -> MicrosoftTenantId {
    match value {
        Some(value) => MicrosoftTenantId::new_testing(value),
        None => MicrosoftTenantId::new_unset(),
    }
}

fn microsoft_token_kms_key_id(value: Option<&'static str>) -> MicrosoftTokenKmsKeyId {
    match value {
        Some(value) => MicrosoftTokenKmsKeyId::new_testing(value),
        None => MicrosoftTokenKmsKeyId::new_unset(),
    }
}

fn development_allowlist(value: Option<&'static str>) -> DevelopmentSignupAllowlistJson {
    match value {
        Some(value) => DevelopmentSignupAllowlistJson::new_testing(value),
        None => DevelopmentSignupAllowlistJson::new_unset(),
    }
}

fn signup_allowlist(value: Option<&'static str>) -> SignupAllowlistJson {
    match value {
        Some(value) => SignupAllowlistJson::new_testing(value),
        None => SignupAllowlistJson::new_unset(),
    }
}

const ALLOWLIST_SETTING_CASES: [Option<&str>; 5] = [
    None,
    Some(""),
    Some(" \t "),
    Some("not-json-with-secret@example.test"),
    Some(r#"["allowed.user@example.test"]"#),
];

const UNLISTED_PUBLIC_EMAIL: &str = "unlisted.user@example.test";

#[test]
fn develop_config_enforces_allowlist_unless_bypassed() {
    for bypass in [None, Some(false)] {
        let mut values = config_values();
        values["ENVIRONMENT"] = serde_json::json!("develop");
        values["DEVELOPMENT_SIGNUP_ALLOWLIST_JSON"] =
            serde_json::json!(r#"["allowed.user@example.test"]"#);
        if let Some(bypass) = bypass {
            values["DEVELOPMENT_BYPASS_SIGNUP_ALLOWLIST"] = serde_json::json!(bypass);
        }
        let config: Config = serde_json::from_value(values).unwrap();

        // Exercise both runtime startup and the Doppler validator's entry point.
        for policy in [
            config.signup_policy().unwrap(),
            config
                .signup_policy_for_environment(Environment::Develop)
                .unwrap(),
        ] {
            assert_eq!(
                policy.authorize_public_email(UNLISTED_PUBLIC_EMAIL),
                Err(SignupPolicyDenial::PublicEmailNotAllowed)
            );
            assert_eq!(policy.authorize_public_email("new.user@macro.com"), Ok(()));
            assert_eq!(
                policy.authorize_public_email("allowed.user@example.test"),
                Ok(())
            );
        }
    }
}

#[test]
fn develop_config_without_allowlist_fails_unless_bypassed() {
    for bypass in [None, Some(false)] {
        let mut values = config_values();
        values["ENVIRONMENT"] = serde_json::json!("develop");
        if let Some(bypass) = bypass {
            values["DEVELOPMENT_BYPASS_SIGNUP_ALLOWLIST"] = serde_json::json!(bypass);
        }
        let config: Config = serde_json::from_value(values).unwrap();

        assert!(config.signup_policy().is_err());
        assert!(
            config
                .signup_policy_for_environment(Environment::Develop)
                .is_err()
        );
    }
}

#[test]
fn production_and_local_config_allow_unlisted_signups() {
    for (environment_name, environment) in [
        ("production", Environment::Production),
        ("local", Environment::Local),
    ] {
        let mut values = config_values();
        values["ENVIRONMENT"] = serde_json::json!(environment_name);
        let config: Config = serde_json::from_value(values).unwrap();

        for policy in [
            config.signup_policy().unwrap(),
            config.signup_policy_for_environment(environment).unwrap(),
        ] {
            assert_eq!(policy.authorize_public_email(UNLISTED_PUBLIC_EMAIL), Ok(()));
        }
    }
}

#[test]
fn develop_signup_policy_requires_configured_allowlist() {
    for value in [None, Some(""), Some(" \t ")] {
        let error = resolve_signup_policy(
            Environment::Develop,
            false,
            &development_allowlist(value),
            &signup_allowlist(None),
        )
        .expect_err("Develop should require a nonblank allowlist setting");

        assert!(
            error
                .to_string()
                .contains("DEVELOPMENT_SIGNUP_ALLOWLIST_JSON")
        );
    }
}

#[test]
fn develop_signup_policy_uses_configured_allowlist() {
    let policy = resolve_signup_policy(
        Environment::Develop,
        false,
        &development_allowlist(Some(
            r#"["Allowed.User@example.test", "allowed.user@example.test"]"#,
        )),
        &signup_allowlist(None),
    )
    .expect("valid Develop allowlist should resolve");

    assert_eq!(policy.allowed_email_count(), Some(1));
    policy
        .authorize_public_email("allowed.user@example.test")
        .expect("configured email should be allowed");
    assert_eq!(
        policy.authorize_public_email(UNLISTED_PUBLIC_EMAIL),
        Err(SignupPolicyDenial::PublicEmailNotAllowed)
    );
}

#[test]
fn develop_signup_policy_rejects_malformed_allowlist_without_leaking_value() {
    let configured_value = "not-json-with-secret@example.test";
    let error = resolve_signup_policy(
        Environment::Develop,
        false,
        &development_allowlist(Some(configured_value)),
        &signup_allowlist(None),
    )
    .expect_err("malformed Develop allowlist should be rejected");
    let message = error.to_string();

    assert!(message.contains("DEVELOPMENT_SIGNUP_ALLOWLIST_JSON"));
    assert!(!message.contains(configured_value));
    assert!(!format!("{error:?}").contains(configured_value));
}

#[test]
fn develop_signup_policy_bypass_ignores_allowlist_setting() {
    for value in ALLOWLIST_SETTING_CASES {
        let policy = resolve_signup_policy(
            Environment::Develop,
            true,
            &development_allowlist(value),
            &signup_allowlist(None),
        )
        .expect("Develop bypass should not parse the allowlist setting");

        assert_eq!(policy.allowed_email_count(), None);
        assert_eq!(policy.authorize_public_email(UNLISTED_PUBLIC_EMAIL), Ok(()));
    }
}

#[test]
fn production_and_local_signup_policy_ignore_allowlist_and_bypass() {
    for environment in [Environment::Production, Environment::Local] {
        for bypass in [false, true] {
            for value in ALLOWLIST_SETTING_CASES {
                let policy = resolve_signup_policy(
                    environment,
                    bypass,
                    &development_allowlist(value),
                    &signup_allowlist(None),
                )
                .expect("non-Develop environments should not parse the allowlist setting");

                assert_eq!(policy.allowed_email_count(), None);
                policy
                    .authorize_public_email("anyone@example.test")
                    .expect("non-Develop environments should allow all public signups");
            }
        }
    }
}

#[test]
fn local_config_with_signup_allowlist_admits_only_listed_addresses() {
    let mut values = config_values();
    values["SIGNUP_ALLOWLIST_JSON"] =
        serde_json::json!(r#"["owner@example.test", "listed.user@macro.com"]"#);
    let config: Config = serde_json::from_value(values).unwrap();

    // Exercise both runtime startup and the Doppler validator's entry point.
    for policy in [
        config.signup_policy().unwrap(),
        config
            .signup_policy_for_environment(Environment::Local)
            .unwrap(),
    ] {
        assert_eq!(policy.authorize_public_email("owner@example.test"), Ok(()));
        assert_eq!(
            policy.authorize_public_email("listed.user@macro.com"),
            Ok(())
        );
        assert_eq!(
            policy.authorize_public_email(UNLISTED_PUBLIC_EMAIL),
            Err(SignupPolicyDenial::PublicEmailNotAllowed)
        );
        assert_eq!(
            policy.authorize_public_email("new.user@macro.com"),
            Err(SignupPolicyDenial::PublicEmailNotAllowed)
        );
    }
}

#[test]
fn local_signup_allowlist_that_is_blank_or_malformed_fails_without_leaking_value() {
    for configured_value in [
        "",
        " \t ",
        "not-json-with-secret@example.test",
        "[]",
        r#"{"email":"secret-address@example.test"}"#,
        r#"["secret-address@example.test", "@example.test"]"#,
    ] {
        let error = resolve_signup_policy(
            Environment::Local,
            false,
            &development_allowlist(None),
            &signup_allowlist(Some(configured_value)),
        )
        .expect_err("a set but unusable Local allowlist must not open signup");

        for message in [error.to_string(), format!("{error:?}")] {
            assert!(message.contains("SIGNUP_ALLOWLIST_JSON"), "{message}");
            assert!(!message.contains("secret"), "{message}");
        }
    }
}

#[test]
fn production_and_develop_ignore_the_local_signup_allowlist() {
    for value in ALLOWLIST_SETTING_CASES {
        let policy = resolve_signup_policy(
            Environment::Production,
            false,
            &development_allowlist(None),
            &signup_allowlist(value),
        )
        .expect("Production should not parse the Local allowlist setting");

        assert_eq!(policy.allowed_email_count(), None);
    }

    let policy = resolve_signup_policy(
        Environment::Develop,
        false,
        &development_allowlist(Some(r#"["allowed.user@example.test"]"#)),
        &signup_allowlist(Some(r#"["owner@example.test"]"#)),
    )
    .expect("Develop should resolve its own allowlist");

    assert_eq!(policy.authorize_public_email("new.user@macro.com"), Ok(()));
    assert_eq!(
        policy.authorize_public_email("allowed.user@example.test"),
        Ok(())
    );
    assert_eq!(
        policy.authorize_public_email("owner@example.test"),
        Err(SignupPolicyDenial::PublicEmailNotAllowed)
    );
}

#[test]
fn local_session_cookies_cross_sites_only_with_the_dev_flag() {
    let config: Config = serde_json::from_value(config_values()).unwrap();
    assert_eq!(config.session_cookie_same_site().unwrap(), SameSite::Strict);

    let mut values = config_values();
    values["DEV_DANGEROUS_CROSS_SITE_COOKIES"] = serde_json::json!(false);
    let config: Config = serde_json::from_value(values.clone()).unwrap();
    assert_eq!(config.session_cookie_same_site().unwrap(), SameSite::Strict);

    values["DEV_DANGEROUS_CROSS_SITE_COOKIES"] = serde_json::json!(true);
    let config: Config = serde_json::from_value(values).unwrap();
    assert_eq!(config.session_cookie_same_site().unwrap(), SameSite::None);
}

#[test]
fn production_and_develop_keep_their_session_cookies_and_refuse_the_dev_flag() {
    for (environment_name, same_site) in [
        ("production", SameSite::Strict),
        ("develop", SameSite::None),
    ] {
        let mut values = config_values();
        values["ENVIRONMENT"] = serde_json::json!(environment_name);
        let config: Config = serde_json::from_value(values.clone()).unwrap();
        assert_eq!(
            config.session_cookie_same_site().unwrap(),
            same_site,
            "{environment_name}"
        );

        values["DEV_DANGEROUS_CROSS_SITE_COOKIES"] = serde_json::json!(true);
        let config: Config = serde_json::from_value(values).unwrap();
        let error = config
            .session_cookie_same_site()
            .expect_err("the dev flag must be refused outside Local");
        assert!(
            error.to_string().contains(
                "DEV_DANGEROUS_CROSS_SITE_COOKIES is only allowed when ENVIRONMENT=local"
            ),
            "{environment_name}"
        );
    }
}

#[test]
fn support_channel_participants_keep_the_macro_team_unless_configured() {
    let config: Config = serde_json::from_value(config_values()).unwrap();
    assert_eq!(config.support_channel_participants().unwrap(), None);

    let mut values = config_values();
    values["SUPPORT_CHANNEL_PARTICIPANTS_JSON"] = serde_json::json!("[]");
    let config: Config = serde_json::from_value(values).unwrap();
    assert_eq!(
        config.support_channel_participants().unwrap(),
        Some(HashSet::new())
    );

    let mut values = config_values();
    values["SUPPORT_CHANNEL_PARTICIPANTS_JSON"] =
        serde_json::json!(r#"[" Owner@Example.Test ", "owner@example.test"]"#);
    let config: Config = serde_json::from_value(values).unwrap();
    assert_eq!(
        config.support_channel_participants().unwrap(),
        Some(HashSet::from([MacroUserIdStr::try_from_email(
            "owner@example.test"
        )
        .unwrap()]))
    );
}

#[test]
fn support_channel_participants_that_are_blank_or_malformed_fail_without_leaking_value() {
    for configured_value in [
        "",
        " \t ",
        "secret-address@example.test",
        r#"{"email":"secret-address@example.test"}"#,
        r#"["secret-address@example.test", 42]"#,
        r#"["secret-address@example.test", "not-an-email"]"#,
    ] {
        let error = resolve_support_channel_participants(
            &SupportChannelParticipantsJson::new_testing(configured_value),
        )
        .expect_err("a set but unusable list must not fall back to the Macro team");

        for message in [error.to_string(), format!("{error:?}")] {
            assert!(
                message.contains("SUPPORT_CHANNEL_PARTICIPANTS_JSON"),
                "{message}"
            );
            assert!(!message.contains("secret"), "{message}");
            assert!(!message.contains("not-an-email"), "{message}");
        }
    }
}

#[test]
fn auth_sender_address_defaults_and_must_be_an_email_address() {
    assert_eq!(
        resolve_auth_sender_address(&AuthSenderAddress::new_unset()).unwrap(),
        "auth@macro.com"
    );

    assert_eq!(
        resolve_auth_sender_address(&AuthSenderAddress::new_testing("auth@example.test")).unwrap(),
        "auth@example.test"
    );

    for invalid in ["", " \t ", "example.test", "Auth <auth@example.test>"] {
        let error = resolve_auth_sender_address(&AuthSenderAddress::new_testing(invalid))
            .expect_err("a sender that is not an address must fail startup");
        assert!(
            error.to_string().contains("AUTH_SENDER_ADDRESS"),
            "{invalid}"
        );
    }
}

#[test]
fn cursor_kms_key_from_config_field() {
    let configured = CursorApiKeyKmsKeyId::new_testing("arn:aws:kms:from-config");
    assert_eq!(
        resolve_cursor_api_key_kms_key_id(&configured, None).unwrap(),
        "arn:aws:kms:from-config"
    );
}

#[test]
fn cursor_kms_key_from_process_env_when_config_unset() {
    let configured = CursorApiKeyKmsKeyId::new_unset();
    assert_eq!(
        resolve_cursor_api_key_kms_key_id(&configured, Some("arn:aws:kms:from-env")).unwrap(),
        "arn:aws:kms:from-env"
    );
}

#[test]
fn cursor_kms_key_prefers_config_over_process_env() {
    let configured = CursorApiKeyKmsKeyId::new_testing("arn:aws:kms:from-config");
    assert_eq!(
        resolve_cursor_api_key_kms_key_id(&configured, Some("arn:aws:kms:from-env")).unwrap(),
        "arn:aws:kms:from-config"
    );
}

#[test]
fn cursor_kms_key_blank_config_falls_back_to_process_env() {
    let configured = CursorApiKeyKmsKeyId::new_testing("  ");
    assert_eq!(
        resolve_cursor_api_key_kms_key_id(&configured, Some("arn:aws:kms:from-env")).unwrap(),
        "arn:aws:kms:from-env"
    );
}

#[test]
fn cursor_kms_key_required_when_both_absent() {
    let configured = CursorApiKeyKmsKeyId::new_unset();
    let error = resolve_cursor_api_key_kms_key_id(&configured, None).unwrap_err();
    assert!(error.to_string().contains("CURSOR_API_KEY_KMS_KEY_ID"));
}

#[test]
fn configured_computer_prices_require_the_complete_group_at_startup() {
    let config: Config = serde_json::from_value(config_values()).unwrap();
    config.validate_computer_config().unwrap();

    let keys = [
        "STRIPE_COMPUTER_STANDARD_MONTHLY_PRICE_ID",
        "STRIPE_COMPUTER_LARGE_MONTHLY_PRICE_ID",
        "STRIPE_COMPUTER_XL_MONTHLY_PRICE_ID",
        "STRIPE_COMPUTER_STANDARD_YEARLY_PRICE_ID",
        "STRIPE_COMPUTER_LARGE_YEARLY_PRICE_ID",
        "STRIPE_COMPUTER_XL_YEARLY_PRICE_ID",
    ];
    let mut values = config_values();
    for key in keys {
        values[key] = serde_json::json!("price_test");
    }
    let config: Config = serde_json::from_value(values.clone()).unwrap();
    config.validate_computer_config().unwrap();
    for key in keys {
        for missing in [serde_json::Value::Null, serde_json::json!(" ")] {
            let mut incomplete = values.clone();
            incomplete[key] = missing;
            let config: Config = serde_json::from_value(incomplete).unwrap();
            assert!(
                config
                    .validate_computer_config()
                    .unwrap_err()
                    .to_string()
                    .contains(key)
            );
        }
    }
}

#[test]
fn computer_prices_reject_malformed_configured_ids_even_without_a_fleet() {
    for value in [
        "",
        " ",
        "prod_test",
        "price_",
        "price_bad id",
        "price_bad\n",
    ] {
        let mut values = config_values();
        for key in [
            "STRIPE_COMPUTER_STANDARD_MONTHLY_PRICE_ID",
            "STRIPE_COMPUTER_LARGE_MONTHLY_PRICE_ID",
            "STRIPE_COMPUTER_XL_MONTHLY_PRICE_ID",
            "STRIPE_COMPUTER_STANDARD_YEARLY_PRICE_ID",
            "STRIPE_COMPUTER_LARGE_YEARLY_PRICE_ID",
            "STRIPE_COMPUTER_XL_YEARLY_PRICE_ID",
        ] {
            values[key] = serde_json::json!("price_test");
        }
        values["STRIPE_COMPUTER_STANDARD_MONTHLY_PRICE_ID"] = serde_json::json!(value);
        let config: Config = serde_json::from_value(values).unwrap();
        assert!(config.computer_prices().is_err(), "{value:?}");
    }
}

#[test]
fn partial_computer_prices_fail_without_a_fleet() {
    let keys = [
        "STRIPE_COMPUTER_STANDARD_MONTHLY_PRICE_ID",
        "STRIPE_COMPUTER_LARGE_MONTHLY_PRICE_ID",
        "STRIPE_COMPUTER_XL_MONTHLY_PRICE_ID",
        "STRIPE_COMPUTER_STANDARD_YEARLY_PRICE_ID",
        "STRIPE_COMPUTER_LARGE_YEARLY_PRICE_ID",
        "STRIPE_COMPUTER_XL_YEARLY_PRICE_ID",
    ];
    for mask in 0_u8..64 {
        let mut values = config_values();
        for (index, key) in keys.iter().enumerate() {
            if mask & (1 << index) != 0 {
                values[key] = serde_json::json!("price_test");
            }
        }
        let config: Config = serde_json::from_value(values).unwrap();
        match mask {
            0 => assert!(config.computer_prices().unwrap().is_empty()),
            63 => assert!(!config.computer_prices().unwrap().is_empty()),
            _ => assert!(config.computer_prices().is_err(), "partial group {mask}"),
        }
    }
}

#[test]
fn absent_fleet_keeps_optional_computer_prices_and_rejects_partial_prices() {
    let mut values = config_values();
    let config: Config = serde_json::from_value(values.clone()).unwrap();
    config.validate_computer_config().unwrap();

    values["STRIPE_COMPUTER_STANDARD_MONTHLY_PRICE_ID"] = serde_json::json!("price_test");
    let config: Config = serde_json::from_value(values).unwrap();
    assert!(config.validate_computer_config().is_err());
}

/// Without a fleet the agents worker never runs; only an explicit `true`
/// turns it on, and a typo fails startup instead of silently disabling it.
#[test]
fn the_computers_agents_worker_is_off_unless_turned_on() {
    let config: Config = serde_json::from_value(config_values()).unwrap();
    assert!(!config.computer_agent_effects().unwrap());

    for (value, enabled) in [("true", true), ("false", false)] {
        let mut values = config_values();
        values["COMPUTERS_AGENT_EFFECTS"] = serde_json::json!(value);
        let config: Config = serde_json::from_value(values).unwrap();
        assert_eq!(config.computer_agent_effects().unwrap(), enabled, "{value}");
    }

    let mut values = config_values();
    values["COMPUTERS_AGENT_EFFECTS"] = serde_json::json!("yes");
    let config: Config = serde_json::from_value(values).unwrap();
    assert!(config.computer_agent_effects().is_err());
}
