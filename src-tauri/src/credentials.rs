use fileworker_core::{credentials::CredentialStore, error::CoreError};
use zeroize::Zeroizing;

pub struct NativeCredentialStore;

#[cfg(target_os = "macos")]
impl CredentialStore for NativeCredentialStore {
    fn exists(&self, account: &str) -> Result<bool, CoreError> {
        use security_framework::item::{ItemClass, ItemSearchOptions};
        match ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(SERVICE)
            .account(account)
            .load_attributes(true)
            .load_data(false)
            .search()
        {
            Ok(items) => Ok(!items.is_empty()),
            Err(error) if error.code() == ITEM_NOT_FOUND => Ok(false),
            Err(_) => Err(keychain_error()),
        }
    }

    fn get(&self, account: &str) -> Result<Zeroizing<String>, CoreError> {
        let bytes = security_framework::passwords::get_generic_password(SERVICE, account).map_err(
            |error| {
                if error.code() == ITEM_NOT_FOUND {
                    CoreError::new(
                        "credential_missing",
                        "此连接没有已保存的凭据，请输入密码或私钥口令",
                    )
                } else {
                    keychain_error()
                }
            },
        )?;
        let bytes = Zeroizing::new(bytes);
        let text = std::str::from_utf8(&bytes).map_err(|_| keychain_error())?;
        Ok(Zeroizing::new(text.to_owned()))
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), CoreError> {
        security_framework::passwords::set_generic_password(SERVICE, account, secret.as_bytes())
            .map_err(|_| keychain_error())
    }

    fn delete(&self, account: &str) -> Result<(), CoreError> {
        match security_framework::passwords::delete_generic_password(SERVICE, account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ITEM_NOT_FOUND => Ok(()),
            Err(_) => Err(keychain_error()),
        }
    }
}

#[cfg(target_os = "macos")]
const SERVICE: &str = "com.fileworker.desktop.credentials.v1";
#[cfg(target_os = "macos")]
const ITEM_NOT_FOUND: i32 = -25300;
#[cfg(target_os = "macos")]
fn keychain_error() -> CoreError {
    CoreError::new(
        "credential_unavailable",
        "无法访问 macOS 钥匙串，请确认已解锁并允许 FileWorker 访问",
    )
}

#[cfg(not(target_os = "macos"))]
impl CredentialStore for NativeCredentialStore {
    fn supported(&self) -> bool {
        false
    }
    fn exists(&self, _account: &str) -> Result<bool, CoreError> {
        Ok(false)
    }
    fn get(&self, _account: &str) -> Result<Zeroizing<String>, CoreError> {
        Err(unsupported())
    }
    fn set(&self, _account: &str, _secret: &str) -> Result<(), CoreError> {
        Err(unsupported())
    }
    fn delete(&self, _account: &str) -> Result<(), CoreError> {
        Err(unsupported())
    }
}

#[cfg(not(target_os = "macos"))]
fn unsupported() -> CoreError {
    CoreError::new(
        "credential_unsupported",
        "当前平台暂未接入系统凭据存储，请使用本次连接的临时凭据",
    )
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::NativeCredentialStore;
    use fileworker_core::credentials::CredentialStore;

    #[test]
    #[ignore = "writes and removes one random FileWorker test Keychain item"]
    fn keychain_roundtrip_and_delete_use_an_isolated_random_account() {
        let store = NativeCredentialStore;
        let account = format!(
            "fileworker-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        struct Cleanup<'a>(&'a NativeCredentialStore, &'a str);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = self.0.delete(self.1);
            }
        }
        let _cleanup = Cleanup(&store, &account);
        assert!(!store.exists(&account).unwrap());
        assert_eq!(store.get(&account).unwrap_err().code, "credential_missing");
        store.set(&account, "isolated-test-value").unwrap();
        assert!(store.exists(&account).unwrap());
        assert_eq!(store.get(&account).unwrap().as_str(), "isolated-test-value");
        store.set(&account, "updated-isolated-value").unwrap();
        assert_eq!(
            store.get(&account).unwrap().as_str(),
            "updated-isolated-value"
        );
        store.delete(&account).unwrap();
        assert!(!store.exists(&account).unwrap());
        assert_eq!(store.get(&account).unwrap_err().code, "credential_missing");
        store.delete(&account).unwrap();
    }
}
