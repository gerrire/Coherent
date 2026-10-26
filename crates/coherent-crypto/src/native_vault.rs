//! Encrypted local storage, with OS-protected wrapping keys. Native shells only
//! expose `request` to the UI; no snapshot or private-key command is exported.
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use base64::{Engine as _, prelude::BASE64_STANDARD};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    CryptoError,
    engine::{Command, CryptoEngine},
    envelope::{self, Envelope},
    uuid_bytes,
};

const MAX_FILE: u64 = 96 * 1024 * 1024;

/// Android Keystore / iOS Keychain adapters can implement this interface
/// without changing MLS, recovery, message formats or the local state machine.
pub trait VaultKeyStore {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<[u8; 32]>>, CryptoError>;
    fn create(&self, account: &str, key: &[u8; 32]) -> Result<(), CryptoError>;
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
pub struct SystemKeyStore {
    pub service: String,
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
impl VaultKeyStore for SystemKeyStore {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<[u8; 32]>>, CryptoError> {
        let entry = keyring::Entry::new(&self.service, account).map_err(|_| CryptoError::State)?;
        match entry.get_secret() {
            Ok(bytes) => {
                let bytes = Zeroizing::new(bytes);
                Ok(Some(Zeroizing::new(
                    bytes
                        .as_slice()
                        .try_into()
                        .map_err(|_| CryptoError::State)?,
                )))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(CryptoError::State),
        }
    }
    fn create(&self, account: &str, key: &[u8; 32]) -> Result<(), CryptoError> {
        // Caller holds the account lock. Never overwrite a key for existing data.
        if self.get(account)?.is_some() {
            return Err(CryptoError::State);
        }
        keyring::Entry::new(&self.service, account)
            .map_err(|_| CryptoError::State)?
            .set_secret(key)
            .map_err(|_| CryptoError::State)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredClient {
    version: u8,
    engine: String,
    outbox: Vec<DeliveryItem>,
}
impl Drop for StoredClient {
    fn drop(&mut self) {
        self.engine.zeroize();
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeliveryItem {
    id: String,
    operation: String,
    payload: Value,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum VaultRequest {
    Execute {
        command: Command,
        delivered_id: Option<String>,
        transport: Option<Value>,
    },
    Pending,
    Delivered {
        delivery_id: String,
    },
}

pub struct NativeVault<K: VaultKeyStore> {
    directory: PathBuf,
    key_store: K,
}

impl<K: VaultKeyStore> NativeVault<K> {
    pub fn new(directory: PathBuf, key_store: K) -> Result<Self, CryptoError> {
        if !directory.is_absolute() {
            return Err(CryptoError::InvalidInput);
        }
        fs::create_dir_all(&directory).map_err(|_| CryptoError::State)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                .map_err(|_| CryptoError::State)?;
        }
        Ok(Self {
            directory,
            key_store,
        })
    }

    pub fn request(&self, account_id: &str, request_json: &str) -> Result<Value, CryptoError> {
        self.request_inner(account_id, request_json, false)
    }

    /// Native shell calls this only after server reauthentication and a valid
    /// proof of this active trusted device. Never expose snapshots via IPC.
    /// Called only after platform-side reauthentication, never through generic IPC.
    pub fn approve_link(&self, account_id: &str, command: Value) -> Result<Value, CryptoError> {
        let parsed: Command =
            serde_json::from_value(command.clone()).map_err(|_| CryptoError::InvalidInput)?;
        if !matches!(parsed, Command::LinkSend { .. }) {
            return Err(CryptoError::InvalidInput);
        }
        self.request_inner(
            account_id,
            &json!({"type":"execute","command":command}).to_string(),
            true,
        )
    }
    pub fn reveal_recovery(&self, account_id: &str) -> Result<Value, CryptoError> {
        self.request_inner(
            account_id,
            r#"{"type":"execute","command":{"operation":"show_recovery"}}"#,
            true,
        )
    }

    fn request_inner(
        &self,
        account_id: &str,
        request_json: &str,
        authorized_reveal: bool,
    ) -> Result<Value, CryptoError> {
        if uuid::Uuid::from_bytes(uuid_bytes(account_id)?).to_string() != account_id
            || request_json.len() > 3 * 1024 * 1024
        {
            return Err(CryptoError::InvalidInput);
        }
        let request: VaultRequest =
            serde_json::from_str(request_json).map_err(|_| CryptoError::InvalidInput)?;
        if matches!(
            &request,
            VaultRequest::Execute {
                command: Command::CreateRecovery,
                ..
            }
        ) || (matches!(
            &request,
            VaultRequest::Execute {
                command: Command::ShowRecovery | Command::LinkSend { .. },
                ..
            }
        ) && !authorized_reveal)
        {
            return Err(CryptoError::State);
        }
        let path = self.directory.join(format!("{account_id}.vault"));
        let lock_path = self.directory.join(format!("{account_id}.lock"));
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options.open(lock_path).map_err(|_| CryptoError::State)?;
        lock.lock_exclusive().map_err(|_| CryptoError::State)?;
        // The OS releases the file lock on every return, including failures.
        let exists = path.try_exists().map_err(|_| CryptoError::State)?;
        let key = match self.key_store.get(account_id)? {
            Some(key) => key,
            None if !exists => {
                let key = envelope::random_key();
                self.key_store.create(account_id, &key)?;
                key
            }
            None => return Err(CryptoError::State),
        };
        let mut aad = b"coherent/native-vault/v1\0".to_vec();
        aad.extend_from_slice(&uuid_bytes(account_id)?);
        let (mut engine, mut stored) = if exists {
            if fs::metadata(&path).map_err(|_| CryptoError::State)?.len() > MAX_FILE {
                return Err(CryptoError::State);
            }
            let envelope: Envelope =
                serde_json::from_slice(&fs::read(&path).map_err(|_| CryptoError::State)?)
                    .map_err(|_| CryptoError::State)?;
            let bytes = envelope::open(&key, &envelope, &aad)?;
            let stored: StoredClient =
                serde_json::from_slice(&bytes).map_err(|_| CryptoError::State)?;
            if stored.version != 1 || stored.outbox.len() > 100 {
                return Err(CryptoError::State);
            }
            let snapshot = Zeroizing::new(
                BASE64_STANDARD
                    .decode(&stored.engine)
                    .map_err(|_| CryptoError::State)?,
            );
            (CryptoEngine::restore_local(&snapshot)?, stored)
        } else {
            (
                CryptoEngine::new(account_id, &random_uuid()?)?,
                StoredClient {
                    version: 1,
                    engine: String::new(),
                    outbox: Vec::new(),
                },
            )
        };
        if matches!(request, VaultRequest::Pending) {
            return Ok(json!(stored.outbox));
        }
        let mut reply = json!({ "result": {}, "delivery_id": null });
        let delivered = match &request {
            VaultRequest::Execute { delivered_id, .. } => delivered_id.as_ref(),
            VaultRequest::Delivered { delivery_id } => Some(delivery_id),
            _ => None,
        };
        if let Some(id) = delivered {
            let index = stored
                .outbox
                .iter()
                .position(|item| &item.id == id)
                .ok_or(CryptoError::State)?;
            let item = &stored.outbox[index];
            if matches!(item.operation.as_str(), "add_members" | "remove_members") {
                match &request {
                    VaultRequest::Execute { command, .. } => {
                        let inner = match command {
                            Command::ApplyEvent {
                                command: Some(inner),
                                ..
                            } => inner.as_ref(),
                            _ => command,
                        };
                        match inner {
                            Command::AcknowledgeCommit { commit, .. }
                            | Command::DiscardCommit { commit, .. }
                                if item.payload.get("commit").and_then(Value::as_str)
                                    == Some(commit) =>
                            {
                                ()
                            }
                            _ => return Err(CryptoError::State),
                        }
                    }
                    _ => return Err(CryptoError::State),
                }
            }
            stored.outbox.remove(index);
        }
        if let VaultRequest::Execute {
            command,
            delivered_id,
            transport,
        } = request
        {
            if matches!(command, Command::AcknowledgeCommit { .. }) && delivered_id.is_none() {
                return Err(CryptoError::State);
            }
            let command_json =
                Zeroizing::new(serde_json::to_string(&command).map_err(|_| CryptoError::State)?);
            let operation: &str = match &command {
                Command::Send { .. } => "send",
                Command::AddMembers { .. } => "add_members",
                Command::RemoveMembers { .. } => "remove_members",
                Command::KeyPackage => "key_package",
                Command::Receive { .. } => "receive",
                _ => "",
            };
            if !operation.is_empty() && stored.outbox.len() >= 100 {
                return Err(CryptoError::State);
            }
            let result: Value = serde_json::from_str(&engine.execute_json(&command_json)?)
                .map_err(|_| CryptoError::State)?;
            let mut payload = if operation == "receive" {
                (result.get("kind").and_then(Value::as_str) == Some("application"))
                    .then(|| json!({ "context": result["context"], "archive": result["archive"] }))
            } else {
                (!operation.is_empty()).then(|| result.clone())
            };
            if let (Some(payload), Some(transport)) = (&mut payload, transport) {
                payload
                    .as_object_mut()
                    .ok_or(CryptoError::State)?
                    .insert("transport".into(), transport);
            }
            let mut delivery_id = None;
            if let Some(payload) = payload {
                let id = random_uuid()?;
                stored.outbox.push(DeliveryItem {
                    id: id.clone(),
                    operation: operation.into(),
                    payload,
                });
                delivery_id = Some(id);
            }
            reply = json!({ "result": result, "delivery_id": delivery_id });
        }
        stored.engine.zeroize();
        stored.engine = BASE64_STANDARD.encode(engine.snapshot_local()?.as_slice());
        let bytes = Zeroizing::new(serde_json::to_vec(&stored).map_err(|_| CryptoError::State)?);
        let sealed = serde_json::to_vec(&envelope::seal(&key, &bytes, &aad)?)
            .map_err(|_| CryptoError::State)?;
        if sealed.len() as u64 > MAX_FILE {
            return Err(CryptoError::State);
        }
        atomic_write(&path, &sealed)?;
        Ok(reply)
    }
}

fn random_uuid() -> Result<String, CryptoError> {
    let random = envelope::random_key();
    let mut id: [u8; 16] = random[..16].try_into().map_err(|_| CryptoError::State)?;
    id[6] = (id[6] & 0x0f) | 0x40;
    id[8] = (id[8] & 0x3f) | 0x80;
    Ok(uuid::Uuid::from_bytes(id).to_string())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), CryptoError> {
    let parent = path.parent().ok_or(CryptoError::State)?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| CryptoError::State)?;
    file.write_all(bytes).map_err(|_| CryptoError::State)?;
    file.as_file().sync_all().map_err(|_| CryptoError::State)?;
    file.persist(path).map_err(|_| CryptoError::State)?;
    #[cfg(unix)]
    {
        fs::File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|_| CryptoError::State)?;
    }
    Ok(())
}
