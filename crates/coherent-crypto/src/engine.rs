//! Platform-neutral command surface. Every operation rolls back on failure;
//! platforms must atomically persist `snapshot_local` and its network outbox
//! before publishing a successful result to the network.
use base64::{Engine as _, prelude::BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    CryptoError,
    envelope::{self, Envelope},
    mls::{DeviceBinding, MlsClient, Received},
    recovery, uuid_bytes,
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalEngine {
    version: u8,
    mls: String,
    archive_key: String,
    archive_in_use: bool,
    #[serde(default)]
    recovery_phrase: Option<String>,
    #[serde(default)]
    recovery_backup: Option<Envelope>,
}

impl Drop for LocalEngine {
    fn drop(&mut self) {
        self.mls.zeroize();
        self.archive_key.zeroize();
        if let Some(phrase) = &mut self.recovery_phrase {
            phrase.zeroize();
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageContext {
    pub conversation_id: String,
    pub message_id: String,
    pub sender_account_id: String,
    pub sender_device_id: String,
}

impl MessageContext {
    fn aad(&self, purpose: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let mut aad = purpose.to_vec();
        for id in [
            &self.conversation_id,
            &self.message_id,
            &self.sender_account_id,
            &self.sender_device_id,
        ] {
            aad.extend_from_slice(&uuid_bytes(id)?);
        }
        Ok(aad)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ContentKey {
    version: u8,
    context: MessageContext,
    key: String,
    body_hash: String,
}

impl Drop for ContentKey {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Identity,
    PinDevice {
        device: DeviceBinding,
    },
    AuthorizeConversation {
        conversation_id: String,
        device_ids: Vec<String>,
    },
    KeyPackage,
    CreateGroup {
        conversation_id: String,
    },
    Members {
        conversation_id: String,
    },
    AddMembers {
        conversation_id: String,
        key_packages: Vec<String>,
    },
    RemoveMembers {
        conversation_id: String,
        device_ids: Vec<String>,
    },
    AcknowledgeCommit {
        conversation_id: String,
        commit: String,
    },
    Join {
        conversation_id: String,
        welcome: String,
    },
    Send {
        conversation_id: String,
        message_id: String,
        content: String,
    },
    Receive {
        conversation_id: String,
        message_id: Option<String>,
        wire: String,
        body: Option<Envelope>,
    },
    OpenHistory {
        context: MessageContext,
        body: Envelope,
        archive: Envelope,
    },
    CreateRecovery,
    RecoveryBackup,
    ShowRecovery,
    SignDeviceProof {
        purpose: String,
        nonce: String,
        backup: Option<Envelope>,
    },
    RecoverArchive {
        phrase: String,
        backup: Envelope,
    },
}

pub struct CryptoEngine {
    mls: MlsClient,
    archive_key: Zeroizing<[u8; 32]>,
    archive_in_use: bool,
    recovery_phrase: Option<Zeroizing<String>>,
    recovery_backup: Option<Envelope>,
}

impl CryptoEngine {
    pub fn new(account_id: &str, device_id: &str) -> Result<Self, CryptoError> {
        Ok(Self {
            mls: MlsClient::new(account_id, device_id)?,
            archive_key: envelope::random_key(),
            archive_in_use: false,
            recovery_phrase: None,
            recovery_backup: None,
        })
    }

    pub fn execute_json(&mut self, command: &str) -> Result<String, CryptoError> {
        if command.len() > 3 * 1024 * 1024 {
            return Err(CryptoError::InvalidInput);
        }
        let command: Command =
            serde_json::from_str(command).map_err(|_| CryptoError::InvalidInput)?;
        let before = self.snapshot_local()?;
        let result = self
            .execute(command)
            .and_then(|result| serde_json::to_string(&result).map_err(|_| CryptoError::State));
        if result.is_err() {
            *self = Self::restore_local(&before)?;
        }
        result
    }

    fn archive_aad(&self, context: &MessageContext) -> Result<Vec<u8>, CryptoError> {
        let mut aad = context.aad(b"coherent/history-content-key/v1\0")?;
        aad.extend_from_slice(&uuid_bytes(&self.mls.device().account_id)?);
        Ok(aad)
    }

    fn archive(&self, record: &ContentKey) -> Result<Envelope, CryptoError> {
        let bytes = Zeroizing::new(serde_json::to_vec(record).map_err(|_| CryptoError::State)?);
        envelope::seal(
            &self.archive_key,
            &bytes,
            &self.archive_aad(&record.context)?,
        )
    }

    fn decrypt_content(&self, record: &ContentKey, body: &Envelope) -> Result<String, CryptoError> {
        if record.version != 1 {
            return Err(CryptoError::InvalidInput);
        }
        let encoded = serde_json::to_vec(body).map_err(|_| CryptoError::InvalidInput)?;
        if BASE64_STANDARD.encode(Sha256::digest(&encoded)) != record.body_hash {
            return Err(CryptoError::Authentication);
        }
        let key = Zeroizing::new(
            BASE64_STANDARD
                .decode(&record.key)
                .map_err(|_| CryptoError::InvalidInput)?,
        );
        let key: &[u8; 32] = key
            .as_slice()
            .try_into()
            .map_err(|_| CryptoError::InvalidInput)?;
        let plain = envelope::open(
            key,
            body,
            &record.context.aad(b"coherent/message-body/v1\0")?,
        )?;
        String::from_utf8(plain.to_vec()).map_err(|_| CryptoError::InvalidInput)
    }

    fn execute(&mut self, command: Command) -> Result<serde_json::Value, CryptoError> {
        use serde_json::json;
        match command {
            Command::Identity => Ok(
                json!({ "device": self.mls.device(), "fingerprint": self.mls.device().fingerprint()? }),
            ),
            Command::PinDevice { device } => {
                self.mls.pin_device(device)?;
                Ok(json!({}))
            }
            Command::AuthorizeConversation {
                conversation_id,
                device_ids,
            } => {
                self.mls
                    .authorize_conversation(&conversation_id, &device_ids)?;
                Ok(json!({}))
            }
            Command::KeyPackage => Ok(json!({ "key_package": self.mls.key_package()? })),
            Command::CreateGroup { conversation_id } => {
                self.mls.create_group(&conversation_id)?;
                Ok(json!({ "epoch": 0 }))
            }
            Command::Members { conversation_id } => Ok(
                json!({ "epoch": self.mls.epoch(&conversation_id)?, "members": self.mls.members(&conversation_id)? }),
            ),
            Command::AddMembers {
                conversation_id,
                key_packages,
            } => serde_json::to_value(self.mls.add_members(&conversation_id, &key_packages)?)
                .map_err(|_| CryptoError::State),
            Command::RemoveMembers {
                conversation_id,
                device_ids,
            } => serde_json::to_value(self.mls.remove_members(&conversation_id, &device_ids)?)
                .map_err(|_| CryptoError::State),
            Command::AcknowledgeCommit {
                conversation_id,
                commit,
            } => {
                self.mls.acknowledge_commit(&conversation_id, &commit)?;
                Ok(json!({ "epoch": self.mls.epoch(&conversation_id)? }))
            }
            Command::Join {
                conversation_id,
                welcome,
            } => {
                self.mls.join(&conversation_id, &welcome)?;
                Ok(json!({ "epoch": self.mls.epoch(&conversation_id)? }))
            }
            Command::Send {
                conversation_id,
                message_id,
                content,
            } => {
                if content.is_empty() || content.len() > 64 * 1024 {
                    return Err(CryptoError::InvalidInput);
                }
                let context = MessageContext {
                    conversation_id,
                    message_id,
                    sender_account_id: self.mls.device().account_id.clone(),
                    sender_device_id: self.mls.device().device_id.clone(),
                };
                let key = envelope::random_key();
                let body = envelope::seal(
                    &key,
                    content.as_bytes(),
                    &context.aad(b"coherent/message-body/v1\0")?,
                )?;
                let record = ContentKey {
                    version: 1,
                    context: context.clone(),
                    key: BASE64_STANDARD.encode(key.as_ref()),
                    body_hash: BASE64_STANDARD.encode(Sha256::digest(
                        serde_json::to_vec(&body).map_err(|_| CryptoError::State)?,
                    )),
                };
                let bytes =
                    Zeroizing::new(serde_json::to_vec(&record).map_err(|_| CryptoError::State)?);
                let epoch = self.mls.epoch(&context.conversation_id)?;
                let wire = self
                    .mls
                    .send_application(&context.conversation_id, &bytes)?;
                self.archive_in_use = true;
                Ok(
                    json!({ "context": context, "epoch": epoch, "wire": wire, "body": body, "archive": self.archive(&record)? }),
                )
            }
            Command::Receive {
                conversation_id,
                message_id,
                wire,
                body,
            } => match self.mls.receive(&conversation_id, &wire)? {
                Received::Application {
                    author,
                    payload,
                    epoch,
                } => {
                    let record: ContentKey =
                        serde_json::from_slice(&payload).map_err(|_| CryptoError::InvalidInput)?;
                    if record.context.conversation_id != conversation_id
                        || message_id.as_ref() != Some(&record.context.message_id)
                        || record.context.sender_account_id != author.account_id
                        || record.context.sender_device_id != author.device_id
                    {
                        return Err(CryptoError::Authentication);
                    }
                    let content =
                        self.decrypt_content(&record, &body.ok_or(CryptoError::InvalidInput)?)?;
                    self.archive_in_use = true;
                    Ok(
                        json!({ "kind": "application", "context": record.context, "epoch": epoch, "content": content, "archive": self.archive(&record)? }),
                    )
                }
                Received::Commit { epoch, removed } => {
                    if body.is_some() || message_id.is_some() {
                        return Err(CryptoError::InvalidInput);
                    }
                    Ok(json!({ "kind": "commit", "epoch": epoch, "removed": removed }))
                }
            },
            Command::OpenHistory {
                context,
                body,
                archive,
            } => {
                let bytes =
                    envelope::open(&self.archive_key, &archive, &self.archive_aad(&context)?)?;
                let record: ContentKey =
                    serde_json::from_slice(&bytes).map_err(|_| CryptoError::InvalidInput)?;
                if serde_json::to_vec(&record.context).map_err(|_| CryptoError::State)?
                    != serde_json::to_vec(&context).map_err(|_| CryptoError::State)?
                {
                    return Err(CryptoError::Authentication);
                }
                let content = self.decrypt_content(&record, &body)?;
                self.archive_in_use = true;
                Ok(json!({ "context": context, "content": content }))
            }
            Command::CreateRecovery | Command::RecoveryBackup => {
                let reveal = matches!(command, Command::CreateRecovery);
                if self.recovery_phrase.is_none() {
                    self.recovery_phrase = Some(recovery::generate_phrase()?);
                }
                let phrase = self.recovery_phrase.as_ref().ok_or(CryptoError::State)?;
                if self.recovery_backup.is_none() {
                    self.recovery_backup = Some(recovery::protect_archive_key(
                        &self.mls.device().account_id,
                        phrase,
                        &self.archive_key,
                    )?);
                }
                let backup = self.recovery_backup.as_ref().ok_or(CryptoError::State)?;
                if reveal {
                    Ok(json!({ "phrase": phrase.as_str(), "backup": backup }))
                } else {
                    Ok(
                        json!({ "backup": backup, "recovery_public_key": BASE64_STANDARD.encode(recovery::authorization_public(&self.mls.device().account_id, phrase)?) }),
                    )
                }
            }
            Command::ShowRecovery => Ok(
                json!({ "phrase": self.recovery_phrase.as_ref().ok_or(CryptoError::State)?.as_str() }),
            ),
            Command::SignDeviceProof {
                purpose,
                nonce,
                backup,
            } => {
                let hash: [u8; 32] = if purpose == "bootstrap" {
                    let backup = backup.ok_or(CryptoError::InvalidInput)?;
                    let cached = self.recovery_backup.as_ref().ok_or(CryptoError::State)?;
                    if backup.version != cached.version
                        || backup.nonce != cached.nonce
                        || backup.ciphertext != cached.ciphertext
                    {
                        return Err(CryptoError::Authentication);
                    }
                    if backup.version != 1 {
                        return Err(CryptoError::InvalidInput);
                    }
                    let mut bytes = b"coherent/bootstrap-backup/v1\0".to_vec();
                    let iv = BASE64_STANDARD
                        .decode(&backup.nonce)
                        .map_err(|_| CryptoError::InvalidInput)?;
                    let ciphertext = BASE64_STANDARD
                        .decode(&backup.ciphertext)
                        .map_err(|_| CryptoError::InvalidInput)?;
                    if iv.len() != 12 || ciphertext.len() != 48 {
                        return Err(CryptoError::InvalidInput);
                    }
                    bytes.extend_from_slice(&iv);
                    bytes.extend_from_slice(&ciphertext);
                    bytes.extend_from_slice(&recovery::authorization_public(
                        &self.mls.device().account_id,
                        self.recovery_phrase.as_ref().ok_or(CryptoError::State)?,
                    )?);
                    Sha256::digest(bytes).into()
                } else {
                    if backup.is_some() {
                        return Err(CryptoError::InvalidInput);
                    }
                    [0; 32]
                };
                Ok(
                    json!({ "device": self.mls.device(), "proof": self.mls.sign_device_proof(&purpose, &nonce, &hash)? }),
                )
            }
            Command::RecoverArchive { phrase, backup } => {
                let phrase = Zeroizing::new(phrase);
                let result =
                    recovery::recover_archive_key(&self.mls.device().account_id, &phrase, &backup);
                let recovered = result?;
                if self.archive_in_use && *recovered != *self.archive_key {
                    return Err(CryptoError::State);
                }
                self.archive_key = recovered;
                self.recovery_backup = Some(backup);
                self.recovery_phrase = Some(Zeroizing::new(
                    phrase
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .to_lowercase(),
                ));
                Ok(json!({}))
            }
        }
    }

    pub fn snapshot_local(&self) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
        let snapshot = LocalEngine {
            version: 1,
            mls: BASE64_STANDARD.encode(self.mls.snapshot_local()?.as_slice()),
            archive_key: BASE64_STANDARD.encode(self.archive_key.as_ref()),
            archive_in_use: self.archive_in_use,
            recovery_phrase: self
                .recovery_phrase
                .as_ref()
                .map(|phrase| phrase.to_string()),
            recovery_backup: self.recovery_backup.clone(),
        };
        Ok(Zeroizing::new(
            serde_json::to_vec(&snapshot).map_err(|_| CryptoError::State)?,
        ))
    }

    pub fn restore_local(bytes: &[u8]) -> Result<Self, CryptoError> {
        if bytes.len() > 48 * 1024 * 1024 {
            return Err(CryptoError::State);
        }
        let snapshot: LocalEngine =
            serde_json::from_slice(bytes).map_err(|_| CryptoError::State)?;
        if snapshot.version != 1 {
            return Err(CryptoError::State);
        }
        let mls_bytes = Zeroizing::new(
            BASE64_STANDARD
                .decode(&snapshot.mls)
                .map_err(|_| CryptoError::State)?,
        );
        let key = Zeroizing::new(
            BASE64_STANDARD
                .decode(&snapshot.archive_key)
                .map_err(|_| CryptoError::State)?,
        );
        let archive_key =
            Zeroizing::new(key.as_slice().try_into().map_err(|_| CryptoError::State)?);
        Ok(Self {
            mls: MlsClient::restore_local(&mls_bytes)?,
            archive_key,
            archive_in_use: snapshot.archive_in_use,
            recovery_phrase: snapshot
                .recovery_phrase
                .as_ref()
                .map(|phrase| Zeroizing::new(phrase.clone())),
            recovery_backup: snapshot.recovery_backup.clone(),
        })
    }
}
