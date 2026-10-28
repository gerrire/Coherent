use serde_json::json;
use tauri::{Manager, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    BrowserProcessExitedEventHandler, PermissionRequestedEventHandler, ProcessFailedEventHandler,
    SetPermissionStateCompletedHandler,
};
use windows::core::Interface;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMetrics {
    processes: usize,
    private_bytes: u64,
    working_bytes: u64,
    cpu_ms: u64,
    logical_processors: usize,
}

#[tauri::command]
pub async fn desktop_process_metrics(window: WebviewWindow) -> Result<ProcessMetrics, String> {
    if window.label() != "main" { return Err("Недоступно для этого окна".into()); }
    let mut ids = std::collections::HashSet::from([std::process::id()]);
    // Each auxiliary window can have its own environment. Deduplicate shared
    // browser/GPU processes instead of counting them once per WebView.
    for view in window.app_handle().webview_windows().into_values() {
        let (send, receive) = tokio::sync::oneshot::channel();
        view.with_webview(move |native| {
            let result = unsafe { (|| -> windows::core::Result<Vec<u32>> {
                let infos = native.environment().cast::<ICoreWebView2Environment8>()?.GetProcessInfos()?;
                let mut count = 0;
                infos.Count(&mut count)?;
                let mut ids = Vec::new();
                for index in 0..count.min(256) {
                    let mut id = 0;
                    infos.GetValueAtIndex(index)?.ProcessId(&mut id)?;
                    if id > 0 { ids.push(id as u32); }
                }
                Ok(ids)
            })() };
            let _ = send.send(result.map_err(|error| error.to_string()));
        }).map_err(|error| error.to_string())?;
        ids.extend(receive.await.map_err(|error| error.to_string())??);
    }
    tauri::async_runtime::spawn_blocking(move || {
        use windows::Win32::Foundation::{CloseHandle, FILETIME};
        use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
        use windows::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};
        let mut metrics = ProcessMetrics { processes: 0, private_bytes: 0, working_bytes: 0, cpu_ms: 0,
            logical_processors: std::thread::available_parallelism().map_or(1, |count| count.get()) };
        for id in ids {
            unsafe {
                let Ok(handle) = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, id) else { continue; };
                let mut memory = PROCESS_MEMORY_COUNTERS_EX { cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32, ..Default::default() };
                let (mut created, mut exited, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
                if GetProcessMemoryInfo(handle, (&mut memory as *mut PROCESS_MEMORY_COUNTERS_EX).cast::<PROCESS_MEMORY_COUNTERS>(), memory.cb).is_ok() {
                    metrics.processes += 1;
                    metrics.private_bytes += memory.PrivateUsage as u64;
                    metrics.working_bytes += memory.WorkingSetSize as u64;
                }
                if GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user).is_ok() {
                    let ticks = |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
                    metrics.cpu_ms += (ticks(kernel) + ticks(user)) / 10000;
                }
                let _ = CloseHandle(handle);
            }
        }
        metrics
    }).await.map_err(|error| error.to_string())
}

pub fn install(window: &WebviewWindow) -> tauri::Result<()> {
    observe_memory(window);
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
            if label == "main" {
                // Coherent already persists explicit consent. Do not let a stale
                // WebView profile denial shadow that consent after an upgrade.
                // DEFAULT still goes through our handler and Windows privacy rules.
                if let Ok(profile) = webview.cast::<ICoreWebView2_13>().and_then(|view| view.Profile()).and_then(|profile| profile.cast::<ICoreWebView2Profile4>()) {
                    let origin = if cfg!(debug_assertions) { windows::core::w!("http://localhost:5173") } else { windows::core::w!("http://tauri.localhost") };
                    for kind in [COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_KIND_CAMERA] {
                        let _ = profile.SetPermissionState(kind, origin, COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
                            &SetPermissionStateCompletedHandler::create(Box::new(|result| {
                                crate::diagnostics::event("media.permission_reset", json!({"success": result.is_ok()}));
                                Ok(())
                            })));
                    }
                }
                webview.add_PermissionRequested(&PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                        args.PermissionKind(&mut kind)?;
                        if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE || kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA {
                            if let Ok(details) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() { details.SetSavesInProfile(false)?; }
                        }
                    }
                    Ok(())
                })), &mut token)?;
            }
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

pub fn set_low_memory(window: &WebviewWindow, low: bool) {
    let label = window.label().to_string();
    let _ = window.with_webview(move |native| unsafe {
        // Unlike suspension this keeps incoming calls, the socket and audio
        // alive. Older WebView2 versions simply retain their default policy.
        let result = native
            .controller()
            .CoreWebView2()
            .and_then(|view| view.cast::<ICoreWebView2_19>())
            .and_then(|view| {
                view.SetMemoryUsageTargetLevel(if low {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                } else {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                })
            });
        crate::diagnostics::event(
            "webview.memory_policy",
            json!({"window": label, "low": low, "applied": result.is_ok()}),
        );
    });
}

fn observe_memory(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    tauri::async_runtime::spawn(async move {
        let mut previous = None;
        let mut tick = 0_u32;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let Some(window) = app.get_webview_window(&label) else {
                break;
            };
            let active = label == "main"
                && app
                    .try_state::<crate::desktop::DesktopState>()
                    .is_some_and(|state| state.media_active());
            let hidden =
                !window.is_visible().unwrap_or(true) || window.is_minimized().unwrap_or(false);
            let low = hidden && !active;
            if previous != Some(low) {
                set_low_memory(&window, low);
                previous = Some(low);
            }
            tick += 1;
            if !tick.is_multiple_of(30) {
                continue;
            }
            let log_label = label.clone();
            let _ = window.with_webview(move |native| unsafe {
                // Process counters only; never inspect documents, media or keys.
                use windows::Win32::Foundation::CloseHandle;
                use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
                use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};
                let result = (|| -> windows::core::Result<(u64, u64, u32)> {
                    let infos = native.environment().cast::<ICoreWebView2Environment8>()?.GetProcessInfos()?;
                    let mut count = 0;
                    infos.Count(&mut count)?;
                    let mut private = 0_u64;
                    let mut working = 0_u64;
                    for index in 0..count.min(64) {
                        let info = infos.GetValueAtIndex(index)?;
                        let mut id = 0;
                        info.ProcessId(&mut id)?;
                        let Ok(handle) = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, id as u32) else { continue; };
                        let mut memory = PROCESS_MEMORY_COUNTERS_EX { cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32, ..Default::default() };
                        let read = GetProcessMemoryInfo(handle, (&mut memory as *mut PROCESS_MEMORY_COUNTERS_EX).cast::<PROCESS_MEMORY_COUNTERS>(), memory.cb);
                        let _ = CloseHandle(handle);
                        if read.is_ok() { private += memory.PrivateUsage as u64; working += memory.WorkingSetSize as u64; }
                    }
                    Ok((private / 1048576, working / 1048576, count))
                })();
                if let Ok((private, working, processes)) = result {
                    crate::diagnostics::event("webview.memory", json!({"window": log_label, "privateMiB": private, "workingMiB": working, "processes": processes, "hidden": hidden, "mediaActive": active}));
                }
            });
        }
    });
}
