use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use base64::{Engine, prelude::BASE64_STANDARD};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::CryptoError;

/// Standard authenticated envelope. Key derivation/purpose binding is performed
/// by the caller; callers must never reuse one domain for unrelated objects.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub version: u8,
    pub nonce: String,
    pub ciphertext: String,
}

pub fn random_key() -> Zeroizing<[u8; 32]> {
    let mut key = Zeroizing::new([0; 32]);
    OsRng.fill_bytes(key.as_mut());
    key
}

pub fn seal(key: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> Result<Envelope, CryptoError> {
    if plaintext.len() > 64 * 1024 * 1024 {
        return Err(CryptoError::InvalidInput);
    }
    let mut nonce = [0; 12];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = Aes256Gcm::new_from_slice(key)
        .map_err(|_| CryptoError::InvalidInput)?
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Authentication)?;
    Ok(Envelope {
        version: 1,
        nonce: BASE64_STANDARD.encode(nonce),
        ciphertext: BASE64_STANDARD.encode(ciphertext),
    })
}

pub fn open(
    key: &[u8; 32],
    envelope: &Envelope,
    aad: &[u8],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if envelope.version != 1 || envelope.ciphertext.len() > 90 * 1024 * 1024 {
        return Err(CryptoError::InvalidInput);
    }
    let nonce = BASE64_STANDARD
        .decode(&envelope.nonce)
        .map_err(|_| CryptoError::InvalidInput)?;
    if nonce.len() != 12 {
        return Err(CryptoError::InvalidInput);
    }
    let ciphertext = BASE64_STANDARD
        .decode(&envelope.ciphertext)
        .map_err(|_| CryptoError::InvalidInput)?;
    let plaintext = Aes256Gcm::new_from_slice(key)
        .map_err(|_| CryptoError::InvalidInput)?
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Authentication)?;
    Ok(Zeroizing::new(plaintext))
}
