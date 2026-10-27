//! Client-side cryptography shared by browser WASM and native applications.
//! No network, filesystem, server master key, or application logging is used here.

pub mod engine;
pub mod envelope;
pub mod mls;
pub mod pairing;
pub mod recovery;
pub mod trust;

#[cfg(all(feature = "native-vault", not(target_arch = "wasm32")))]
pub mod native_vault;

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
mod wasm;

#[derive(thiserror::Error, Debug)]
pub enum CryptoError {
    #[error("Invalid cryptographic input")]
    InvalidInput,
    #[error("The authenticated encrypted object could not be opened")]
    Authentication,
    #[error("MLS rejected this operation")]
    Mls,
    #[error("MLS_WELCOME_TREE_MISSING")]
    WelcomeTreeMissing,
    #[error("The device identity is not pinned for this conversation")]
    UntrustedDevice,
    #[error("Local cryptographic state is unavailable")]
    State,
}

pub(crate) fn uuid_bytes(value: &str) -> Result<[u8; 16], CryptoError> {
    Ok(*uuid::Uuid::parse_str(value)
        .map_err(|_| CryptoError::InvalidInput)?
        .as_bytes())
}

#[cfg(test)]
mod regression_tests;
