//! Device pairing over OPAQUE RFC 9807. The new device hosts the PAKE endpoint;
//! the application server only relays opaque packets. A six-digit secret is
//! copied by the user to an already trusted device, never sent to the server.
use crate::{
    CryptoError,
    envelope::{self, Envelope},
    mls::DeviceBinding,
    uuid_bytes,
};
use base64::{Engine as _, prelude::BASE64_STANDARD as B64};
use hkdf::Hkdf;
use opaque_ke::{
    CipherSuite, ClientLogin, ClientLoginFinishParameters, ClientRegistration,
    ClientRegistrationFinishParameters, CredentialFinalization, CredentialRequest,
    CredentialResponse, ServerLogin, ServerLoginParameters, ServerRegistration, ServerSetup,
};
use rand::{Rng, rngs::OsRng};
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Sha512};
use zeroize::{Zeroize, Zeroizing};
struct Suite;
impl CipherSuite for Suite {
    type OprfCs = opaque_ke::Ristretto255;
    type KeyExchange = opaque_ke::TripleDh<opaque_ke::Ristretto255, Sha512>;
    type Ksf = opaque_ke::argon2::Argon2<'static>;
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pairing {
    pub new_device: DeviceBinding,
    pub old_device: Option<DeviceBinding>,
    role: String,
    code: String,
    setup: Vec<u8>,
    record: Vec<u8>,
    state: Vec<u8>,
    responded: bool,
    request_hash: String,
    response: String,
    delivery: Option<(String, Envelope)>,
}
impl Drop for Pairing {
    fn drop(&mut self) {
        self.code.zeroize();
        self.setup.zeroize();
        self.record.zeroize();
        self.state.zeroize();
    }
}
fn decode(value: &str) -> Result<Vec<u8>, CryptoError> {
    if value.len() > 16384 {
        return Err(CryptoError::InvalidInput);
    }
    B64.decode(value).map_err(|_| CryptoError::InvalidInput)
}
fn context(id: &str, new: &DeviceBinding, old: &DeviceBinding) -> Result<Vec<u8>, CryptoError> {
    uuid_bytes(id)?;
    if new.account_id != old.account_id || new.device_id == old.device_id {
        return Err(CryptoError::InvalidInput);
    }
    serde_json::to_vec(&("coherent/device-pairing/opaque/v1", id, new, old))
        .map_err(|_| CryptoError::State)
}
fn key(secret: &[u8], context: &[u8]) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let mut key = Zeroizing::new([0; 32]);
    Hkdf::<Sha256>::new(Some(context), secret)
        .expand(b"coherent/device-transfer/v1", key.as_mut())
        .map_err(|_| CryptoError::State)?;
    Ok(key)
}
impl Pairing {
    pub fn is_new(&self) -> bool {
        self.role == "new"
    }
    pub fn code(&self) -> &str {
        if self.is_new() { &self.code } else { "" }
    }
    pub fn new_device(id: &str, new_device: DeviceBinding) -> Result<(Self, String), CryptoError> {
        uuid_bytes(id)?;
        let mut rng = OsRng;
        let code = format!("{:06}", rng.gen_range(0..1_000_000u32));
        let setup = ServerSetup::<Suite>::new(&mut rng);
        let registration = ClientRegistration::<Suite>::start(&mut rng, code.as_bytes())
            .map_err(|_| CryptoError::State)?;
        let response = ServerRegistration::start(&setup, registration.message, id.as_bytes())
            .map_err(|_| CryptoError::State)?;
        let upload = registration
            .state
            .finish(
                &mut rng,
                code.as_bytes(),
                response.message,
                ClientRegistrationFinishParameters::default(),
            )
            .map_err(|_| CryptoError::State)?;
        let record = ServerRegistration::<Suite>::finish(upload.message);
        Ok((
            Self {
                new_device,
                old_device: None,
                role: "new".into(),
                code: code.clone(),
                setup: setup.serialize().to_vec(),
                record: record.serialize().to_vec(),
                state: vec![],
                responded: false,
                request_hash: String::new(),
                response: String::new(),
                delivery: None,
            },
            code,
        ))
    }
    pub fn old_device(
        id: &str,
        new_device: DeviceBinding,
        old_device: DeviceBinding,
        code: String,
    ) -> Result<(Self, String), CryptoError> {
        context(id, &new_device, &old_device)?;
        if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
            return Err(CryptoError::InvalidInput);
        }
        let started = ClientLogin::<Suite>::start(&mut OsRng, code.as_bytes())
            .map_err(|_| CryptoError::State)?;
        let packet = B64.encode(started.message.serialize());
        Ok((
            Self {
                new_device,
                old_device: Some(old_device),
                role: "old".into(),
                code,
                setup: vec![],
                record: vec![],
                state: started.state.serialize().to_vec(),
                responded: false,
                request_hash: String::new(),
                response: String::new(),
                delivery: None,
            },
            packet,
        ))
    }
    pub fn respond(
        &mut self,
        id: &str,
        old: DeviceBinding,
        request: &str,
    ) -> Result<String, CryptoError> {
        if self.role != "new" {
            return Err(CryptoError::State);
        }
        use sha2::Digest;
        let hash = B64.encode(Sha256::digest(request.as_bytes()));
        if self.responded {
            if self.old_device.as_ref() == Some(&old) && self.request_hash == hash {
                return Ok(self.response.clone());
            }
            return Err(CryptoError::Authentication);
        }
        let ctx = context(id, &self.new_device, &old)?;
        let setup =
            ServerSetup::<Suite>::deserialize(&self.setup).map_err(|_| CryptoError::State)?;
        let record = ServerRegistration::<Suite>::deserialize(&self.record)
            .map_err(|_| CryptoError::State)?;
        let request = CredentialRequest::deserialize(&decode(request)?)
            .map_err(|_| CryptoError::InvalidInput)?;
        let result = ServerLogin::start(
            &mut OsRng,
            &setup,
            Some(record),
            request,
            id.as_bytes(),
            ServerLoginParameters {
                context: Some(&ctx),
                ..Default::default()
            },
        )
        .map_err(|_| CryptoError::Authentication)?;
        self.old_device = Some(old);
        self.state = result.state.serialize().to_vec();
        self.responded = true;
        self.code.zeroize();
        self.setup.zeroize();
        self.record.zeroize();
        self.request_hash = hash;
        self.response = B64.encode(result.message.serialize());
        Ok(self.response.clone())
    }
    pub fn seal(
        &mut self,
        id: &str,
        response: &str,
        plaintext: &[u8],
    ) -> Result<(String, Envelope), CryptoError> {
        if self.role != "old" {
            return Err(CryptoError::State);
        }
        if let Some(delivery) = &self.delivery {
            return Ok(delivery.clone());
        }
        if self.responded {
            return Err(CryptoError::Authentication);
        }
        // Burn the one PAKE attempt even when authentication fails. The engine
        // persists a rejected result rather than rolling this state back.
        self.responded = true;
        let ctx = context(
            id,
            &self.new_device,
            self.old_device.as_ref().ok_or(CryptoError::State)?,
        )?;
        let state =
            ClientLogin::<Suite>::deserialize(&self.state).map_err(|_| CryptoError::State)?;
        let response = CredentialResponse::deserialize(&decode(response)?)
            .map_err(|_| CryptoError::InvalidInput)?;
        let result = state
            .finish(
                &mut OsRng,
                self.code.as_bytes(),
                response,
                ClientLoginFinishParameters {
                    context: Some(&ctx),
                    ..Default::default()
                },
            )
            .map_err(|_| CryptoError::Authentication)?;
        let envelope = envelope::seal(&*key(&result.session_key, &ctx)?, plaintext, &ctx)?;
        self.responded = true;
        self.code.zeroize();
        self.state.zeroize();
        let result = (B64.encode(result.message.serialize()), envelope);
        self.delivery = Some(result.clone());
        Ok(result)
    }
    pub fn open(
        &self,
        id: &str,
        finalization: &str,
        envelope: &Envelope,
    ) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
        if self.role != "new" || !self.responded {
            return Err(CryptoError::State);
        }
        let ctx = context(
            id,
            &self.new_device,
            self.old_device.as_ref().ok_or(CryptoError::State)?,
        )?;
        let state =
            ServerLogin::<Suite>::deserialize(&self.state).map_err(|_| CryptoError::State)?;
        let message = CredentialFinalization::deserialize(&decode(finalization)?)
            .map_err(|_| CryptoError::InvalidInput)?;
        let result = state
            .finish(
                message,
                ServerLoginParameters {
                    context: Some(&ctx),
                    ..Default::default()
                },
            )
            .map_err(|_| CryptoError::Authentication)?;
        envelope::open(&*key(&result.session_key, &ctx)?, envelope, &ctx)
    }
}
