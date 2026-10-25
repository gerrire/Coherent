//! Local cryptography is kept in Rust. The WebView receives decrypted UI
//! content, public bindings and opaque network packets, never MLS snapshots.
use crate::network::NetworkState;
use serde_json::Value;
use std::sync::Arc;
use tauri::State;
use tauri::{AppHandle, WebviewWindow};

#[tauri::command]
pub async fn desktop_crypto_request(
    app: AppHandle,
    window: WebviewWindow,
    account_id: String,
    request: Value,
) -> Result<Value, String> {
    if window.label() != "main"
        || !window
            .url()
            .is_ok_and(|url| crate::permissions::trusted_url(&url))
    {
        return Err("Доступ к защищённому хранилищу запрещён".into());
    }
    #[cfg(all(
        feature = "mls-preview",
        any(target_os = "windows", target_os = "macos", target_os = "linux")
    ))]
    {
        use coherent_crypto::native_vault::{NativeVault, SystemKeyStore};
        // Keep isolated local profiles and production out of each other's vault.
        let directory = crate::diagnostics::config_directory(&app)?.join("e2ee-v1");
        let service = format!("com.coherent.e2ee.v1.{}", directory.to_string_lossy());
        tauri::async_runtime::spawn_blocking(move || {
            let store = SystemKeyStore { service };
            let vault = NativeVault::new(directory, store)
                .map_err(|_| "Защищённое хранилище ОС недоступно".to_string())?;
            vault
                .request(&account_id, &request.to_string())
                .map_err(|_| {
                    "Не удалось выполнить действие с защищённой перепиской. Данные не отправлены."
                        .to_string()
                })
        })
        .await
        .map_err(|_| "Защищённое хранилище недоступно".to_string())?
    }
    #[cfg(not(all(
        feature = "mls-preview",
        any(target_os = "windows", target_os = "macos", target_os = "linux")
    )))]
    {
        let _ = (app, account_id, request);
        Err("Новая защищённая переписка ещё не включена в этой версии клиента".into())
    }
}

#[tauri::command]
pub async fn desktop_crypto_reveal(
    app: AppHandle,
    window: WebviewWindow,
    network: State<'_, Arc<NetworkState>>,
    account_id: String,
    current_password: String,
) -> Result<Value, String> {
    if window.label() != "main"
        || !window
            .url()
            .is_ok_and(|url| crate::permissions::trusted_url(&url))
    {
        return Err("Доступ запрещён".into());
    }
    #[cfg(all(
        feature = "mls-preview",
        any(target_os = "windows", target_os = "macos", target_os = "linux")
    ))]
    {
        use coherent_crypto::native_vault::{NativeVault, SystemKeyStore};
        use serde_json::json;
        let directory = crate::diagnostics::config_directory(&app)?.join("e2ee-v1");
        let service = format!("com.coherent.e2ee.v1.{}", directory.to_string_lossy());
        let challenge = network
            .crypto_post(
                "/api/v1/security/challenges",
                json!({"purpose":"recovery_view"}),
            )
            .await?;
        let nonce = challenge
            .get("nonce")
            .and_then(Value::as_str)
            .ok_or("Неверный ответ сервера")?
            .to_string();
        let directory_sign = directory.clone();
        let service_sign = service.clone();
        let account_sign = account_id.clone();
        let signed = tauri::async_runtime::spawn_blocking(move || {
            let vault = NativeVault::new(directory_sign, SystemKeyStore { service: service_sign }).map_err(|_| "Хранилище ОС недоступно".to_string())?;
            vault.request(&account_sign, &json!({"type":"execute","command":{"operation":"sign_device_proof","purpose":"recovery_view","nonce":nonce,"backup":null}}).to_string()).map_err(|_| "Ключ устройства недоступен".to_string())
        }).await.map_err(|_| "Хранилище недоступно".to_string())??;
        let device_id = signed["result"]["device"]["device_id"]
            .as_str()
            .ok_or("Ключ устройства недоступен")?
            .to_string();
        let authorization = network.crypto_post("/api/v1/security/recovery/authorize", json!({"challenge_id":challenge["challenge_id"],"device_id":device_id,"proof":signed["result"]["proof"],"current_password":current_password})).await?;
        if authorization["authorized"] != true
            || authorization["account_id"] != account_id
            || authorization["device_id"] != device_id
        {
            return Err("Это устройство не подтверждено".into());
        }
        tauri::async_runtime::spawn_blocking(move || {
            let vault = NativeVault::new(directory, SystemKeyStore { service })
                .map_err(|_| "Хранилище ОС недоступно".to_string())?;
            vault
                .reveal_recovery(&account_id)
                .map_err(|_| "Ключ восстановления недоступен".to_string())
        })
        .await
        .map_err(|_| "Хранилище недоступно".to_string())?
    }
    #[cfg(not(all(
        feature = "mls-preview",
        any(target_os = "windows", target_os = "macos", target_os = "linux")
    )))]
    {
        let _ = (app, network, account_id, current_password);
        Err("Обнови приложение для доступа к защищённому хранилищу".into())
    }
}
