use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    Window,
};
use tauri_plugin_notification::NotificationExt;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    pub close_to_tray: bool,
    pub show_notifications: bool,
    #[serde(default = "enabled_by_default")]
    pub notification_sound: bool,
    pub raise_on_call: bool,
    pub close_to_tray_configured: Option<bool>,
    pub notifications_configured: Option<bool>,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            show_notifications: true,
            notification_sound: true,
            raise_on_call: true,
            close_to_tray_configured: Some(true),
            notifications_configured: Some(true),
        }
    }
}

fn enabled_by_default() -> bool {
    true
}

pub struct DesktopState {
    close_to_tray: AtomicBool,
    media_active: AtomicBool,
    incoming_call_id: Mutex<Option<String>>,
    file: PathBuf,
    overlay_operation: tokio::sync::Mutex<()>,
}

impl DesktopState {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let directory = crate::diagnostics::config_directory(app)?;
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let file = directory.join("desktop-settings.json");
        let mut settings = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<DesktopSettings>(&bytes).ok())
            .unwrap_or_default();
        let mut changed = false;
        if settings.close_to_tray_configured != Some(true) {
            settings.close_to_tray = true;
            settings.close_to_tray_configured = Some(true);
            changed = true;
        }
        if settings.notifications_configured != Some(true) {
            settings.show_notifications = true;
            settings.notifications_configured = Some(true);
            changed = true;
        }
        if changed {
            std::fs::write(
                &file,
                serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(Self {
            close_to_tray: AtomicBool::new(settings.close_to_tray),
            media_active: AtomicBool::new(false),
            incoming_call_id: Mutex::new(None),
            file,
            overlay_operation: tokio::sync::Mutex::new(()),
        })
    }

    pub fn media_active(&self) -> bool {
        self.media_active.load(Ordering::Acquire)
    }

    fn read(&self) -> DesktopSettings {
        std::fs::read(&self.file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn write(&self, settings: DesktopSettings) -> Result<(), String> {
        std::fs::write(
            &self.file,
            serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        self.close_to_tray
            .store(settings.close_to_tray, Ordering::SeqCst);
        Ok(())
    }
}

#[tauri::command]
pub fn desktop_set_media_active(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    active: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Недоступно для этого окна".into());
    }
    state.media_active.store(active, Ordering::Release);
    if active {
        crate::webview_health::set_low_memory(&window, false);
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_settings_get(state: State<'_, DesktopState>) -> DesktopSettings {
    state.read()
}

#[tauri::command]
pub fn desktop_settings_set(
    state: State<'_, DesktopState>,
    settings: DesktopSettings,
) -> Result<(), String> {
    state.write(settings)
}

#[tauri::command]
pub fn desktop_show_main(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Главное окно недоступно")?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn desktop_window_drag(
    window: WebviewWindow,
    x: f64,
    y: f64,
) -> Result<(), String> {
    if window.label() != "main"
        || !x.is_finite()
        || !(0.0..=16384.0).contains(&x)
        || !y.is_finite()
        || !(0.0..=36.0).contains(&y)
    {
        return Err("Недоступно для этого окна".into());
    }
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_exit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn desktop_send_test_notification(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let mut notification = app
        .notification()
        .builder()
        .title("Coherent")
        .body("Системные уведомления работают.");
    if state.read().notification_sound {
        notification = notification.sound("IM");
    }
    notification.show().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_notify(
    app: AppHandle,
    state: State<'_, DesktopState>,
    title: String,
    body: String,
    kind: String,
) -> Result<(), String> {
    let settings = state.read();
    if !settings.show_notifications {
        return Ok(());
    }
    let mut notification = app.notification().builder().title(title).body(body);
    if settings.notification_sound {
        notification = match kind.as_str() {
            "message" => notification.sound("IM"),
            "friend" => notification.sound("Default"),
            _ => notification,
        };
    }
    notification.show().map_err(|error| error.to_string())
}

pub fn notify_background_message(app: &AppHandle, event: &serde_json::Value, user_id: &str) {
    if event.get("type").and_then(|value| value.as_str()) != Some("message") {
        return;
    }
    let Some(message) = event.get("message") else {
        return;
    };
    if message.get("sender_id").and_then(|value| value.as_str()) == Some(user_id) {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
        return;
    }
    let Some(state) = app.try_state::<DesktopState>() else {
        return;
    };
    let settings = state.read();
    if !settings.show_notifications {
        return;
    }
    let body = message
        .get("body")
        .and_then(|value| value.as_str())
        .filter(|body| !body.is_empty())
        .unwrap_or("Новое вложение");
    let body: String = body.chars().take(240).collect();
    let mut notification = app
        .notification()
        .builder()
        .title("Новое сообщение в Coherent")
        .body(body);
    if settings.notification_sound {
        notification = notification.sound("IM");
    }
    let result = notification.show();
    crate::diagnostics::event(
        "notification.message",
        serde_json::json!({"submitted": result.is_ok()}),
    );
}

#[tauri::command]
pub fn desktop_current_call_overlay_id(state: State<'_, DesktopState>) -> Option<String> {
    state
        .incoming_call_id
        .lock()
        .ok()
        .and_then(|value| value.clone())
}

#[tauri::command]
pub async fn desktop_show_call_overlay(
    app: AppHandle,
    state: State<'_, DesktopState>,
    call_id: String,
) -> Result<(), String> {
    let _operation = state.overlay_operation.lock().await;
    *state
        .incoming_call_id
        .lock()
        .map_err(|_| "Не удалось открыть окно звонка".to_string())? = Some(call_id.clone());
    let expected = call_id.clone();
    let window = match app.get_webview_window("call-overlay") {
        Some(window) => window,
        None => build_call_overlay(&app).await?,
    };
    if state
        .incoming_call_id
        .lock()
        .map_err(|_| "Окно звонка недоступно")?
        .as_deref()
        != Some(expected.as_str())
    {
        return Ok(());
    }
    position_call_overlay(&app, &window)?;
    window.set_always_on_top(true).map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn desktop_close_call_overlay(
    app: AppHandle,
    state: State<'_, DesktopState>,
    call_id: String,
) -> Result<(), String> {
    let mut current = state
        .incoming_call_id
        .lock()
        .map_err(|_| "Не удалось закрыть окно звонка".to_string())?;
    if current.as_deref() != Some(call_id.as_str()) {
        return Ok(());
    }
    *current = None;
    if let Some(window) = app.get_webview_window("call-overlay") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn build_call_overlay(app: &AppHandle) -> Result<WebviewWindow, String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("webview-call-overlay");
    let window = WebviewWindowBuilder::new(
        app,
        "call-overlay",
        WebviewUrl::App("index.html?window=incoming-call".into()),
    )
    .title("Coherent")
    .inner_size(340.0, 226.0)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(true)
    .visible(false)
    .data_directory(data_dir)
    .additional_browser_args("--autoplay-policy=no-user-gesture-required")
    .build()
    .map_err(|e| e.to_string())?;
    crate::webview_health::install(&window).map_err(|e| e.to_string())?;
    Ok(window)
}

#[tauri::command]
pub fn desktop_theme_get(app: AppHandle) -> Result<String, String> {
    let path = crate::diagnostics::config_directory(&app)?.join("theme.json");
    Ok(std::fs::read(path)
        .ok()
        .and_then(|v| serde_json::from_slice::<String>(&v).ok())
        .unwrap_or_else(|| "purple".into()))
}

#[tauri::command]
pub fn desktop_theme_set(app: AppHandle, theme: String) -> Result<(), String> {
    if !["purple", "black", "gray", "white", "navy", "green"].contains(&theme.as_str()) {
        return Err("Неизвестная тема".into());
    }
    let path = crate::diagnostics::config_directory(&app)?.join("theme.json");
    std::fs::write(path, serde_json::to_vec(&theme).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

fn position_call_overlay(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or("Главное окно недоступно")?;
    let monitor = main
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(main.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("Монитор недоступен")?;
    let work_area = monitor.work_area();
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let x = work_area.position.x + (work_area.size.width as i32 - size.width as i32) / 2;
    let y = work_area.position.y + (work_area.size.height as i32 - size.height as i32) / 2;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

pub fn install_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Открыть Coherent", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "Выйти из Coherent", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &exit])?;
    TrayIconBuilder::new()
        .icon(app.default_window_icon().expect("application icon").clone())
        .tooltip("Coherent")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                let _ = desktop_show_main(app.clone());
            }
            "exit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = desktop_show_main(tray.app_handle().clone());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn on_window_event(window: &Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == "call-overlay" {
            api.prevent_close();
            let _ = window.hide();
            return;
        }
        if let Some(state) = window.app_handle().try_state::<DesktopState>() {
            if state.close_to_tray.load(Ordering::SeqCst) {
                api.prevent_close();
                let _ = window.hide();
            } else {
                window.app_handle().exit(0);
            }
        }
    }
}
