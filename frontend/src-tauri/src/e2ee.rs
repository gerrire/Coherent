//! Local cryptography is kept in Rust. The WebView receives decrypted UI
//! content, public bindings and opaque network packets, never MLS snapshots.
use serde_json::Value;
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
