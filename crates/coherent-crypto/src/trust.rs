//! Signed account rosters. A server response is never an authentication decision.
//! First contact needs an explicit fingerprint pin; later changes form a signed chain.
use crate::{CryptoError, mls::DeviceBinding, recovery, uuid_bytes};
use base64::{Engine as _, prelude::BASE64_STANDARD as B64};
use ed25519_dalek::{Signature, Signer, Verifier, VerifyingKey};
use hkdf::Hkdf;
use hpke_rs::{
    Hpke, HpkeKeyPair, Mode,
    hpke_types::{AeadAlgorithm, KdfAlgorithm, KemAlgorithm},
    rustcrypto::HpkeRustCrypto,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use zeroize::Zeroizing;

pub const ROSTER_DOMAIN: &[u8] = b"coherent/account-roster/v1\0";
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedRoster {
    pub payload: String,
    pub signature: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountRoster {
    pub version: u8,
    pub account_id: String,
    pub revision: u64,
    pub previous_hash: String,
    pub archive_public_key: String,
    pub devices: Vec<DeviceBinding>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct TrustStore {
    pub accounts: BTreeMap<String, AccountPin>,
    #[serde(default)]
    pub anchors: BTreeMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct AccountPin {
    pub public_key: String,
    pub roster: SignedRoster,
}

pub fn decode(value: &str, size: usize) -> Result<Vec<u8>, CryptoError> {
    let bytes = B64.decode(value).map_err(|_| CryptoError::InvalidInput)?;
    if bytes.len() != size || B64.encode(&bytes) != value {
        return Err(CryptoError::InvalidInput);
    }
    Ok(bytes)
}
pub fn hash(value: &[u8]) -> String {
    B64.encode(Sha256::digest(value))
}
pub fn roster_hash(roster: &SignedRoster) -> String {
    let mut bytes = ROSTER_DOMAIN.to_vec();
    bytes.extend_from_slice(roster.payload.as_bytes());
    bytes.extend_from_slice(roster.signature.as_bytes());
    hash(&bytes)
}
pub fn fingerprint(account: &str, public: &str) -> Result<String, CryptoError> {
    let mut bytes = b"coherent/account-fingerprint/v1\0".to_vec();
    bytes.extend_from_slice(&uuid_bytes(account)?);
    bytes.extend_from_slice(&decode(public, 32)?);
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
pub fn verify(public: &str, bytes: &[u8], signature: &str) -> Result<(), CryptoError> {
    let key: [u8; 32] = decode(public, 32)?
        .try_into()
        .map_err(|_| CryptoError::InvalidInput)?;
    let sig =
        Signature::from_slice(&decode(signature, 64)?).map_err(|_| CryptoError::Authentication)?;
    VerifyingKey::from_bytes(&key)
        .map_err(|_| CryptoError::Authentication)?
        .verify(bytes, &sig)
        .map_err(|_| CryptoError::Authentication)
}
pub fn verify_roster(public: &str, signed: &SignedRoster) -> Result<AccountRoster, CryptoError> {
    if signed.payload.len() > 32 * 1024 {
        return Err(CryptoError::InvalidInput);
    }
    let mut bytes = ROSTER_DOMAIN.to_vec();
    bytes.extend_from_slice(signed.payload.as_bytes());
    verify(public, &bytes, &signed.signature)?;
    let roster: AccountRoster =
        serde_json::from_str(&signed.payload).map_err(|_| CryptoError::InvalidInput)?;
    uuid_bytes(&roster.account_id)?;
    decode(&roster.previous_hash, 32)?;
    decode(&roster.archive_public_key, 32)?;
    if roster.version != 1
        || roster.revision == 0
        || roster.devices.is_empty()
        || roster.devices.len() > 16
    {
        return Err(CryptoError::InvalidInput);
    }
    let mut ids = BTreeSet::new();
    let mut keys = BTreeSet::new();
    for d in &roster.devices {
        d.validate()?;
        if d.account_id != roster.account_id
            || !ids.insert(&d.device_id)
            || !keys.insert(&d.signature_key)
        {
            return Err(CryptoError::Authentication);
        }
    }
    Ok(roster)
}
pub fn hpke() -> Hpke<HpkeRustCrypto> {
    Hpke::new(
        Mode::Base,
        KemAlgorithm::DhKem25519,
        KdfAlgorithm::HkdfSha256,
        AeadAlgorithm::Aes256Gcm,
    )
}
pub fn archive_pair(account: &str, key: &[u8; 32]) -> Result<HpkeKeyPair, CryptoError> {
    let mut seed = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(&uuid_bytes(account)?), key)
        .expand(b"coherent/history-hpke/v1", seed.as_mut())
        .map_err(|_| CryptoError::State)?;
    hpke()
        .derive_key_pair(seed.as_ref())
        .map_err(|_| CryptoError::State)
}
impl TrustStore {
    pub fn accept(
        &mut self,
        public: &str,
        signed: SignedRoster,
        expected_fingerprint: Option<&str>,
    ) -> Result<AccountRoster, CryptoError> {
        let roster = verify_roster(public, &signed)?;
        if self
            .anchors
            .get(&roster.account_id)
            .is_some_and(|old| old != public)
        {
            return Err(CryptoError::UntrustedDevice);
        }
        if let Some(pin) = self.accounts.get(&roster.account_id) {
            if pin.public_key != public {
                return Err(CryptoError::UntrustedDevice);
            }
            let previous = verify_roster(public, &pin.roster)?;
            if roster.revision == previous.revision {
                if roster_hash(&signed) != roster_hash(&pin.roster) {
                    return Err(CryptoError::UntrustedDevice);
                }
                return Ok(roster);
            }
            if roster.revision != previous.revision + 1
                || roster.previous_hash != roster_hash(&pin.roster)
            {
                return Err(CryptoError::UntrustedDevice);
            }
            // This release supports additions only. Removal requires archive and recovery rotation.
            for old in previous.devices {
                if !roster.devices.contains(&old) {
                    return Err(CryptoError::UntrustedDevice);
                }
            }
            if roster.archive_public_key != previous.archive_public_key {
                return Err(CryptoError::UntrustedDevice);
            }
        } else if self.anchors.get(&roster.account_id).map(String::as_str) != Some(public)
            && expected_fingerprint != Some(fingerprint(&roster.account_id, public)?.as_str())
        {
            return Err(CryptoError::UntrustedDevice);
        }
        if self.accounts.len() >= 1000 && !self.accounts.contains_key(&roster.account_id) {
            return Err(CryptoError::State);
        }
        self.anchors
            .insert(roster.account_id.clone(), public.into());
        self.accounts.insert(
            roster.account_id.clone(),
            AccountPin {
                public_key: public.into(),
                roster: signed,
            },
        );
        Ok(roster)
    }
    pub fn own_roster(
        &mut self,
        device: &DeviceBinding,
        phrase: &str,
        archive_key: &[u8; 32],
        previous: Option<SignedRoster>,
    ) -> Result<SignedRoster, CryptoError> {
        let signer = recovery::authorization_signer(&device.account_id, phrase)?;
        let public = B64.encode(signer.verifying_key().to_bytes());
        let own_fingerprint = fingerprint(&device.account_id, &public)?;
        let archive_public_key = B64.encode(
            archive_pair(&device.account_id, archive_key)?
                .public_key()
                .as_slice(),
        );
        let mut roster = if let Some(previous) = previous {
            let r = self.accept(&public, previous.clone(), Some(&own_fingerprint))?;
            if r.archive_public_key != archive_public_key {
                return Err(CryptoError::Authentication);
            }
            if r.devices.contains(device) {
                return Ok(previous);
            }
            AccountRoster {
                revision: r.revision + 1,
                previous_hash: roster_hash(&previous),
                ..r
            }
        } else {
            if self.accounts.contains_key(&device.account_id) {
                return Err(CryptoError::UntrustedDevice);
            }
            AccountRoster {
                version: 1,
                account_id: device.account_id.clone(),
                revision: 1,
                previous_hash: B64.encode([0u8; 32]),
                archive_public_key,
                devices: Vec::new(),
            }
        };
        roster.devices.push(device.clone());
        roster.devices.sort_by(|a, b| a.device_id.cmp(&b.device_id));
        if roster.devices.len() > 16 {
            return Err(CryptoError::InvalidInput);
        }
        let payload = serde_json::to_string(&roster).map_err(|_| CryptoError::State)?;
        let mut bytes = ROSTER_DOMAIN.to_vec();
        bytes.extend_from_slice(payload.as_bytes());
        // Do not pin this pending change until the server has committed its exact bytes.
        Ok(SignedRoster {
            payload,
            signature: B64.encode(signer.sign(&bytes).to_bytes()),
        })
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContactPin {
    pub account_id: String,
    pub public_key: String,
    pub proof: String,
}
pub fn contact_bytes(owner: &str, peer: &str, public: &str) -> Result<Vec<u8>, CryptoError> {
    let mut bytes = b"coherent/contact-pin/v1\0".to_vec();
    bytes.extend_from_slice(&uuid_bytes(owner)?);
    bytes.extend_from_slice(&uuid_bytes(peer)?);
    bytes.extend_from_slice(&decode(public, 32)?);
    Ok(bytes)
}
