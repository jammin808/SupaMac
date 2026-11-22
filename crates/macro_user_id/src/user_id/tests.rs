use crate::email::ReadEmailParts;

use super::*;

#[test]
fn it_should_parse() {
    let valid_emails = [
        "macro|sean@macro.com",
        "macro|sean+testing.thing@example.gc.ca",
        "macro|###hello###+weird@something-strange.world.tour",
    ];
    let res: Result<Vec<_>, _> = valid_emails
        .iter()
        .copied()
        .map(MacroUserId::parse_from_str)
        .collect();
    res.unwrap();
}

#[test]
fn it_should_fail() {
    let invalid_emails = [
        "macro|sean@macro.com ",
        "macro| sean@macro.com",
        "macro|sean@macro.com\n",
        "macro|\nsean@macro.com",
        "macro|sean..aye@macro.com",
        "macro|sean@@macro.com",
        "schmacro|sean@macro.com",
    ];
    invalid_emails
        .iter()
        .copied()
        .map(MacroUserId::parse_from_str)
        .for_each(|res| {
            res.unwrap_err();
        });
}

#[test]
fn email_works() {
    let id = MacroUserId::parse_from_str("macro|###hello###+weird@something-strange.world.tour")
        .unwrap();

    dbg!(&id);

    assert_eq!(
        id.email_part().email_str(),
        "###hello###+weird@something-strange.world.tour"
    );
}

#[test]
fn domain_part_works() {
    let id = MacroUserId::parse_from_str("macro|###hello###+weird@something-strange.world.tour")
        .unwrap();

    dbg!(&id);

    assert_eq!(
        id.email_part().domain_part(),
        "something-strange.world.tour"
    );
}

#[test]
fn local_part_works() {
    let id = MacroUserId::parse_from_str("macro|###hello###+weird@something-strange.world.tour")
        .unwrap();

    dbg!(&id);

    assert_eq!(id.email_part().local_part(), "###hello###+weird");
}

#[test]
fn casing_matters_for_prefix() {
    let _id = MacroUserId::parse_from_str("macRo|###hello###+weird@something-strange.world.tour")
        .unwrap_err();
}

#[test]
fn incomplete_input_does_not_panic() {
    assert!(MacroUserId::parse_from_str("").is_err());
    assert!(MacroUserId::parse_from_str("macro").is_err());
    assert!(MacroUserId::parse_from_str("macro|").is_err());
}

#[test]
fn casing_ignored_for_email() {
    let id = MacroUserId::parse_from_str("macro|###hello###+WEIRD@something-strange.world.tour")
        .unwrap();

    assert_eq!(id.email_part().local_part(), "###hello###+WEIRD");
}

#[test]
fn debug_output_is_simple_string() {
    let id = MacroUserId::parse_from_str("macro|hutch@macro.com").unwrap();
    assert_eq!(format!("{:?}", id), "macro|hutch@macro.com");

    let id_str = MacroUserIdStr::parse_from_str("macro|hutch@macro.com").unwrap();
    assert_eq!(format!("{:?}", id_str), "macro|hutch@macro.com");
}

#[test]
fn no_account_is_staff_whatever_its_domain() {
    for id in [
        "macro|teo@macro.com",
        "macro|teo+notify@macro.com",
        "macro|teo@MACRO.COM",
        "macro|teo@example.com",
    ] {
        let id = MacroUserIdStr::parse_from_str(id).unwrap();
        assert!(!id.is_macro_staff(), "{id:?} is staff");
    }
}

/// Lookalikes of a real address are not addresses: a second `@`, a trailing
/// dot, a space or a non-ASCII label never parse.
#[test]
fn lookalike_addresses_do_not_parse() {
    for not_an_email in [
        "someone@example.com@evil.test",
        "someone@example.com.",
        "someone@example com",
        "someone@exаmple.com", // Cyrillic 'а'
        "not-an-email",
    ] {
        assert!(
            MacroUserIdStr::try_from_email(not_an_email).is_err(),
            "parsed {not_an_email}"
        );
    }
}

#[test]
fn it_should_fail_this() {
    MacroUserIdStr::parse_from_str("macro|a'or$1=$1or'x'='x@y.com").unwrap_err();
}
