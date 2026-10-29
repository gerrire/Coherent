mod audio;
mod call_crypto;
mod call_presentation;
mod capture_windows;
mod desktop;
mod diagnostics;
mod e2ee;
mod network;
mod permissions;
mod processes;
mod screen_capture;
mod shared_video;
mod webview_health;
mod window_frame;

use std::sync::Arc;
use tauri::Manager;
use tauri::webview::{PermissionKind, PermissionResponse};

pub(crate) fn stop_media(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<call_crypto::CallCryptoState>() {
        state.clear();
    }
    if let Some(state) = app.try_state::<audio::AudioState>() {
        let _ = state.stop(None);
    }
    if let Some(state) = app.try_state::<Arc<screen_capture::ScreenCaptureState>>() {
        let _ = state.stop_all();
    }
    diagnostics::event("media.cleanup", serde_json::json!({}));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    diagnostics::initialize();
    let context = tauri::generate_context!();
    processes::set_identity(&context.config().identifier);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let _ = desktop::desktop_show_main(app.clone());
        }))
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("local-pages")
                .on_navigation(|_, url| permissions::trusted_url(url))
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .on_permission_request(|webview, kind| {
            if webview.label() != "main"
                || !webview.url().is_ok_and(|u| permissions::trusted_url(&u))
            {
                return PermissionResponse::Deny;
            }
            match kind {
                PermissionKind::Microphone | PermissionKind::Camera => {
                    if webview
                        .try_state::<permissions::PermissionState>()
                        .is_some_and(|state| state.allowed(kind))
                    {
                        PermissionResponse::Allow
                    } else {
                        PermissionResponse::Deny
                    }
                }
                PermissionKind::Autoplay => PermissionResponse::Allow,
                PermissionKind::DisplayCapture | PermissionKind::Notifications => {
                    PermissionResponse::Deny
                }
                _ => PermissionResponse::Default,
            }
        })
        .on_window_event(desktop::on_window_event)
        .invoke_handler(tauri::generate_handler![
            network::api_initialize_csrf,
            e2ee::desktop_crypto_request,
            e2ee::desktop_crypto_reveal,
            e2ee::desktop_crypto_approve_link,
            call_crypto::desktop_call_crypto_request,
            call_crypto::desktop_call_crypto_close,
            permissions::desktop_media_permissions_get,
            permissions::desktop_media_permissions_set,
            network::api_request,
            network::api_upload,
            network::api_attachment,
            network::events_connect,
            network::events_disconnect,
            audio::start_system_audio,
            audio::stop_system_audio,
            audio::desktop_audio_bridge_status,
            audio::desktop_audio_ack,
            desktop::desktop_settings_get,
            desktop::desktop_set_media_active,
            desktop::desktop_settings_set,
            desktop::desktop_theme_get,
            desktop::desktop_theme_set,
            desktop::desktop_show_main,
            desktop::desktop_window_drag,
            window_frame::desktop_window_frame_set_visible,
            processes::desktop_process_metrics,
            processes::desktop_open_runtime_tasks,
            desktop::desktop_exit,
            desktop::desktop_send_test_notification,
            desktop::desktop_notify,
            desktop::desktop_current_call_overlay_id,
            desktop::desktop_show_call_overlay,
            desktop::desktop_close_call_overlay,
            screen_capture::desktop_screen_sources,
            screen_capture::desktop_screen_preview,
            screen_capture::desktop_screen_preview_cancel,
            screen_capture::desktop_screen_start,
            screen_capture::desktop_screen_borderless,
            screen_capture::desktop_screen_borderless_status,
            screen_capture::desktop_screen_ack,
            screen_capture::desktop_screen_stop,
            screen_capture::desktop_screen_self_check,
        ])
        .setup(|app| {
            app.manage(call_crypto::CallCryptoState::default());
            if let Some(directory) = diagnostics::profile_directory() {
                if let Some(main) = app.get_webview_window("main") {
                    diagnostics::event("qa.profile", serde_json::json!({"isolated": true}));
                    let _ = main.set_title("Coherent · проверка");
                }
                std::fs::create_dir_all(directory)?;
            }
            app.manage(Arc::new(network::NetworkState::new(app.handle())?));
            app.manage(audio::AudioState::default());
            app.manage(desktop::DesktopState::new(app.handle())?);
            app.manage(permissions::PermissionState::new(app.handle())?);
            app.manage(Arc::new(screen_capture::ScreenCaptureState::new(
                app.handle(),
            )?));
            if let Some(main) = app.get_webview_window("main") {
                webview_health::install(&main)?;
                window_frame::install(&main)?;
            }
            desktop::install_tray(app)?;
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .build(context);
    match app {
        Ok(app) => app.run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                stop_media(handle);
            }
        }),
        Err(error) => diagnostics::event(
            "app.start_failed",
            serde_json::json!({"error": error.to_string()}),
        ),
    }
}
