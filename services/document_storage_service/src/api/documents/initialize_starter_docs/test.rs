use super::*;

fn templates() -> impl Iterator<Item = &'static str> {
    std::iter::once(HOW_TO_GUIDE_TEMPLATE).chain(STARTER_TASKS.iter().map(|task| task.template))
}

#[test]
fn templates_link_only_to_the_deployments_web_app() {
    for template in templates() {
        assert!(!template.contains("macro.com"), "{template}");
        assert!(!template.contains("](http"), "{template}");
    }
    assert!(templates().any(|template| template.contains("](WEB_APP_URL/settings/shortcuts)")));
}

#[test]
fn links_start_from_the_root_the_invitation_emails_use() {
    assert_eq!(
        format!("{}/", web_app_url()),
        invite_email::web_app_url().as_str()
    );
    assert!(!web_app_url().ends_with('/'));
    assert_eq!(
        "[keyboard shortcuts reference](WEB_APP_URL/settings/shortcuts)"
            .replace(WEB_APP_URL_PLACEHOLDER, web_app_url()),
        format!(
            "[keyboard shortcuts reference]({}settings/shortcuts)",
            invite_email::web_app_url()
        )
    );
}
