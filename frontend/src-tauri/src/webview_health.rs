use serde_json::json;
use tauri::{Manager, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{BrowserProcessExitedEventHandler, ProcessFailedEventHandler};
use windows::core::Interface;

pub fn install(window: &WebviewWindow) -> tauri::Result<()> {
    let label = window.label().to_string();
    let app = window.app_handle().clone();
    window.with_webview(move |native| {
        let result = unsafe { (|| -> windows::core::Result<()> {
            let webview = native.controller().CoreWebView2()?;
            // A desktop client has no browser history gestures. This keeps
            // precision-touchpad overscroll from moving the entire surface.
            if let Ok(settings) = webview.Settings()?.cast::<ICoreWebView2Settings6>() {
                settings.SetIsSwipeNavigationEnabled(false)?;
            }
            let mut token = 0;
            let failed_label = label.clone();
            webview.add_ProcessFailed(&ProcessFailedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()); };
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                args.ProcessFailedKind(&mut kind)?;
                let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
                let mut exit_code = 0;
                if let Ok(details) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                    let _ = details.Reason(&mut reason);
                    let _ = details.ExitCode(&mut exit_code);
                }
                crate::diagnostics::event("webview.process_failed", json!({"window": failed_label, "kind": kind.0, "reason": reason.0, "exitCode": exit_code}));
                if failed_label == "main" && (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED) {
                    // Do not block/re-enter the COM callback; stop media off the UI thread.
                    let app = app.clone();
                    tauri::async_runtime::spawn_blocking(move || crate::stop_media(&app));
                }
                Ok(())
            })), &mut token)?;
            let environment = native.environment().cast::<ICoreWebView2Environment5>()?;
            environment.add_BrowserProcessExited(&BrowserProcessExitedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut kind = COREWEBVIEW2_BROWSER_PROCESS_EXIT_KIND::default();
                    args.BrowserProcessExitKind(&mut kind)?;
                    // No PID, URLs, document titles or user content in diagnostics.
                    crate::diagnostics::event("webview.browser_exited", json!({"window": label, "kind": kind.0}));
                }
                Ok(())
            })), &mut token)?;
            Ok(())
        })() };
        if let Err(error) = result { crate::diagnostics::event("webview.observer_failed", json!({"hresult": error.code().0})); }
    })
}
