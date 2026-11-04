use crate::{
    error::CoreError,
    profiles::{AuthMethod, ConnectionProfile},
};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub trait CredentialStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Zeroizing<String>, CoreError>;
    fn set(&self, account: &str, secret: &str) -> Result<(), CoreError>;
    fn delete(&self, account: &str) -> Result<(), CoreError>;
}

pub fn credential_account(profile: &ConnectionProfile) -> String {
    let fields = [
        profile.id.as_str(),
        &profile.host.to_ascii_lowercase(),
        &profile.port.to_string(),
        profile.username.as_str(),
        match profile.auth_method {
            AuthMethod::Password => "password",
            AuthMethod::PrivateKey => "privateKey",
        },
        profile.private_key_path.as_deref().unwrap_or(""),
    ];
    let mut hash = Sha256::new();
    for field in fields {
        hash.update(field.len().to_be_bytes());
        hash.update(field.as_bytes());
    }
    format!("v1:{:x}", hash.finalize())
}
