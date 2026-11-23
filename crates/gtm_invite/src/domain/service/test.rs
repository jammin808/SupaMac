use chrono::{Duration, Utc};
use macro_user_id::user_id::MacroUserIdStr;
use uuid::Uuid;

use crate::domain::{
    models::{
        CreateInviteLink, GtmInviteConfig, GtmInviteError, INVITE_TOKEN_LENGTH, InviteConversion,
        InviteLink, InviteLinkStatus, InviteRedemption, InviteToken, PromoCode,
    },
    ports::{GtmInviteService, MockGtmInviteRepo},
    service::{GtmInviteServiceImpl, normalize_create_request},
};

const TTL_HOURS: i64 = 48;

fn config() -> GtmInviteConfig {
    GtmInviteConfig {
        promo_code: "1MF".parse().unwrap(),
        link_ttl: Duration::hours(TTL_HOURS),
        free_months: 1,
    }
}

fn service(repo: MockGtmInviteRepo) -> GtmInviteServiceImpl<MockGtmInviteRepo> {
    GtmInviteServiceImpl {
        repo,
        config: config(),
    }
}

/// An address at the upstream staff domain, which grants nothing here.
fn upstream_staff() -> MacroUserIdStr<'static> {
    MacroUserIdStr::try_from_email("someone@macro.com").unwrap()
}

fn outsider() -> MacroUserIdStr<'static> {
    MacroUserIdStr::try_from_email("mallory@example.com").unwrap()
}

fn prospect() -> MacroUserIdStr<'static> {
    MacroUserIdStr::try_from_email("prospect@startup.io").unwrap()
}

fn other_prospect() -> MacroUserIdStr<'static> {
    MacroUserIdStr::try_from_email("someone-else@startup.io").unwrap()
}

fn create_request() -> CreateInviteLink {
    CreateInviteLink {
        first_name: "Ada".into(),
        recipient_email: Some("ada@startup.io".into()),
        note: Some("Met at the conference".into()),
    }
}

fn active_link() -> InviteLink {
    let now = Utc::now();
    InviteLink {
        id: Uuid::now_v7(),
        token: InviteToken::generate(),
        first_name: "Ada".into(),
        recipient_email: None,
        note: None,
        promo_code: "1MF".parse().unwrap(),
        created_by: upstream_staff(),
        created_at: now - Duration::hours(1),
        expires_at: now + Duration::hours(TTL_HOURS - 1),
        revoked_at: None,
        open_count: 0,
        first_opened_at: None,
        redemption: None,
    }
}

fn redeemed_by(link: InviteLink, user: MacroUserIdStr<'static>) -> InviteLink {
    InviteLink {
        redemption: Some(InviteRedemption {
            user_id: user,
            redeemed_at: Utc::now(),
            conversion: None,
        }),
        ..link
    }
}

fn converted(link: InviteLink) -> InviteLink {
    let redemption = link.redemption.map(|redemption| InviteRedemption {
        conversion: Some(InviteConversion {
            converted_at: Utc::now(),
            stripe_subscription_id: Some("sub_123".into()),
        }),
        ..redemption
    });
    InviteLink { redemption, ..link }
}

// -- create_link --

#[tokio::test]
async fn create_link_refuses_every_caller_without_touching_the_repo() {
    let svc = service(MockGtmInviteRepo::new());

    for caller in [outsider(), upstream_staff()] {
        let result = svc.create_link(&caller, create_request()).await;

        assert!(matches!(result, Err(GtmInviteError::Forbidden)));
    }
}

#[test]
fn generated_tokens_are_full_length_and_distinct() {
    let first = InviteToken::generate();
    let second = InviteToken::generate();

    assert_eq!(first.as_str().len(), INVITE_TOKEN_LENGTH);
    assert_ne!(first, second);
}

#[test]
fn normalize_rejects_blank_first_name() {
    let result = normalize_create_request(CreateInviteLink {
        first_name: "   ".into(),
        recipient_email: None,
        note: None,
    });

    assert!(matches!(result, Err(GtmInviteError::BadRequest(_))));
}

#[test]
fn normalize_rejects_invalid_recipient_email() {
    let result = normalize_create_request(CreateInviteLink {
        first_name: "Ada".into(),
        recipient_email: Some("not-an-email".into()),
        note: None,
    });

    assert!(matches!(result, Err(GtmInviteError::BadRequest(_))));
}

#[test]
fn normalize_trims_and_lowercases_input() {
    let normalized = normalize_create_request(CreateInviteLink {
        first_name: "  Ada ".into(),
        recipient_email: Some(" Ada@Startup.IO ".into()),
        note: Some("   ".into()),
    })
    .unwrap();

    assert_eq!(normalized.first_name, "Ada");
    assert_eq!(
        normalized.recipient_email.as_deref(),
        Some("ada@startup.io")
    );
    assert_eq!(normalized.note, None);
}

// -- list_links --

#[tokio::test]
async fn list_links_refuses_every_caller() {
    let svc = service(MockGtmInviteRepo::new());

    for caller in [outsider(), upstream_staff()] {
        for only_mine in [true, false] {
            let result = svc.list_links(&caller, only_mine).await;

            assert!(matches!(result, Err(GtmInviteError::Forbidden)));
        }
    }
}

// -- revoke_link --

#[tokio::test]
async fn revoke_link_refuses_every_caller_without_touching_the_repo() {
    let svc = service(MockGtmInviteRepo::new());

    for caller in [outsider(), upstream_staff()] {
        let result = svc.revoke_link(&caller, Uuid::now_v7()).await;

        assert!(matches!(result, Err(GtmInviteError::Forbidden)));
    }
}

// -- resolve_link --

#[tokio::test]
async fn resolve_link_counts_the_open_and_returns_the_link() {
    let link = active_link();
    let id = link.id;
    let mut repo = MockGtmInviteRepo::new();
    repo.expect_get_link_by_token().returning(move |_| {
        let link = link.clone();
        Box::pin(async move { Ok(Some(link)) })
    });
    repo.expect_record_open()
        .withf(move |open_id, _| *open_id == id)
        .times(1)
        .returning(|_, _| Box::pin(async { Ok(()) }));
    let svc = service(repo);

    let resolved = svc.resolve_link(&InviteToken::generate()).await.unwrap();

    assert_eq!(resolved.id, id);
}

#[tokio::test]
async fn resolve_link_survives_a_failed_open_count() {
    let link = active_link();
    let mut repo = MockGtmInviteRepo::new();
    repo.expect_get_link_by_token().returning(move |_| {
        let link = link.clone();
        Box::pin(async move { Ok(Some(link)) })
    });
    repo.expect_record_open()
        .returning(|_, _| Box::pin(async { Err(anyhow::anyhow!("db down")) }));
    let svc = service(repo);

    assert!(svc.resolve_link(&InviteToken::generate()).await.is_ok());
}

#[tokio::test]
async fn resolve_link_reports_unknown_tokens() {
    let mut repo = MockGtmInviteRepo::new();
    repo.expect_get_link_by_token()
        .returning(|_| Box::pin(async { Ok(None) }));
    let svc = service(repo);

    let result = svc.resolve_link(&InviteToken::generate()).await;

    assert!(matches!(result, Err(GtmInviteError::NotFound)));
}

// -- redeem_link --

fn repo_with_link(link: InviteLink) -> MockGtmInviteRepo {
    let mut repo = MockGtmInviteRepo::new();
    repo.expect_get_link_by_token().returning(move |_| {
        let link = link.clone();
        Box::pin(async move { Ok(Some(link)) })
    });
    repo
}

#[tokio::test]
async fn redeem_link_attributes_an_active_link() {
    let link = active_link();
    let id = link.id;
    let redeemed = redeemed_by(link.clone(), prospect());
    let mut repo = repo_with_link(link);
    repo.expect_get_redeemed_link_for_user()
        .returning(|_| Box::pin(async { Ok(None) }));
    repo.expect_redeem_link()
        .withf(move |redeem_id, user, _| *redeem_id == id && user.as_ref() == prospect().as_ref())
        .times(1)
        .returning(move |_, _, _| {
            let redeemed = redeemed.clone();
            Box::pin(async move { Ok(Some(redeemed)) })
        });
    let svc = service(repo);

    let result = svc
        .redeem_link(&InviteToken::generate(), &prospect())
        .await
        .unwrap();

    assert!(result.is_redeemed_by(&prospect()));
    assert_eq!(result.status(Utc::now()), InviteLinkStatus::Redeemed);
}

#[tokio::test]
async fn redeem_link_is_idempotent_for_the_same_user() {
    let link = redeemed_by(active_link(), prospect());
    let svc = service(repo_with_link(link));

    let result = svc
        .redeem_link(&InviteToken::generate(), &prospect())
        .await
        .unwrap();

    assert!(result.is_redeemed_by(&prospect()));
}

#[tokio::test]
async fn redeem_link_rejects_a_link_another_account_used() {
    let link = redeemed_by(active_link(), other_prospect());
    let mut repo = repo_with_link(link);
    repo.expect_get_redeemed_link_for_user()
        .returning(|_| Box::pin(async { Ok(None) }));
    let svc = service(repo);

    let result = svc.redeem_link(&InviteToken::generate(), &prospect()).await;

    assert!(matches!(result, Err(GtmInviteError::AlreadyRedeemed)));
}

#[tokio::test]
async fn redeem_link_rejects_expired_and_revoked_links() {
    let expired = InviteLink {
        expires_at: Utc::now() - Duration::minutes(1),
        ..active_link()
    };
    let mut repo = repo_with_link(expired);
    repo.expect_get_redeemed_link_for_user()
        .returning(|_| Box::pin(async { Ok(None) }));
    let result = service(repo)
        .redeem_link(&InviteToken::generate(), &prospect())
        .await;
    assert!(matches!(result, Err(GtmInviteError::Expired)));

    let revoked = InviteLink {
        revoked_at: Some(Utc::now()),
        ..active_link()
    };
    let mut repo = repo_with_link(revoked);
    repo.expect_get_redeemed_link_for_user()
        .returning(|_| Box::pin(async { Ok(None) }));
    let result = service(repo)
        .redeem_link(&InviteToken::generate(), &prospect())
        .await;
    assert!(matches!(result, Err(GtmInviteError::Revoked)));
}

#[tokio::test]
async fn redeem_link_keeps_the_users_first_link() {
    let first = redeemed_by(active_link(), prospect());
    let first_id = first.id;
    let second = active_link();
    let mut repo = repo_with_link(second);
    repo.expect_get_redeemed_link_for_user()
        .returning(move |_| {
            let first = first.clone();
            Box::pin(async move { Ok(Some(first)) })
        });
    let svc = service(repo);

    let result = svc
        .redeem_link(&InviteToken::generate(), &prospect())
        .await
        .unwrap();

    assert_eq!(result.id, first_id);
}

#[tokio::test]
async fn redeem_link_treats_a_lost_race_as_already_redeemed() {
    let mut repo = repo_with_link(active_link());
    repo.expect_get_redeemed_link_for_user()
        .returning(|_| Box::pin(async { Ok(None) }));
    repo.expect_redeem_link()
        .returning(|_, _, _| Box::pin(async { Ok(None) }));
    let svc = service(repo);

    let result = svc.redeem_link(&InviteToken::generate(), &prospect()).await;

    assert!(matches!(result, Err(GtmInviteError::AlreadyRedeemed)));
}

// -- active_offer_for_user --

#[tokio::test]
async fn active_offer_is_the_unconverted_redeemed_link() {
    let link = redeemed_by(active_link(), prospect());
    let id = link.id;
    let mut repo = MockGtmInviteRepo::new();
    repo.expect_get_redeemed_link_for_user()
        .returning(move |_| {
            let link = link.clone();
            Box::pin(async move { Ok(Some(link)) })
        });
    let svc = service(repo);

    let offer = svc.active_offer_for_user(&prospect()).await.unwrap();

    assert_eq!(offer.map(|link| link.id), Some(id));
}

#[tokio::test]
async fn active_offer_is_gone_once_converted() {
    let link = converted(redeemed_by(active_link(), prospect()));
    let mut repo = MockGtmInviteRepo::new();
    repo.expect_get_redeemed_link_for_user()
        .returning(move |_| {
            let link = link.clone();
            Box::pin(async move { Ok(Some(link)) })
        });
    let svc = service(repo);

    let offer = svc.active_offer_for_user(&prospect()).await.unwrap();

    assert!(offer.is_none());
}

// -- models --

#[test]
fn status_prefers_redemption_over_expiry_and_revocation() {
    let stale = InviteLink {
        expires_at: Utc::now() - Duration::days(30),
        revoked_at: Some(Utc::now()),
        ..active_link()
    };
    assert_eq!(stale.status(Utc::now()), InviteLinkStatus::Revoked);

    let redeemed = redeemed_by(stale.clone(), prospect());
    assert_eq!(redeemed.status(Utc::now()), InviteLinkStatus::Redeemed);
    assert_eq!(
        converted(redeemed).status(Utc::now()),
        InviteLinkStatus::Converted
    );
}

#[test]
fn tokens_must_look_generated() {
    assert!(
        InviteToken::generate()
            .as_str()
            .parse::<InviteToken>()
            .is_ok()
    );
    assert!("short".parse::<InviteToken>().is_err());
    assert!(
        "has spaces in it and is long enough"
            .parse::<InviteToken>()
            .is_err()
    );
    assert!("a".repeat(65).parse::<InviteToken>().is_err());
}

#[test]
fn promo_codes_are_trimmed_and_validated() {
    assert_eq!(" 1MF ".parse::<PromoCode>().unwrap().as_str(), "1MF");
    assert!("".parse::<PromoCode>().is_err());
    assert!("bad code".parse::<PromoCode>().is_err());
}

#[test]
fn statuses_round_trip_through_strings() {
    for status in [
        InviteLinkStatus::Active,
        InviteLinkStatus::Expired,
        InviteLinkStatus::Revoked,
        InviteLinkStatus::Redeemed,
        InviteLinkStatus::Converted,
    ] {
        assert_eq!(status.to_string().parse::<InviteLinkStatus>(), Ok(status));
    }
    assert!("bogus".parse::<InviteLinkStatus>().is_err());
}
