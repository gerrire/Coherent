//! Per-call volatile Rust engines. Private device state never leaves this module.
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
};
use tauri::{State, WebviewWindow};

#[derive(Default)]
pub struct CallCryptoState {
    #[cfg(feature = "mls-preview")]
    clients: Mutex<HashMap<String, coherent_crypto::ephemeral_call::EphemeralCall>>,
    retired: Mutex<VecDeque<String>>,
}

impl CallCryptoState {
    pub fn clear(&self) {
        #[cfg(feature = "mls-preview")]
        if let (Ok(mut retired), Ok(mut clients)) = (self.retired.lock(), self.clients.lock()) {
            retired.extend(clients.keys().cloned());
            clients.clear();
            while retired.len() > 256 {
                retired.pop_front();
            }
        }
    }
}

fn scope(
    window: &WebviewWindow,
    account: &str,
    call: &str,
    client: &str,
) -> Result<String, String> {
    if window.label() != "main"
        || !window
            .url()
            .is_ok_and(|url| crate::permissions::trusted_url(&url))
        || [account, call, client]
            .iter()
            .any(|s| s.len() != 36 || !s.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-'))
    {
        return Err("Доступ к ключу звонка запрещён".into());
    }
    Ok(format!("{account}:{call}:{client}"))
}

#[tauri::command]
pub fn desktop_call_crypto_request(
    window: WebviewWindow,
    state: State<'_, CallCryptoState>,
    account_id: String,
    call_id: String,
    client_id: String,
    request: Value,
) -> Result<Value, String> {
    let key = scope(&window, &account_id, &call_id, &client_id)?;
    #[cfg(feature = "mls-preview")]
    {
        let retired = state.retired.lock().map_err(|_| "Ключ звонка недоступен")?;
        if retired.contains(&key) {
            return Err("Звонок уже закрыт".into());
        }
        let mut clients = state.clients.lock().map_err(|_| "Ключ звонка недоступен")?;

        if !clients.contains_key(&key) {
            if clients.len() >= 4 {
                return Err("Слишком много активных ключей звонков".into());
            }
            let client = coherent_crypto::ephemeral_call::EphemeralCall::new(&account_id, &call_id)
                .map_err(|e| e.to_string())?;
            clients.insert(key.clone(), client);
        }
        let client = clients.get_mut(&key).ok_or("Ключ звонка недоступен")?;
        client
            .request(&request.to_string())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(feature = "mls-preview"))]
    {
        let _ = (state, key, request);
        Err("Обнови приложение для защищённых звонков".into())
    }
}

#[tauri::command]
pub fn desktop_call_crypto_close(
    window: WebviewWindow,
    state: State<'_, CallCryptoState>,
    account_id: String,
    call_id: String,
    client_id: String,
) -> Result<(), String> {
    let key = scope(&window, &account_id, &call_id, &client_id)?;
    #[cfg(feature = "mls-preview")]
    {
        let mut retired = state.retired.lock().map_err(|_| "Ключ звонка недоступен")?;
        retired.push_back(key.clone());
        while retired.len() > 256 {
            retired.pop_front();
        }
        state
            .clients
            .lock()
            .map_err(|_| "Ключ звонка недоступен")?
            .remove(&key);
    }
    Ok(())
}
