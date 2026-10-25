//! RFC 9420 operations. Pinning is an application authentication decision: callers
//! must verify device bindings before passing them to `pin_device`.
use std::collections::{BTreeMap, BTreeSet};

use base64::{Engine, prelude::BASE64_STANDARD};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::{OpenMlsProvider, signatures::Signer, types::SignatureScheme};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};
use zeroize::{Zeroize, Zeroizing};

use crate::{CryptoError, uuid_bytes};

const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
const MAX_WIRE: usize = 1024 * 1024;
const MAX_STATE: usize = 32 * 1024 * 1024;
const MAX_MEMBERS: usize = 100;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceBinding {
    pub version: u8,
    pub account_id: String,
    pub device_id: String,
    pub signature_key: String,
}

impl DeviceBinding {
    pub fn validate(&self) -> Result<(), CryptoError> {
        if self.version != 1
            || uuid::Uuid::from_bytes(uuid_bytes(&self.account_id)?).to_string() != self.account_id
            || uuid::Uuid::from_bytes(uuid_bytes(&self.device_id)?).to_string() != self.device_id
            || BASE64_STANDARD
                .decode(&self.signature_key)
                .map_err(|_| CryptoError::InvalidInput)?
                .len()
                != 32
        {
            return Err(CryptoError::InvalidInput);
        }
        Ok(())
    }

    pub fn fingerprint(&self) -> Result<String, CryptoError> {
        self.validate()?;
        let mut hash = Sha256::new();
        hash.update(b"coherent/device-binding/v1\0");
        hash.update(uuid_bytes(&self.account_id)?);
        hash.update(uuid_bytes(&self.device_id)?);
        hash.update(
            BASE64_STANDARD
                .decode(&self.signature_key)
                .map_err(|_| CryptoError::InvalidInput)?,
        );
        Ok(BASE64_STANDARD.encode(hash.finalize()))
    }

    fn credential(&self) -> Result<CredentialWithKey, CryptoError> {
        self.validate()?;
        Ok(CredentialWithKey {
            credential: BasicCredential::new(
                serde_json::to_vec(self).map_err(|_| CryptoError::InvalidInput)?,
            )
            .into(),
            signature_key: BASE64_STANDARD
                .decode(&self.signature_key)
                .map_err(|_| CryptoError::InvalidInput)?
                .into(),
        })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalSnapshot {
    version: u8,
    device: DeviceBinding,
    pins: Vec<DeviceBinding>,
    // These entries include private keys. Only authenticated local vaults may
    // store this snapshot; it must never be used as a server recovery backup.
    entries: Vec<(String, String)>,
    pending_commits: BTreeMap<String, String>,
    allowed_devices: BTreeMap<String, BTreeSet<String>>,
}

impl Drop for LocalSnapshot {
    fn drop(&mut self) {
        for (_, value) in &mut self.entries {
            value.zeroize();
        }
    }
}

#[derive(Serialize)]
pub struct CommitBundle {
    pub commit: String,
    pub welcome: Option<String>,
    pub previous_epoch: u64,
}

pub(crate) enum Received {
    Application {
        author: DeviceBinding,
        payload: Zeroizing<Vec<u8>>,
        epoch: u64,
    },
    Commit {
        epoch: u64,
        removed: bool,
    },
}

pub(crate) struct MlsClient {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    device: DeviceBinding,
    pins: BTreeMap<String, DeviceBinding>,
    pending_commits: BTreeMap<String, String>,
    allowed_devices: BTreeMap<String, BTreeSet<String>>,
}

fn encode(message: &MlsMessageOut) -> Result<String, CryptoError> {
    Ok(BASE64_STANDARD.encode(
        message
            .tls_serialize_detached()
            .map_err(|_| CryptoError::Mls)?,
    ))
}

fn decode(wire: &str) -> Result<MlsMessageIn, CryptoError> {
    if wire.len() > MAX_WIRE * 4 / 3 + 4 {
        return Err(CryptoError::InvalidInput);
    }
    let bytes = BASE64_STANDARD
        .decode(wire)
        .map_err(|_| CryptoError::InvalidInput)?;
    MlsMessageIn::tls_deserialize_exact(&bytes).map_err(|_| CryptoError::Mls)
}

fn binding(credential: &Credential, signature_key: &[u8]) -> Result<DeviceBinding, CryptoError> {
    let credential =
        BasicCredential::try_from(credential.clone()).map_err(|_| CryptoError::UntrustedDevice)?;
    if credential.identity().len() > 1024 {
        return Err(CryptoError::UntrustedDevice);
    }
    let device: DeviceBinding =
        serde_json::from_slice(credential.identity()).map_err(|_| CryptoError::UntrustedDevice)?;
    device.validate()?;
    if BASE64_STANDARD
        .decode(&device.signature_key)
        .map_err(|_| CryptoError::UntrustedDevice)?
        != signature_key
    {
        return Err(CryptoError::UntrustedDevice);
    }
    Ok(device)
}

impl MlsClient {
    pub fn new(account_id: &str, device_id: &str) -> Result<Self, CryptoError> {
        uuid_bytes(account_id)?;
        uuid_bytes(device_id)?;
        let provider = OpenMlsRustCrypto::default();
        let signer =
            SignatureKeyPair::new(SignatureScheme::ED25519).map_err(|_| CryptoError::Mls)?;
        signer
            .store(provider.storage())
            .map_err(|_| CryptoError::State)?;
        let device = DeviceBinding {
            version: 1,
            account_id: account_id.into(),
            device_id: device_id.into(),
            signature_key: BASE64_STANDARD.encode(signer.public()),
        };
        device.validate()?;
        let mut pins = BTreeMap::new();
        pins.insert(device.device_id.clone(), device.clone());
        Ok(Self {
            provider,
            signer,
            device,
            pins,
            pending_commits: BTreeMap::new(),
            allowed_devices: BTreeMap::new(),
        })
    }

    pub fn device(&self) -> &DeviceBinding {
        &self.device
    }

    pub fn sign_device_proof(
        &self,
        purpose: &str,
        nonce: &str,
        payload_hash: &[u8; 32],
    ) -> Result<String, CryptoError> {
        if !matches!(purpose, "bootstrap" | "recovery_view" | "confirm_recovery") {
            return Err(CryptoError::InvalidInput);
        }
        let nonce = BASE64_STANDARD
            .decode(nonce)
            .map_err(|_| CryptoError::InvalidInput)?;
        if nonce.len() != 32 {
            return Err(CryptoError::InvalidInput);
        }
        let mut bytes = b"coherent/device-proof/v1\0".to_vec();
        bytes.extend_from_slice(purpose.as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(&uuid_bytes(&self.device.account_id)?);
        bytes.extend_from_slice(&uuid_bytes(&self.device.device_id)?);
        bytes.extend_from_slice(self.signer.public());
        bytes.extend_from_slice(&nonce);
        bytes.extend_from_slice(payload_hash);
        Ok(BASE64_STANDARD.encode(self.signer.sign(&bytes).map_err(|_| CryptoError::Mls)?))
    }

    /// Never call this with an unverified server directory response.
    pub fn pin_device(&mut self, device: DeviceBinding) -> Result<(), CryptoError> {
        device.validate()?;
        if let Some(old) = self.pins.get(&device.device_id) {
            if old != &device {
                return Err(CryptoError::UntrustedDevice);
            }
        }
        if self.pins.len() >= 1000 && !self.pins.contains_key(&device.device_id) {
            return Err(CryptoError::InvalidInput);
        }
        self.pins.insert(device.device_id.clone(), device);
        Ok(())
    }

    /// A verified account roster alone does not grant access to every chat.
    /// Supply the devices authorized by the conversation's membership policy.
    pub fn authorize_conversation(
        &mut self,
        conversation: &str,
        devices: &[String],
    ) -> Result<(), CryptoError> {
        Self::group_id(conversation)?;
        if devices.is_empty() || devices.len() > MAX_MEMBERS {
            return Err(CryptoError::InvalidInput);
        }
        let mut allowed = BTreeSet::new();
        for id in devices {
            if !self.pins.contains_key(id) || !allowed.insert(id.clone()) {
                return Err(CryptoError::UntrustedDevice);
            }
        }
        if !allowed.contains(&self.device.device_id) {
            return Err(CryptoError::UntrustedDevice);
        }
        self.allowed_devices.insert(conversation.into(), allowed);
        Ok(())
    }

    fn check_conversation_device(
        &self,
        conversation: &str,
        device: &DeviceBinding,
    ) -> Result<(), CryptoError> {
        if !self
            .allowed_devices
            .get(conversation)
            .is_some_and(|ids| ids.contains(&device.device_id))
        {
            return Err(CryptoError::UntrustedDevice);
        }
        Ok(())
    }

    fn check_binding(
        &self,
        credential: &Credential,
        signature_key: &[u8],
    ) -> Result<DeviceBinding, CryptoError> {
        let device = binding(credential, signature_key)?;
        if self.pins.get(&device.device_id) != Some(&device) {
            return Err(CryptoError::UntrustedDevice);
        }
        Ok(device)
    }

    fn group_id(conversation: &str) -> Result<GroupId, CryptoError> {
        let mut bytes = b"coherent/mls/v1\0".to_vec();
        bytes.extend_from_slice(&uuid_bytes(conversation)?);
        Ok(GroupId::from_slice(&bytes))
    }

    fn load_group(&self, conversation: &str) -> Result<MlsGroup, CryptoError> {
        MlsGroup::load(self.provider.storage(), &Self::group_id(conversation)?)
            .map_err(|_| CryptoError::State)?
            .ok_or(CryptoError::State)
    }

    pub fn members(&self, conversation: &str) -> Result<Vec<DeviceBinding>, CryptoError> {
        self.load_group(conversation)?
            .members()
            .map(|member| {
                let device = self.check_binding(&member.credential, &member.signature_key)?;
                self.check_conversation_device(conversation, &device)?;
                Ok(device)
            })
            .collect()
    }

    pub fn epoch(&self, conversation: &str) -> Result<u64, CryptoError> {
        Ok(self.load_group(conversation)?.epoch().as_u64())
    }

    pub fn create_group(&self, conversation: &str) -> Result<(), CryptoError> {
        self.check_conversation_device(conversation, &self.device)?;
        let group_id = Self::group_id(conversation)?;
        if MlsGroup::load(self.provider.storage(), &group_id)
            .map_err(|_| CryptoError::State)?
            .is_some()
        {
            return Err(CryptoError::State);
        }
        MlsGroup::builder()
            .with_group_id(group_id)
            .ciphersuite(SUITE)
            .use_ratchet_tree_extension(true)
            .build(&self.provider, &self.signer, self.device.credential()?)
            .map_err(|_| CryptoError::Mls)?;
        Ok(())
    }

    pub fn key_package(&self) -> Result<String, CryptoError> {
        let bundle = KeyPackage::builder()
            .build(
                SUITE,
                &self.provider,
                &self.signer,
                self.device.credential()?,
            )
            .map_err(|_| CryptoError::Mls)?;
        Ok(BASE64_STANDARD.encode(
            bundle
                .key_package()
                .tls_serialize_detached()
                .map_err(|_| CryptoError::Mls)?,
        ))
    }

    pub fn add_members(
        &mut self,
        conversation: &str,
        packages: &[String],
    ) -> Result<CommitBundle, CryptoError> {
        let mut group = self.load_group(conversation)?;
        if packages.is_empty() || packages.len() + group.members().count() > MAX_MEMBERS {
            return Err(CryptoError::InvalidInput);
        }
        let mut devices: BTreeSet<String> = self
            .members(conversation)?
            .into_iter()
            .map(|m| m.device_id)
            .collect();
        let mut verified = Vec::new();
        for package in packages {
            if package.len() > MAX_WIRE {
                return Err(CryptoError::InvalidInput);
            }
            let bytes = BASE64_STANDARD
                .decode(package)
                .map_err(|_| CryptoError::InvalidInput)?;
            let kp = KeyPackageIn::tls_deserialize_exact(&bytes)
                .map_err(|_| CryptoError::Mls)?
                .validate(self.provider.crypto(), ProtocolVersion::Mls10)
                .map_err(|_| CryptoError::Mls)?;
            if kp.ciphersuite() != SUITE {
                return Err(CryptoError::Mls);
            }
            let device = self.check_binding(
                kp.leaf_node().credential(),
                kp.leaf_node().signature_key().as_slice(),
            )?;
            self.check_conversation_device(conversation, &device)?;
            if !devices.insert(device.device_id) {
                return Err(CryptoError::UntrustedDevice);
            }
            verified.push(kp);
        }
        let epoch = group.epoch().as_u64();
        let (commit, welcome, _) = group
            .add_members(&self.provider, &self.signer, &verified)
            .map_err(|_| CryptoError::Mls)?;
        let commit = encode(&commit)?;
        self.pending_commits
            .insert(conversation.into(), commit.clone());
        Ok(CommitBundle {
            commit,
            welcome: Some(encode(&welcome)?),
            previous_epoch: epoch,
        })
    }

    pub fn remove_members(
        &mut self,
        conversation: &str,
        device_ids: &[String],
    ) -> Result<CommitBundle, CryptoError> {
        let mut group = self.load_group(conversation)?;
        let requested: BTreeSet<_> = device_ids.iter().collect();
        if requested.is_empty()
            || requested.len() != device_ids.len()
            || requested.contains(&self.device.device_id)
        {
            return Err(CryptoError::InvalidInput);
        }
        let indices: Vec<_> = group
            .members()
            .filter_map(|m| {
                let device = binding(&m.credential, &m.signature_key).ok()?;
                requested.contains(&device.device_id).then_some(m.index)
            })
            .collect();
        if indices.len() != requested.len() {
            return Err(CryptoError::UntrustedDevice);
        }
        let epoch = group.epoch().as_u64();
        let (commit, welcome, _) = group
            .remove_members(&self.provider, &self.signer, &indices)
            .map_err(|_| CryptoError::Mls)?;
        let commit = encode(&commit)?;
        self.pending_commits
            .insert(conversation.into(), commit.clone());
        Ok(CommitBundle {
            commit,
            welcome: welcome.as_ref().map(encode).transpose()?,
            previous_epoch: epoch,
        })
    }

    /// Merge only after the delivery service accepted these exact bytes at the
    /// expected sequence. Keep pending state and retry identical bytes otherwise.
    pub fn acknowledge_commit(
        &mut self,
        conversation: &str,
        accepted_wire: &str,
    ) -> Result<(), CryptoError> {
        if self.pending_commits.get(conversation).map(String::as_str) != Some(accepted_wire) {
            return Err(CryptoError::Mls);
        }
        let mut group = self.load_group(conversation)?;
        group
            .merge_pending_commit(&self.provider)
            .map_err(|_| CryptoError::Mls)?;
        self.pending_commits.remove(conversation);
        Ok(())
    }

    pub fn join(&self, conversation: &str, welcome: &str) -> Result<(), CryptoError> {
        if MlsGroup::load(self.provider.storage(), &Self::group_id(conversation)?)
            .map_err(|_| CryptoError::State)?
            .is_some()
        {
            return Err(CryptoError::State);
        }
        let MlsMessageBodyIn::Welcome(welcome) = decode(welcome)?.extract() else {
            return Err(CryptoError::Mls);
        };
        let staged = StagedWelcome::new_from_welcome(
            &self.provider,
            &MlsGroupJoinConfig::builder().build(),
            welcome,
            None,
        )
        .map_err(|_| CryptoError::Mls)?;
        let members: Vec<_> = staged.members().collect();
        if members.len() > MAX_MEMBERS {
            return Err(CryptoError::InvalidInput);
        }
        let mut seen = BTreeSet::new();
        for member in members {
            let device = self.check_binding(&member.credential, &member.signature_key)?;
            self.check_conversation_device(conversation, &device)?;
            if !seen.insert(device.device_id) {
                return Err(CryptoError::UntrustedDevice);
            }
        }
        let mut group = staged
            .into_group(&self.provider)
            .map_err(|_| CryptoError::Mls)?;
        if group.group_id() != &Self::group_id(conversation)? || group.ciphersuite() != SUITE {
            group
                .delete(self.provider.storage())
                .map_err(|_| CryptoError::State)?;
            return Err(CryptoError::Mls);
        }
        Ok(())
    }

    pub fn send_application(
        &self,
        conversation: &str,
        payload: &[u8],
    ) -> Result<String, CryptoError> {
        if payload.len() > 64 * 1024 {
            return Err(CryptoError::InvalidInput);
        }
        let mut group = self.load_group(conversation)?;
        self.members(conversation)?;
        encode(
            &group
                .create_message(&self.provider, &self.signer, payload)
                .map_err(|_| CryptoError::Mls)?,
        )
    }

    pub fn receive(&mut self, conversation: &str, wire: &str) -> Result<Received, CryptoError> {
        let mut group = self.load_group(conversation)?;
        let protocol = decode(wire)?
            .try_into_protocol_message()
            .map_err(|_| CryptoError::Mls)?;
        let processed = group
            .process_message(&self.provider, protocol)
            .map_err(|_| CryptoError::Mls)?;
        // Authentication uses the signed MLS leaf, never the sender ID supplied
        // beside the ciphertext by the delivery service.
        let Sender::Member(_) = processed.sender() else {
            return Err(CryptoError::UntrustedDevice);
        };
        let credential = BasicCredential::try_from(processed.credential().clone())
            .map_err(|_| CryptoError::UntrustedDevice)?;
        let author: DeviceBinding = serde_json::from_slice(credential.identity())
            .map_err(|_| CryptoError::UntrustedDevice)?;
        // OpenMLS authenticates against the leaf in the message's own epoch.
        // Looking up today's leaf index would misidentify delayed messages.
        if self.pins.get(&author.device_id) != Some(&author) {
            return Err(CryptoError::UntrustedDevice);
        }
        self.check_conversation_device(conversation, &author)?;
        let epoch = processed.epoch().as_u64();
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(message) => Ok(Received::Application {
                author,
                payload: Zeroizing::new(message.into_bytes()),
                epoch,
            }),
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                for proposal in staged.queued_proposals() {
                    match proposal.proposal() {
                        Proposal::Add(add) => {
                            let leaf = add.key_package().leaf_node();
                            let device = self.check_binding(
                                leaf.credential(),
                                leaf.signature_key().as_slice(),
                            )?;
                            self.check_conversation_device(conversation, &device)?;
                        }
                        // This profile uses inline Add/Remove and an authenticated
                        // committer UpdatePath; standalone Update is unsupported.
                        Proposal::Remove(_) => (),
                        _ => return Err(CryptoError::UntrustedDevice),
                    }
                }
                if let Some(leaf) = staged.update_path_leaf_node() {
                    let device =
                        self.check_binding(leaf.credential(), leaf.signature_key().as_slice())?;
                    if device != author {
                        return Err(CryptoError::UntrustedDevice);
                    }
                }
                let removed = staged.self_removed();
                group
                    .merge_staged_commit(&self.provider, *staged)
                    .map_err(|_| CryptoError::Mls)?;
                if !removed {
                    let members: Vec<_> = group
                        .members()
                        .map(|member| self.check_binding(&member.credential, &member.signature_key))
                        .collect::<Result<_, _>>()?;
                    let unique: BTreeSet<_> = members.iter().map(|m| &m.device_id).collect();
                    if members.len() > MAX_MEMBERS || unique.len() != members.len() {
                        return Err(CryptoError::UntrustedDevice);
                    }
                }
                self.pending_commits.remove(conversation);
                Ok(Received::Commit {
                    epoch: group.epoch().as_u64(),
                    removed,
                })
            }
            // Standalone proposals/external joins are not part of this version.
            // An own private message is resolved from the exact local outbox.
            _ => Err(CryptoError::Mls),
        }
    }

    pub fn snapshot_local(&self) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
        let storage = self
            .provider
            .storage()
            .values
            .read()
            .map_err(|_| CryptoError::State)?;
        let snapshot = LocalSnapshot {
            version: 1,
            device: self.device.clone(),
            pins: self.pins.values().cloned().collect(),
            entries: storage
                .iter()
                .map(|(k, v)| (BASE64_STANDARD.encode(k), BASE64_STANDARD.encode(v)))
                .collect(),
            pending_commits: self.pending_commits.clone(),
            allowed_devices: self.allowed_devices.clone(),
        };
        let encoded =
            Zeroizing::new(serde_json::to_vec(&snapshot).map_err(|_| CryptoError::State)?);
        if encoded.len() > MAX_STATE {
            return Err(CryptoError::State);
        }
        Ok(encoded)
    }

    /// The caller must authenticate the local vault before loading this state.
    /// Never load a network recovery object as a live MLS snapshot.
    pub fn restore_local(bytes: &[u8]) -> Result<Self, CryptoError> {
        if bytes.len() > MAX_STATE {
            return Err(CryptoError::State);
        }
        let mut snapshot: LocalSnapshot =
            serde_json::from_slice(bytes).map_err(|_| CryptoError::State)?;
        if snapshot.version != 1 || snapshot.entries.len() > 100_000 || snapshot.pins.len() > 1000 {
            return Err(CryptoError::State);
        }
        snapshot.device.validate()?;
        let provider = OpenMlsRustCrypto::default();
        {
            let mut values = provider
                .storage()
                .values
                .write()
                .map_err(|_| CryptoError::State)?;
            for (key, mut value) in std::mem::take(&mut snapshot.entries) {
                let key = BASE64_STANDARD
                    .decode(key)
                    .map_err(|_| CryptoError::State)?;
                let decoded = BASE64_STANDARD
                    .decode(&value)
                    .map_err(|_| CryptoError::State)?;
                value.zeroize();
                if values.insert(key, decoded).is_some() {
                    return Err(CryptoError::State);
                }
            }
        }
        let public = BASE64_STANDARD
            .decode(&snapshot.device.signature_key)
            .map_err(|_| CryptoError::State)?;
        let signer = SignatureKeyPair::read(provider.storage(), &public, SignatureScheme::ED25519)
            .ok_or(CryptoError::State)?;
        let mut client = Self {
            provider,
            signer,
            device: snapshot.device.clone(),
            pins: BTreeMap::new(),
            pending_commits: std::mem::take(&mut snapshot.pending_commits),
            allowed_devices: BTreeMap::new(),
        };
        for pin in std::mem::take(&mut snapshot.pins) {
            client.pin_device(pin)?;
        }
        for (conversation, devices) in std::mem::take(&mut snapshot.allowed_devices) {
            client
                .authorize_conversation(&conversation, &devices.into_iter().collect::<Vec<_>>())?;
        }
        if client.pins.get(&client.device.device_id) != Some(&client.device) {
            return Err(CryptoError::State);
        }
        Ok(client)
    }
}

impl Drop for MlsClient {
    fn drop(&mut self) {
        if let Ok(mut values) = self.provider.storage().values.write() {
            for (_, mut value) in values.drain() {
                value.zeroize();
            }
        }
    }
}
