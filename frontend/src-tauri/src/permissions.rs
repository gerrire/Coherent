use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{State, WebviewWindow};

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
pub struct MediaPermissions {
    pub microphone: bool,
    pub camera: bool,
}

pub struct PermissionState {
    value: Mutex<MediaPermissions>,
    file: std::path::PathBuf,
}

impl PermissionState {
    pub fn new(app: &tauri::AppHandle) -> Result<Self, String> {
        let file = crate::diagnostics::config_directory(app)?.join("media-permissions.json");
        let value = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Ok(Self {
            value: Mutex::new(value),
            file,
        })
    }
    pub fn allowed(&self, kind: tauri::webview::PermissionKind) -> bool {
        let Ok(value) = self.value.lock() else {
            return false;
        };
        match kind {
            tauri::webview::PermissionKind::Microphone => value.microphone,
            tauri::webview::PermissionKind::Camera => value.camera,
            _ => false,
        }
    }
}

pub fn trusted_url(url: &tauri::Url) -> bool {
    (url.scheme() == "http" && url.host_str() == Some("tauri.localhost") && url.port().is_none())
        || (cfg!(debug_assertions)
            && url.scheme() == "http"
            && url.host_str() == Some("localhost")
            && url.port() == Some(5173))
}

#[tauri::command]
pub fn desktop_media_permissions_get(
    state: State<'_, PermissionState>,
) -> Result<MediaPermissions, String> {
    state
        .value
        .lock()
        .map(|v| *v)
        .map_err(|_| "Настройки доступа недоступны".into())
}

#[tauri::command]
pub fn desktop_media_permissions_set(
    window: WebviewWindow,
    state: State<'_, PermissionState>,
    value: MediaPermissions,
) -> Result<(), String> {
    if window.label() != "main" || !window.url().is_ok_and(|u| trusted_url(&u)) {
        return Err("Недоступно для этого окна".into());
    }
    let mut current = state
        .value
        .lock()
        .map_err(|_| "Настройки доступа недоступны")?;
    std::fs::write(
        &state.file,
        serde_json::to_vec(&value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    *current = value;
    Ok(())
}
