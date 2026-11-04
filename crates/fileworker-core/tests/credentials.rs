use fileworker_core::{
    credentials::credential_account,
    profiles::{AuthMethod, ConnectionProfile},
};

fn profile() -> ConnectionProfile {
    ConnectionProfile {
        id: "e6814610-8703-4c50-ab27-e823c8577fc3".into(),
        name: "开发".into(),
        host: "example.com".into(),
        port: 22,
        username: "tester".into(),
        auth_method: AuthMethod::Password,
        private_key_path: None,
        remote_path: ".".into(),
    }
}

#[test]
fn credentials_are_bound_to_the_server_account_and_authentication_identity() {
    let original = profile();
    let account = credential_account(&original);
    let mut changes = Vec::new();
    let mut changed = original.clone();
    changed.host = "other.example.com".into();
    changes.push(changed);
    let mut changed = original.clone();
    changed.port = 2222;
    changes.push(changed);
    let mut changed = original.clone();
    changed.username = "other".into();
    changes.push(changed);
    let mut changed = original.clone();
    changed.id = "45c20fc4-501c-4863-85e1-cf29d06caef4".into();
    changes.push(changed);
    let mut changed = original.clone();
    changed.auth_method = AuthMethod::PrivateKey;
    changed.private_key_path = Some("/tmp/key".into());
    changes.push(changed);
    for changed in changes {
        assert_ne!(credential_account(&changed), account);
    }
    let mut renamed = original.clone();
    renamed.name = "新名字".into();
    renamed.remote_path = "/data".into();
    assert_eq!(credential_account(&renamed), account);
    let mut key = original;
    key.auth_method = AuthMethod::PrivateKey;
    key.private_key_path = Some("/tmp/a".into());
    let before = credential_account(&key);
    key.private_key_path = Some("/tmp/b".into());
    assert_ne!(credential_account(&key), before);
}
