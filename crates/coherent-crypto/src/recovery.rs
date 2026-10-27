use bip39::{Language, Mnemonic};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::{
    CryptoError,
    envelope::{Envelope, open, random_key, seal},
    uuid_bytes,
};

const RECOVERY_DOMAIN: &[u8] = b"coherent/recovery/archive/v1";

pub fn authorization_public(account_id: &str, phrase: &str) -> Result<[u8; 32], CryptoError> {
    Ok(authorization_signer(account_id, phrase)?
        .verifying_key()
        .to_bytes())
}

pub(crate) fn authorization_signer(
    account_id: &str,
    phrase: &str,
) -> Result<ed25519_dalek::SigningKey, CryptoError> {
    let account = uuid_bytes(account_id)?;
    let mnemonic =
        Mnemonic::parse_in(Language::English, phrase).map_err(|_| CryptoError::InvalidInput)?;
    if !matches!(mnemonic.word_count(), 12 | 24) {
        return Err(CryptoError::InvalidInput);
    }
    let entropy = Zeroizing::new(mnemonic.to_entropy());
    let mut seed = Zeroizing::new([0; 32]);
    Hkdf::<Sha256>::new(Some(&account), entropy.as_ref())
        .expand(b"coherent/recovery/authorization/v1", seed.as_mut())
        .map_err(|_| CryptoError::InvalidInput)?;
    Ok(ed25519_dalek::SigningKey::from_bytes(&seed))
}

/// Generated locally. Never send the phrase to an API or an email provider.
pub fn generate_phrase() -> Result<Zeroizing<String>, CryptoError> {
    let entropy = random_key();
    let phrase = Mnemonic::from_entropy_in(Language::English, &entropy[..16])
        .map_err(|_| CryptoError::InvalidInput)?;
    Ok(Zeroizing::new(phrase.to_string()))
}

fn wrapping_key(account_id: &str, phrase: &str) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let account = uuid_bytes(account_id)?;
    let mnemonic =
        Mnemonic::parse_in(Language::English, phrase).map_err(|_| CryptoError::InvalidInput)?;
    // New keys contain 128 random bits (12 words). Existing 24-word backups
    // remain readable; shortening an already-issued key would change it.
    if !matches!(mnemonic.word_count(), 12 | 24) {
        return Err(CryptoError::InvalidInput);
    }
    let entropy = Zeroizing::new(mnemonic.to_entropy());
    let mut key = Zeroizing::new([0; 32]);
    Hkdf::<Sha256>::new(Some(&account), entropy.as_ref())
        .expand(RECOVERY_DOMAIN, key.as_mut())
        .map_err(|_| CryptoError::InvalidInput)?;
    Ok(key)
}

fn backup_aad(account_id: &str) -> Result<Vec<u8>, CryptoError> {
    let mut aad = RECOVERY_DOMAIN.to_vec();
    aad.extend_from_slice(&uuid_bytes(account_id)?);
    Ok(aad)
}

/// Wrap archive unlock material. CryptoEngine never passes live device keys or
/// MLS ratchet state to this function; platform adapters must preserve that rule.
pub fn protect_archive_key(
    account_id: &str,
    phrase: &str,
    archive_key: &[u8; 32],
) -> Result<Envelope, CryptoError> {
    let key = wrapping_key(account_id, phrase)?;
    seal(&key, archive_key, &backup_aad(account_id)?)
}

pub fn recover_archive_key(
    account_id: &str,
    phrase: &str,
    backup: &Envelope,
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let key = wrapping_key(account_id, phrase)?;
    let bytes = open(&key, backup, &backup_aad(account_id)?)?;
    let key: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| CryptoError::InvalidInput)?;
    Ok(Zeroizing::new(key))
}

/// Versioned recovery material retains historical archive roots when trust is reset.
/// It never contains MLS ratchets or device signing secrets.
pub fn protect_archive_keys(
    account_id: &str,
    phrase: &str,
    keys: &[[u8; 32]],
) -> Result<Envelope, CryptoError> {
    use base64::{Engine as _, prelude::BASE64_STANDARD as B64};
    if keys.is_empty() || keys.len() > 128 {
        return Err(CryptoError::InvalidInput);
    }
    let plain = Zeroizing::new(serde_json::to_vec(&serde_json::json!({"version":2,"keys":keys.iter().map(|key|B64.encode(key)).collect::<Vec<_>>()})).map_err(|_|CryptoError::State)?);
    seal(
        &*wrapping_key(account_id, phrase)?,
        &plain,
        &backup_aad(account_id)?,
    )
}

pub fn recover_archive_keys(
    account_id: &str,
    phrase: &str,
    backup: &Envelope,
) -> Result<Vec<Zeroizing<[u8; 32]>>, CryptoError> {
    use base64::{Engine as _, prelude::BASE64_STANDARD as B64};
    let plain = open(
        &*wrapping_key(account_id, phrase)?,
        backup,
        &backup_aad(account_id)?,
    )?;
    if plain.len() == 32 {
        return Ok(vec![Zeroizing::new(
            plain
                .as_slice()
                .try_into()
                .map_err(|_| CryptoError::InvalidInput)?,
        )]);
    }
    if plain.len() > 16384 {
        return Err(CryptoError::InvalidInput);
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Bundle {
        version: u8,
        keys: Vec<String>,
    }
    let mut bundle: Bundle =
        serde_json::from_slice(&plain).map_err(|_| CryptoError::InvalidInput)?;
    if bundle.version != 2 || bundle.keys.is_empty() || bundle.keys.len() > 128 {
        return Err(CryptoError::InvalidInput);
    }
    let result = bundle
        .keys
        .iter()
        .map(|wire| {
            let bytes = Zeroizing::new(B64.decode(wire).map_err(|_| CryptoError::InvalidInput)?);
            Ok(Zeroizing::new(
                bytes
                    .as_slice()
                    .try_into()
                    .map_err(|_| CryptoError::InvalidInput)?,
            ))
        })
        .collect();
    for key in &mut bundle.keys {
        zeroize::Zeroize::zeroize(key);
    }
    result
}
