//! Macro's own sign-in emails, which an agent's program must not read: one
//! that reads the code from the user's inbox can sign in as the user.

use macro_env_var::maybe_env_vars;
use serde_json::Value;
use std::sync::LazyLock;

#[cfg(test)]
mod test;

/// The addresses the FusionAuth stacks send sign-in mail from in each
/// environment: their `default-from-email` (passwordless codes and email
/// verification) and the local kickstart's `MAIL_FROM`. The auth service
/// sends its account-merge codes and verification links from the same
/// addresses, and nothing but auth mail comes from them.
const SIGN_IN_SENDERS: [&str; 4] = [
    "auth@macro.com",
    "authdev@macro.com",
    "auth-local@macro.com",
    "noreply@macro.local",
];

maybe_env_vars! {
    /// The address the deployment's auth mail comes from, which a
    /// self-hosted deployment's identity server also sends sign-in codes
    /// from. It is recognised beside [`SIGN_IN_SENDERS`], never instead of
    /// them, so a deployment can only hide more mail from programs.
    struct AuthSenderAddress;
}

/// The configured [`AuthSenderAddress`], read once per process. A value
/// that is not an address recognises nothing.
static CONFIGURED_SIGN_IN_SENDER: LazyLock<Option<String>> = LazyLock::new(|| {
    let configured = AuthSenderAddress::new()?;
    let address = configured.value()?.trim();
    address.contains('@').then(|| address.to_owned())
});

/// What a program reads instead of a sign-in email's subject and text.
pub const HIDDEN_SIGN_IN_EMAIL: &str =
    "Macro sign-in email (hidden from programs; the user can read it in Macro)";

/// Whether an email came from one of Macro's sign-in senders. Takes a bare
/// address or a `Name <address>` mailbox.
#[must_use]
pub fn is_macro_sign_in_sender(sender: &str) -> bool {
    is_sign_in_sender(sender, CONFIGURED_SIGN_IN_SENDER.as_deref())
}

fn is_sign_in_sender(sender: &str, configured: Option<&str>) -> bool {
    let address = sender
        .rsplit_once('<')
        .and_then(|(_, rest)| rest.split_once('>'))
        .map_or(sender, |(address, _)| address)
        .trim();
    SIGN_IN_SENDERS
        .iter()
        .copied()
        .chain(configured)
        .any(|known| known.eq_ignore_ascii_case(address))
}

/// Whether a raw RFC 5322 message is one of Macro's sign-in emails, by its
/// `From` address. A message whose headers don't parse is not.
#[must_use]
pub fn is_macro_sign_in_eml(raw: &[u8]) -> bool {
    use mailparse::MailHeaderMap as _;
    let Ok((headers, _)) = mailparse::parse_headers(raw) else {
        return false;
    };
    headers
        .get_all_headers("From")
        .into_iter()
        .filter_map(|from| mailparse::addrparse_header(from).ok())
        .flat_map(|addresses| addresses.extract_single_info())
        .any(|sender| is_macro_sign_in_sender(&sender.addr))
}

/// Keys whose strings carry an email's subject or text in the email, search
/// and workspace responses, besides any key starting `body` or `headers`
/// (`body_text`, `bodyHtmlSanitized`, `headers_json` holding `Subject`).
const TEXT_KEYS: [&str; 6] = [
    "subject",
    "name",
    "snippet",
    "content",
    "highlight",
    "preview",
];

fn is_text_key(key: &str) -> bool {
    TEXT_KEYS.contains(&key) || key.starts_with("body") || key.starts_with("headers")
}

/// Hide the subject and text of every sign-in email in a response a program
/// will read. An email or thread is recognised by an object naming a
/// sign-in sender (`from`, `sender`, `senderEmail`, or a participant); its
/// subject and text, nested messages and search highlights included, are
/// replaced. Only server-shaped responses: a client that picks its fields
/// (GraphQL) is refused to programs instead.
pub fn hide_sign_in_emails(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(hide_sign_in_emails),
        Value::Object(object) => {
            if is_sign_in_object(object) {
                hide_text(value);
                return;
            }
            object.values_mut().for_each(hide_sign_in_emails);
        }
        _ => {}
    }
}

fn is_sign_in_object(object: &serde_json::Map<String, Value>) -> bool {
    senders(object).any(is_macro_sign_in_sender)
}

/// The sender addresses an email object names, in each response's shape.
fn senders(object: &serde_json::Map<String, Value>) -> impl Iterator<Item = &str> {
    let direct = ["from", "sender", "senderEmail", "sender_email"]
        .into_iter()
        .filter_map(|key| object.get(key))
        .filter_map(address);
    let participants = object
        .get("participants")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(address);
    direct.chain(participants)
}

fn address(value: &Value) -> Option<&str> {
    match value {
        Value::String(address) => Some(address),
        Value::Object(contact) => ["email", "email_address", "emailAddress"]
            .iter()
            .find_map(|key| contact.get(*key).and_then(Value::as_str)),
        _ => None,
    }
}

fn hide_text(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(hide_text),
        Value::Object(object) => {
            for (key, child) in object.iter_mut() {
                if is_text_key(key) {
                    hide_strings(child);
                } else {
                    hide_text(child);
                }
            }
        }
        _ => {}
    }
}

fn hide_strings(value: &mut Value) {
    match value {
        Value::String(text) => HIDDEN_SIGN_IN_EMAIL.clone_into(text),
        Value::Array(items) => items.iter_mut().for_each(hide_strings),
        Value::Object(object) => object.values_mut().for_each(hide_strings),
        _ => {}
    }
}
