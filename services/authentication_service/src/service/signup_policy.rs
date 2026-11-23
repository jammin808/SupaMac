#[cfg(test)]
mod test;

use std::{collections::HashSet, fmt};

use macro_user_id::email::Email;
use serde_json::Value;

const MACRO_EMAIL_DOMAIN: &str = "macro.com";

/// The configured signup admission policy.
#[derive(Clone, Eq, PartialEq)]
pub enum SignupPolicy {
    /// Admit every signup origin.
    AllowAll,
    /// Admit public signups when their normalized email is present, or is a
    /// Macro address while `admits_macro_domain` is set.
    EmailAllowlist {
        allowed_emails: HashSet<String>,
        admits_macro_domain: bool,
    },
}

impl SignupPolicy {
    /// Create a policy that admits every signup origin.
    pub fn allow_all() -> Self {
        Self::AllowAll
    }

    /// Create an exact-address allowlist from a JSON array of email strings.
    ///
    /// The resulting policy also admits every `@macro.com` address.
    pub fn from_allowlist_json(raw_json: &str) -> Result<Self, SignupPolicyConfigError> {
        Ok(Self::EmailAllowlist {
            allowed_emails: parse_allowlist_json(raw_json)?,
            admits_macro_domain: true,
        })
    }

    /// Create an exact-address allowlist from a JSON array of email strings.
    ///
    /// The resulting policy admits the listed addresses and nothing else: a
    /// deployment Macro does not operate has no staff domain to admit.
    pub fn from_exact_allowlist_json(raw_json: &str) -> Result<Self, SignupPolicyConfigError> {
        Ok(Self::EmailAllowlist {
            allowed_emails: parse_allowlist_json(raw_json)?,
            admits_macro_domain: false,
        })
    }

    /// Authorize a public signup email address.
    pub fn authorize_public_email(&self, email: &str) -> Result<(), SignupPolicyDenial> {
        match self {
            Self::AllowAll => Ok(()),
            Self::EmailAllowlist {
                allowed_emails,
                admits_macro_domain,
            } => {
                let normalized_email = normalize_public_email(email)?;
                let is_admitted_macro_email =
                    *admits_macro_domain && is_macro_email(&normalized_email);

                if is_admitted_macro_email || allowed_emails.contains(&normalized_email) {
                    Ok(())
                } else {
                    Err(SignupPolicyDenial::PublicEmailNotAllowed)
                }
            }
        }
    }

    /// Return the number of configured addresses for allowlist policies.
    pub fn allowed_email_count(&self) -> Option<usize> {
        match self {
            Self::AllowAll => None,
            Self::EmailAllowlist { allowed_emails, .. } => Some(allowed_emails.len()),
        }
    }
}

impl fmt::Debug for SignupPolicy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AllowAll => formatter.write_str("SignupPolicy::AllowAll"),
            Self::EmailAllowlist {
                allowed_emails,
                admits_macro_domain,
            } => formatter
                .debug_struct("SignupPolicy::EmailAllowlist")
                .field("allowed_email_count", &allowed_emails.len())
                .field("admits_macro_domain", admits_macro_domain)
                .finish(),
        }
    }
}

/// A redacted policy configuration error.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum SignupPolicyConfigError {
    /// The setting was not valid JSON.
    #[error("signup allowlist must be valid JSON")]
    MalformedJson,
    /// The setting was valid JSON, but not an array.
    #[error("signup allowlist must be a JSON array")]
    ExpectedArray,
    /// An array entry was not a string.
    #[error("signup allowlist entry at index {index} must be a string")]
    NonStringEntry {
        /// The zero-based array index of the invalid entry.
        index: usize,
    },
    /// An array entry was blank after trimming whitespace.
    #[error("signup allowlist entry at index {index} must not be blank")]
    BlankEntry {
        /// The zero-based array index of the blank entry.
        index: usize,
    },
    /// An array entry was not a valid email address.
    #[error("signup allowlist entry at index {index} must be a valid email address")]
    InvalidEmail {
        /// The zero-based array index of the invalid entry.
        index: usize,
    },
    /// The allowlist did not contain any usable email addresses.
    #[error("signup allowlist must contain at least one email address")]
    EmptyAllowlist,
}

/// A redacted policy denial.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum SignupPolicyDenial {
    /// The public signup email was not admitted by the configured policy.
    #[error("signup is not allowed for this email address")]
    PublicEmailNotAllowed,
    /// The public signup email could not be parsed.
    #[error("signup email address is invalid")]
    InvalidPublicEmail,
}

fn parse_allowlist_json(raw_json: &str) -> Result<HashSet<String>, SignupPolicyConfigError> {
    let value = serde_json::from_str::<Value>(raw_json)
        .map_err(|_| SignupPolicyConfigError::MalformedJson)?;
    let Value::Array(entries) = value else {
        return Err(SignupPolicyConfigError::ExpectedArray);
    };

    let allowed_emails = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| normalize_allowlist_entry(index, entry))
        .collect::<Result<HashSet<_>, _>>()?;

    if allowed_emails.is_empty() {
        return Err(SignupPolicyConfigError::EmptyAllowlist);
    }

    Ok(allowed_emails)
}

fn normalize_allowlist_entry(
    index: usize,
    entry: &Value,
) -> Result<String, SignupPolicyConfigError> {
    let Some(email) = entry.as_str() else {
        return Err(SignupPolicyConfigError::NonStringEntry { index });
    };

    normalize_config_email(index, email)
}

fn normalize_config_email(index: usize, email: &str) -> Result<String, SignupPolicyConfigError> {
    let trimmed_email = email.trim();
    if trimmed_email.is_empty() {
        return Err(SignupPolicyConfigError::BlankEntry { index });
    }

    normalize_email(trimmed_email).map_err(|_| SignupPolicyConfigError::InvalidEmail { index })
}

fn normalize_public_email(email: &str) -> Result<String, SignupPolicyDenial> {
    let trimmed_email = email.trim();
    if trimmed_email.is_empty() {
        return Err(SignupPolicyDenial::InvalidPublicEmail);
    }

    normalize_email(trimmed_email).map_err(|_| SignupPolicyDenial::InvalidPublicEmail)
}

fn normalize_email(email: &str) -> Result<String, ()> {
    Email::parse_from_str(email).map_err(|_| ())?;
    let lowercased_email = email.to_lowercase();
    Email::parse_from_str(&lowercased_email).map_err(|_| ())?;
    Ok(lowercased_email)
}

fn is_macro_email(normalized_email: &str) -> bool {
    normalized_email
        .rsplit_once('@')
        .is_some_and(|(_, domain)| domain == MACRO_EMAIL_DOMAIN)
}
