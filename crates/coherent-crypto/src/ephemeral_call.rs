//! Volatile call-only MLS state. No snapshots, recovery material or disk access.
use serde::Deserialize;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::{
    CryptoError,
    engine::{Command, CryptoEngine},
    envelope, uuid_bytes,
};

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
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

pub struct EphemeralCall {
    engine: CryptoEngine,
    outbox: Vec<Value>,
    call_id: String,
}

fn permitted(command: &Command, call_id: &str) -> bool {
    match command {
        Command::Identity
        | Command::KeyPackage
        | Command::PinDevice { .. }
        | Command::AuthorizeConversation { .. }
        | Command::CreateGroup { .. }
        | Command::Members { .. }
        | Command::GroupStatus { .. }
        | Command::AddMembers { .. }
        | Command::RemoveMembers { .. }
        | Command::AcknowledgeCommit { .. }
        | Command::DiscardCommit { .. }
        | Command::Join { .. }
        | Command::StreamCursor { .. }
        | Command::RetireStream { .. }
        | Command::SignAction { .. }
        | Command::VerifyAction { .. } => true,
        Command::MediaKey { call_id: id, .. } => id == call_id,
        Command::Receive {
            message_id, body, ..
        } => message_id.is_none() && body.is_none(),
        Command::ApplyEvent { command, .. } => command
            .as_ref()
            .is_none_or(|inner| permitted(inner, call_id)),
        _ => false,
    }
}

impl EphemeralCall {
    pub fn new(account: &str, call_id: &str) -> Result<Self, CryptoError> {
        uuid_bytes(call_id)?;
        Ok(Self {
            engine: CryptoEngine::new(account, &random_uuid()?)?,
            outbox: Vec::new(),
            call_id: call_id.into(),
        })
    }

    pub fn request(&mut self, input: &str) -> Result<Value, CryptoError> {
        if input.len() > 3 * 1024 * 1024 {
            return Err(CryptoError::InvalidInput);
        }
        let request: Request =
            serde_json::from_str(input).map_err(|_| CryptoError::InvalidInput)?;
        if matches!(request, Request::Pending) {
            return Ok(json!(self.outbox));
        }
        let (command, delivered, transport) = match request {
            Request::Execute {
                command,
                delivered_id,
                transport,
            } => (Some(command), delivered_id, transport),
            Request::Delivered { delivery_id } => (None, Some(delivery_id), None),
            Request::Pending => unreachable!(),
        };
        if command
            .as_ref()
            .is_some_and(|c| !permitted(c, &self.call_id))
        {
            return Err(CryptoError::InvalidInput);
        }
        let mut index = None;
        if let Some(id) = &delivered {
            let position = self
                .outbox
                .iter()
                .position(|v| v["id"].as_str() == Some(id))
                .ok_or(CryptoError::State)?;
            let pending = &self.outbox[position];
            if matches!(
                pending["operation"].as_str(),
                Some("add_members" | "remove_members")
            ) {
                let inner = match command.as_ref() {
                    Some(Command::ApplyEvent {
                        command: Some(inner),
                        ..
                    }) => Some(inner.as_ref()),
                    other => other,
                };
                match inner {
                    Some(
                        Command::AcknowledgeCommit { commit, .. }
                        | Command::DiscardCommit { commit, .. },
                    ) if pending["payload"]["commit"].as_str() == Some(commit) => (),
                    _ => return Err(CryptoError::State),
                }
            }
            index = Some(position);
        }
        let mut reply = json!({"result":{},"delivery_id":null});
        if let Some(command) = command {
            if matches!(command, Command::AcknowledgeCommit { .. }) && delivered.is_none() {
                return Err(CryptoError::State);
            }
            let operation = match &command {
                Command::KeyPackage => "key_package",
                Command::AddMembers { .. } => "add_members",
                Command::RemoveMembers { .. } => "remove_members",
                _ => "",
            };
            if !operation.is_empty() && self.outbox.len() >= 100 {
                return Err(CryptoError::State);
            }
            let serialized = Zeroizing::new(
                serde_json::to_string(&command).map_err(|_| CryptoError::InvalidInput)?,
            );
            let result: Value = serde_json::from_str(&self.engine.execute_json(&serialized)?)
                .map_err(|_| CryptoError::State)?;
            let mut delivery_id = None;
            if !operation.is_empty() {
                let id = random_uuid()?;
                let mut payload = result.clone();
                if let Some(transport) = transport {
                    payload
                        .as_object_mut()
                        .ok_or(CryptoError::State)?
                        .insert("transport".into(), transport);
                }
                self.outbox
                    .push(json!({"id":id,"operation":operation,"payload":payload}));
                delivery_id = Some(id);
            }
            reply = json!({"result":result,"delivery_id":delivery_id});
        }
        if let Some(index) = index {
            self.outbox.remove(index);
        }
        Ok(reply)
    }
}

fn random_uuid() -> Result<String, CryptoError> {
    let key = envelope::random_key();
    let mut bytes: [u8; 16] = key[..16].try_into().map_err(|_| CryptoError::State)?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    Ok(uuid::Uuid::from_bytes(bytes).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    const A: &str = "11111111-1111-4111-8111-111111111111";
    const B: &str = "22222222-2222-4222-8222-222222222222";
    const CALL: &str = "33333333-3333-4333-8333-333333333333";
    const GROUP: &str = "44444444-4444-4444-8444-444444444444";
    fn execute(client: &mut EphemeralCall, command: Value) -> Value {
        client
            .request(&json!({"type":"execute","command":command}).to_string())
            .unwrap()
    }
    #[test]
    fn call_keys_are_shared_rotated_and_not_restored() {
        fn sendable<T: Send>() {}
        sendable::<EphemeralCall>();
        let mut a = EphemeralCall::new(A, CALL).unwrap();
        let mut b = EphemeralCall::new(B, CALL).unwrap();
        let ad = execute(&mut a, json!({"operation":"identity"}))["result"]["device"].clone();
        let bd = execute(&mut b, json!({"operation":"identity"}))["result"]["device"].clone();
        for client in [&mut a, &mut b] {
            execute(client, json!({"operation":"pin_device","device":ad}));
            execute(client, json!({"operation":"pin_device","device":bd}));
            execute(
                client,
                json!({"operation":"authorize_conversation","conversation_id":GROUP,"device_ids":[ad["device_id"],bd["device_id"]]}),
            );
        }
        execute(
            &mut a,
            json!({"operation":"create_group","conversation_id":GROUP}),
        );
        let package = execute(&mut b, json!({"operation":"key_package"}));
        let added = execute(
            &mut a,
            json!({"operation":"add_members","conversation_id":GROUP,"key_packages":[package["result"]["key_package"]]}),
        );
        a.request(&json!({"type":"execute","command":{"operation":"acknowledge_commit","conversation_id":GROUP,"commit":added["result"]["commit"]},"delivered_id":added["delivery_id"]}).to_string()).unwrap();
        execute(
            &mut b,
            json!({"operation":"join","conversation_id":GROUP,"welcome":added["result"]["welcome"]}),
        );
        let command = json!({"operation":"media_key","conversation_id":GROUP,"call_id":CALL});
        let first = execute(&mut a, command.clone())["result"]["key"].clone();
        assert_eq!(first, execute(&mut b, command.clone())["result"]["key"]);
        execute(
            &mut a,
            json!({"operation":"authorize_conversation","conversation_id":GROUP,"device_ids":[ad["device_id"]]}),
        );
        let removed = execute(
            &mut a,
            json!({"operation":"remove_members","conversation_id":GROUP,"device_ids":[bd["device_id"]]}),
        );
        a.request(&json!({"type":"execute","command":{"operation":"acknowledge_commit","conversation_id":GROUP,"commit":removed["result"]["commit"]},"delivered_id":removed["delivery_id"]}).to_string()).unwrap();
        assert_ne!(first, execute(&mut a, command)["result"]["key"]);
        drop(b);
        let mut fresh = EphemeralCall::new(B, CALL).unwrap();
        assert_ne!(
            bd["device_id"],
            execute(&mut fresh, json!({"operation":"identity"}))["result"]["device"]["device_id"]
        );
        assert!(
            fresh
                .request(r#"{"type":"execute","command":{"operation":"recovery_backup"}}"#)
                .is_err()
        );
    }
}
