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

/// Generated locally; the caller displays once and must not send it to an API.
pub fn generate_phrase() -> Result<Zeroizing<String>, CryptoError> {
    let entropy = random_key();
    let phrase = Mnemonic::from_entropy_in(Language::English, entropy.as_ref())
        .map_err(|_| CryptoError::InvalidInput)?;
    Ok(Zeroizing::new(phrase.to_string()))
}

fn wrapping_key(account_id: &str, phrase: &str) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let account = uuid_bytes(account_id)?;
    let mnemonic =
        Mnemonic::parse_in(Language::English, phrase).map_err(|_| CryptoError::InvalidInput)?;
    // This version accepts only 256-bit generated keys, not user passwords.
    if mnemonic.word_count() != 24 {
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
