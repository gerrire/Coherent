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
    pairing::Pairing,
    recovery,
    trust::{self, SignedRoster, TrustStore},
    uuid_bytes,
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
    #[serde(default)]
    trust: TrustStore,
    #[serde(default)]
    cursors: std::collections::BTreeMap<String, u64>,
    #[serde(default)]
    pairings: std::collections::BTreeMap<String, Pairing>,
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

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedContentKey {
    record: ContentKey,
    author: DeviceBinding,
    signature: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryBackup {
    pub version: u8,
    pub recipient: String,
    pub encapsulated: String,
    pub ciphertext: String,
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
    LinkStart {
        id: String,
    },
    LinkInfo {
        id: String,
    },
    LinkOffer {
        id: String,
        device: DeviceBinding,
        code: String,
    },
    LinkRespond {
        id: String,
        device: DeviceBinding,
        request: String,
    },
    LinkSend {
        id: String,
        response: String,
        previous: SignedRoster,
    },
    LinkFinish {
        id: String,
        finalization: String,
        envelope: Envelope,
        public_key: String,
    },
    LinkCancel {
        id: String,
    },
    LinkPrune {
        ids: Vec<String>,
    },
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
        #[serde(default)]
        archive_accounts: Option<Vec<String>>,
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
    OwnFingerprint,
    ExportContactPins,
    ImportContactPins {
        pins: Vec<trust::ContactPin>,
    },
    PrepareRoster {
        previous: Option<SignedRoster>,
    },
    InspectRoster {
        public_key: String,
        roster: SignedRoster,
    },
    AcceptRoster {
        public_key: String,
        roster: SignedRoster,
        fingerprint: Option<String>,
    },
    SignAction {
        nonce: String,
        payload: String,
    },
    OpenBackup {
        context: MessageContext,
        body: Envelope,
        backup: HistoryBackup,
    },
    VerifyAction {
        device: DeviceBinding,
        nonce: String,
        payload: String,
        proof: String,
    },
    StreamCursor {
        stream: String,
    },
    ApplyEvent {
        stream: String,
        sequence: u64,
        command: Option<Box<Command>>,
        expected_members: Option<Vec<String>>,
        group_id: Option<String>,
    },
    DiscardCommit {
        conversation_id: String,
        commit: String,
    },
    SealChunk {
        context: MessageContext,
        file_id: String,
        index: u32,
        count: u32,
        key: Option<String>,
        data: String,
    },
    OpenChunk {
        context: MessageContext,
        file_id: String,
        index: u32,
        count: u32,
        key: String,
        envelope: Envelope,
    },
}

pub struct CryptoEngine {
    mls: MlsClient,
    archive_key: Zeroizing<[u8; 32]>,
    archive_in_use: bool,
    recovery_phrase: Option<Zeroizing<String>>,
    recovery_backup: Option<Envelope>,
    trust: TrustStore,
    cursors: std::collections::BTreeMap<String, u64>,
    pairings: std::collections::BTreeMap<String, Pairing>,
}

impl CryptoEngine {
    pub fn new(account_id: &str, device_id: &str) -> Result<Self, CryptoError> {
        Ok(Self {
            mls: MlsClient::new(account_id, device_id)?,
            archive_key: envelope::random_key(),
            archive_in_use: false,
            recovery_phrase: None,
            recovery_backup: None,
            trust: TrustStore::default(),
            cursors: std::collections::BTreeMap::new(),
            pairings: std::collections::BTreeMap::new(),
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
            Command::LinkStart { id } => {
                if self.pairings.contains_key(&id) {
                    return Err(CryptoError::State);
                }
                self.pairings.retain(|_, pair| !pair.is_new());
                if self.pairings.len() >= 4 {
                    return Err(CryptoError::State);
                }
                let (pair, code) = Pairing::new_device(&id, self.mls.device().clone())?;
                self.pairings.insert(id, pair);
                Ok(json!({"code":code,"device":self.mls.device()}))
            }
            Command::LinkInfo { id } => {
                let pair = self.pairings.get(&id).ok_or(CryptoError::State)?;
                Ok(json!({"code":pair.code()}))
            }
            Command::LinkOffer { id, device, code } => {
                if self.recovery_phrase.is_none()
                    || self.pairings.len() >= 4
                    || self.pairings.contains_key(&id)
                {
                    return Err(CryptoError::State);
                }
                let (pair, request) =
                    Pairing::old_device(&id, device, self.mls.device().clone(), code)?;
                self.pairings.insert(id, pair);
                Ok(json!({"request":request}))
            }
            Command::LinkRespond {
                id,
                device,
                request,
            } => {
                let response = self
                    .pairings
                    .get_mut(&id)
                    .ok_or(CryptoError::State)?
                    .respond(&id, device, &request)?;
                Ok(json!({"response":response}))
            }
            Command::LinkSend {
                id,
                response,
                previous,
            } => {
                let target = self
                    .pairings
                    .get(&id)
                    .ok_or(CryptoError::State)?
                    .new_device
                    .clone();
                let phrase = self.recovery_phrase.as_ref().ok_or(CryptoError::State)?;
                let public_key = BASE64_STANDARD.encode(recovery::authorization_public(
                    &self.mls.device().account_id,
                    phrase,
                )?);
                let old_roster = trust::verify_roster(&public_key, &previous)?;
                if !old_roster.devices.contains(self.mls.device()) {
                    return Err(CryptoError::UntrustedDevice);
                }
                let roster =
                    self.trust
                        .own_roster(&target, phrase, &self.archive_key, Some(previous))?;
                let plain=Zeroizing::new(serde_json::to_vec(&json!({"version":1,"id":id,"device":target,"phrase":phrase.as_str(),"backup":self.recovery_backup.as_ref().ok_or(CryptoError::State)?,"roster":roster,"public_key":public_key})).map_err(|_|CryptoError::State)?);
                let sealed = self
                    .pairings
                    .get_mut(&id)
                    .ok_or(CryptoError::State)?
                    .seal(&id, &response, &plain);
                let (finalization, envelope) = match sealed {
                    Ok(value) => value,
                    Err(_) => {
                        self.pairings.remove(&id);
                        return Ok(json!({"rejected":true}));
                    }
                };
                Ok(json!({"finalization":finalization,"envelope":envelope}))
            }
            Command::LinkFinish {
                id,
                finalization,
                envelope,
                public_key,
            } => {
                let pair = self.pairings.get(&id).ok_or(CryptoError::State)?;
                let plain = pair.open(&id, &finalization, &envelope)?;
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Transfer {
                    version: u8,
                    id: String,
                    device: DeviceBinding,
                    phrase: String,
                    backup: Envelope,
                    roster: SignedRoster,
                    public_key: String,
                }
                let mut data: Transfer =
                    serde_json::from_slice(&plain).map_err(|_| CryptoError::Authentication)?;
                let phrase = Zeroizing::new(std::mem::take(&mut data.phrase));
                if data.version != 1
                    || data.id != id
                    || data.device != *self.mls.device()
                    || data.public_key != public_key
                    || BASE64_STANDARD.encode(recovery::authorization_public(
                        &data.device.account_id,
                        &phrase,
                    )?) != public_key
                {
                    return Err(CryptoError::Authentication);
                }
                let roster = trust::verify_roster(&public_key, &data.roster)?;
                if !roster.devices.contains(self.mls.device())
                    || !roster
                        .devices
                        .contains(pair.old_device.as_ref().ok_or(CryptoError::State)?)
                {
                    return Err(CryptoError::Authentication);
                }
                let recovered =
                    recovery::recover_archive_key(&data.device.account_id, &phrase, &data.backup)?;
                if self.archive_in_use && *recovered != *self.archive_key {
                    return Err(CryptoError::State);
                }
                self.archive_key = recovered;
                self.recovery_phrase = Some(phrase);
                self.recovery_backup = Some(data.backup);
                self.pairings.remove(&id);
                Ok(json!({"roster":data.roster}))
            }
            Command::LinkPrune { ids } => {
                if ids.len() > 8 {
                    return Err(CryptoError::InvalidInput);
                }
                self.pairings.retain(|id, p| p.is_new() || ids.contains(id));
                Ok(json!({}))
            }
            Command::LinkCancel { id } => {
                self.pairings.remove(&id);
                Ok(json!({}))
            }
            Command::Identity => Ok(
                json!({ "device": self.mls.device(), "fingerprint": self.mls.device().fingerprint()? }),
            ),
            Command::StreamCursor { stream } => {
                uuid_bytes(&stream)?;
                Ok(json!({"sequence":self.cursors.get(&stream).copied().unwrap_or(0)}))
            }
            Command::ApplyEvent {
                stream,
                sequence,
                command,
                expected_members,
                group_id,
            } => {
                uuid_bytes(&stream)?;
                let current = self.cursors.get(&stream).copied().unwrap_or(0);
                if sequence <= current {
                    return Ok(json!({"duplicate":true}));
                }
                if sequence != current + 1 || self.cursors.len() > 1000 {
                    return Err(CryptoError::State);
                }
                let result = if let Some(command) = command {
                    if !matches!(
                        *command,
                        Command::Join { .. }
                            | Command::Receive { .. }
                            | Command::AcknowledgeCommit { .. }
                    ) {
                        return Err(CryptoError::InvalidInput);
                    }
                    self.execute(*command)?
                } else {
                    json!({})
                };
                if let Some(expected) = expected_members {
                    let group_id = group_id.as_ref().ok_or(CryptoError::State)?;
                    let actual: std::collections::BTreeSet<_> = self
                        .mls
                        .members(group_id)?
                        .into_iter()
                        .map(|d| d.device_id)
                        .collect();
                    let desired: std::collections::BTreeSet<_> = expected.iter().cloned().collect();
                    if actual != desired || desired.len() != expected.len() {
                        return Err(CryptoError::UntrustedDevice);
                    }
                }
                self.cursors.insert(stream, sequence);
                Ok(result)
            }
            Command::ExportContactPins => {
                use ed25519_dalek::Signer;
                let account = &self.mls.device().account_id;
                let signer = recovery::authorization_signer(
                    account,
                    self.recovery_phrase.as_ref().ok_or(CryptoError::State)?,
                )?;
                let mut anchors = self.trust.anchors.clone();
                for (id, pin) in &self.trust.accounts {
                    anchors.entry(id.clone()).or_insert(pin.public_key.clone());
                }
                let mut pins = Vec::new();
                for (id, public) in anchors {
                    if id != *account {
                        pins.push(trust::ContactPin {
                            account_id: id.clone(),
                            public_key: public.clone(),
                            proof: BASE64_STANDARD.encode(
                                signer
                                    .sign(&trust::contact_bytes(account, &id, &public)?)
                                    .to_bytes(),
                            ),
                        });
                    }
                }
                Ok(json!({"pins":pins}))
            }
            Command::ImportContactPins { pins } => {
                if pins.len() > 1000 {
                    return Err(CryptoError::InvalidInput);
                }
                let account = &self.mls.device().account_id;
                let public = BASE64_STANDARD.encode(recovery::authorization_public(
                    account,
                    self.recovery_phrase.as_ref().ok_or(CryptoError::State)?,
                )?);
                for pin in pins {
                    if pin.account_id == *account {
                        return Err(CryptoError::InvalidInput);
                    }
                    trust::verify(
                        &public,
                        &trust::contact_bytes(account, &pin.account_id, &pin.public_key)?,
                        &pin.proof,
                    )?;
                    if self
                        .trust
                        .anchors
                        .get(&pin.account_id)
                        .is_some_and(|old| old != &pin.public_key)
                        || self
                            .trust
                            .accounts
                            .get(&pin.account_id)
                            .is_some_and(|old| old.public_key != pin.public_key)
                    {
                        return Err(CryptoError::UntrustedDevice);
                    }
                    self.trust.anchors.insert(pin.account_id, pin.public_key);
                }
                Ok(json!({}))
            }
            Command::OwnFingerprint => {
                let account = &self.mls.device().account_id;
                let public = BASE64_STANDARD.encode(recovery::authorization_public(
                    account,
                    self.recovery_phrase.as_ref().ok_or(CryptoError::State)?,
                )?);
                let known = self
                    .trust
                    .accounts
                    .get(account)
                    .map(|p| trust::verify_roster(&p.public_key, &p.roster))
                    .transpose()?
                    .map(|r| r.revision)
                    .unwrap_or(0);
                Ok(
                    json!({"public_key":public,"fingerprint":trust::fingerprint(account,&public)?,"known_revision":known}),
                )
            }
            Command::PrepareRoster { previous } => {
                let roster = self.trust.own_roster(
                    self.mls.device(),
                    self.recovery_phrase.as_ref().ok_or(CryptoError::State)?,
                    &self.archive_key,
                    previous,
                )?;
                Ok(
                    json!({"roster":roster,"public_key":BASE64_STANDARD.encode(recovery::authorization_public(&self.mls.device().account_id,self.recovery_phrase.as_ref().ok_or(CryptoError::State)?)?)}),
                )
            }
            Command::InspectRoster { public_key, roster } => {
                let parsed = trust::verify_roster(&public_key, &roster)?;
                let pinned = self
                    .trust
                    .accounts
                    .get(&parsed.account_id)
                    .map(|p| p.public_key == public_key)
                    .or_else(|| {
                        self.trust
                            .anchors
                            .get(&parsed.account_id)
                            .map(|p| p == &public_key)
                    })
                    .unwrap_or(false);
                let known = self
                    .trust
                    .accounts
                    .get(&parsed.account_id)
                    .map(|p| trust::verify_roster(&p.public_key, &p.roster))
                    .transpose()?
                    .map(|r| r.revision)
                    .unwrap_or(0);
                let changed = self
                    .trust
                    .accounts
                    .get(&parsed.account_id)
                    .map(|p| p.public_key != public_key)
                    .or_else(|| {
                        self.trust
                            .anchors
                            .get(&parsed.account_id)
                            .map(|p| p != &public_key)
                    })
                    .unwrap_or(false);
                Ok(
                    json!({"account_id":parsed.account_id,"revision":parsed.revision,"fingerprint":trust::fingerprint(&parsed.account_id,&public_key)?,"pinned":pinned,"known_revision":known,"changed":changed,"devices":parsed.devices}),
                )
            }
            Command::AcceptRoster {
                public_key,
                roster,
                fingerprint,
            } => {
                let parsed = self
                    .trust
                    .accept(&public_key, roster, fingerprint.as_deref())?;
                for device in &parsed.devices {
                    self.mls.pin_device(device.clone())?;
                }
                Ok(json!({"account_id":parsed.account_id,"devices":parsed.devices}))
            }
            Command::SignAction { nonce, payload } => {
                if payload.len() > 2 * 1024 * 1024 {
                    return Err(CryptoError::InvalidInput);
                }
                Ok(
                    json!({"device":self.mls.device(),"proof":self.mls.sign_device_proof("action",&nonce,&Sha256::digest(payload.as_bytes()).into())?}),
                )
            }
            Command::DiscardCommit {
                conversation_id,
                commit,
            } => {
                self.mls.discard_pending(&conversation_id, &commit)?;
                Ok(json!({}))
            }
            Command::VerifyAction {
                device,
                nonce,
                payload,
                proof,
            } => {
                self.mls.verify_action(&device, &nonce, &payload, &proof)?;
                Ok(json!({"verified":true}))
            }
            Command::SealChunk {
                context,
                file_id,
                index,
                count,
                key,
                data,
            } => {
                let bytes = Zeroizing::new(
                    BASE64_STANDARD
                        .decode(data)
                        .map_err(|_| CryptoError::InvalidInput)?,
                );
                if bytes.len() > 1024 * 1024 || bytes.is_empty() {
                    return Err(CryptoError::InvalidInput);
                }
                let key = if let Some(key) = key {
                    Zeroizing::new(
                        trust::decode(&key, 32)?
                            .try_into()
                            .map_err(|_| CryptoError::InvalidInput)?,
                    )
                } else {
                    envelope::random_key()
                };
                let encrypted = envelope::seal(
                    &key,
                    &bytes,
                    &Self::chunk_aad(&context, &file_id, index, count)?,
                )?;
                Ok(json!({"key":BASE64_STANDARD.encode(key.as_ref()),"envelope":encrypted}))
            }
            Command::OpenChunk {
                context,
                file_id,
                index,
                count,
                key,
                envelope,
            } => {
                let key = Zeroizing::new(trust::decode(&key, 32)?);
                let key: &[u8; 32] = key
                    .as_slice()
                    .try_into()
                    .map_err(|_| CryptoError::InvalidInput)?;
                let bytes = envelope::open(
                    key,
                    &envelope,
                    &Self::chunk_aad(&context, &file_id, index, count)?,
                )?;
                if bytes.len() > 1024 * 1024 {
                    return Err(CryptoError::InvalidInput);
                }
                Ok(json!({"data":BASE64_STANDARD.encode(bytes.as_slice())}))
            }
            Command::OpenBackup {
                context,
                body,
                backup,
            } => {
                if backup.version != 1
                    || backup.recipient != self.mls.device().account_id
                    || backup.ciphertext.len() > 16384
                {
                    return Err(CryptoError::InvalidInput);
                }
                let pair = trust::archive_pair(&backup.recipient, &self.archive_key)?;
                let aad = Self::history_aad(&context, &backup.recipient)?;
                let bytes = Zeroizing::new(
                    trust::hpke()
                        .open(
                            &trust::decode(&backup.encapsulated, 32)?,
                            pair.private_key(),
                            b"coherent/history-hpke/v1",
                            &aad,
                            &BASE64_STANDARD
                                .decode(backup.ciphertext)
                                .map_err(|_| CryptoError::InvalidInput)?,
                            None,
                            None,
                            None,
                        )
                        .map_err(|_| CryptoError::Authentication)?,
                );
                let signed: SignedContentKey =
                    serde_json::from_slice(&bytes).map_err(|_| CryptoError::InvalidInput)?;
                if signed.author.account_id != context.sender_account_id
                    || signed.author.device_id != context.sender_device_id
                    || serde_json::to_vec(&signed.record.context).map_err(|_| CryptoError::State)?
                        != serde_json::to_vec(&context).map_err(|_| CryptoError::State)?
                {
                    return Err(CryptoError::Authentication);
                }
                self.mls.verify_history(
                    &signed.author,
                    &serde_json::to_vec(&signed.record).map_err(|_| CryptoError::State)?,
                    &signed.signature,
                )?;
                let content = self.decrypt_content(&signed.record, &body)?;
                self.archive_in_use = true;
                Ok(json!({"content":content,"context":context}))
            }
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
                archive_accounts,
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
                let mut backups = std::collections::BTreeMap::new();
                if let Some(accounts) = archive_accounts {
                    let members: std::collections::BTreeSet<_> = self
                        .mls
                        .members(&context.conversation_id)?
                        .into_iter()
                        .map(|d| d.account_id)
                        .collect();
                    let requested: std::collections::BTreeSet<_> =
                        accounts.iter().cloned().collect();
                    if requested != members
                        || requested.len() != accounts.len()
                        || requested.len() > 10
                    {
                        return Err(CryptoError::UntrustedDevice);
                    }
                    let signed = SignedContentKey {
                        signature: self.mls.history_signature(&bytes)?,
                        author: self.mls.device().clone(),
                        record,
                    };
                    let plain = Zeroizing::new(
                        serde_json::to_vec(&signed).map_err(|_| CryptoError::State)?,
                    );
                    for account in accounts {
                        let pin = self
                            .trust
                            .accounts
                            .get(&account)
                            .ok_or(CryptoError::UntrustedDevice)?;
                        let roster = trust::verify_roster(&pin.public_key, &pin.roster)?;
                        let (enc, ciphertext) = trust::hpke()
                            .seal(
                                &hpke_rs::HpkePublicKey::new(trust::decode(
                                    &roster.archive_public_key,
                                    32,
                                )?),
                                b"coherent/history-hpke/v1",
                                &Self::history_aad(&context, &account)?,
                                &plain,
                                None,
                                None,
                                None,
                            )
                            .map_err(|_| CryptoError::Authentication)?;
                        if account == self.mls.device().account_id {
                            let pair = trust::archive_pair(&account, &self.archive_key)?;
                            let opened = Zeroizing::new(
                                trust::hpke()
                                    .open(
                                        &enc,
                                        pair.private_key(),
                                        b"coherent/history-hpke/v1",
                                        &Self::history_aad(&context, &account)?,
                                        &ciphertext,
                                        None,
                                        None,
                                        None,
                                    )
                                    .map_err(|_| CryptoError::Authentication)?,
                            );
                            if opened.as_slice() != plain.as_slice() {
                                return Err(CryptoError::Authentication);
                            }
                        }
                        backups.insert(
                            account.clone(),
                            HistoryBackup {
                                version: 1,
                                recipient: account,
                                encapsulated: BASE64_STANDARD.encode(enc),
                                ciphertext: BASE64_STANDARD.encode(ciphertext),
                            },
                        );
                    }
                    self.archive_in_use = true;
                    return Ok(
                        json!({"context":context,"epoch":epoch,"wire":wire,"body":body,"backups":backups}),
                    );
                }
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

    fn history_aad(context: &MessageContext, account: &str) -> Result<Vec<u8>, CryptoError> {
        let mut aad = context.aad(b"coherent/history-hpke/v1\0")?;
        aad.extend_from_slice(&uuid_bytes(account)?);
        Ok(aad)
    }
    fn chunk_aad(
        context: &MessageContext,
        file: &str,
        index: u32,
        count: u32,
    ) -> Result<Vec<u8>, CryptoError> {
        if count == 0 || count > 25 || index >= count {
            return Err(CryptoError::InvalidInput);
        }
        let mut aad = context.aad(b"coherent/attachment-chunk/v1\0")?;
        aad.extend_from_slice(&uuid_bytes(file)?);
        aad.extend_from_slice(&index.to_be_bytes());
        aad.extend_from_slice(&count.to_be_bytes());
        Ok(aad)
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
            trust: self.trust.clone(),
            cursors: self.cursors.clone(),
            pairings: self.pairings.clone(),
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
            trust: snapshot.trust.clone(),
            cursors: snapshot.cursors.clone(),
            pairings: snapshot.pairings.clone(),
        })
    }
}
