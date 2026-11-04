//! Present a short, non-activating preview. Never release a game's cursor capture.
use std::time::{Duration, Instant};
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
};
use windows::Win32::UI::Shell::{
    QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN, SHQueryUserNotificationState,
};
use windows::Win32::UI::WindowsAndMessaging::*;

pub fn foreground_work_area() -> Option<RECT> {
    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.is_invalid() {
            return None;
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        GetMonitorInfoW(MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST), &mut info)
            .as_bool()
            .then_some(info.rcWork)
    }
}

pub fn suppression_reason() -> Option<&'static str> {
    unsafe {
        if GetForegroundWindow().is_invalid() {
            return Some("foreground_unavailable");
        }
        if SHQueryUserNotificationState().is_ok_and(|state| {
            state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_PRESENTATION_MODE
        }) {
            return Some("exclusive_fullscreen");
        }
    }
    None
}

pub fn show_without_activation(window: &tauri::WebviewWindow) -> Result<(), String> {
    let handle = window.hwnd().map_err(|error| error.to_string())?;
    let initial = unsafe { GetForegroundWindow().0 as usize };
    unsafe {
        SetWindowPos(
            handle,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
        .map_err(|error| error.to_string())?;
    }

    let overlay = handle.0 as usize;
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let mut interacted = false;
        loop {
            tokio::time::sleep(Duration::from_millis(80)).await;
            if !window.is_visible().unwrap_or(false) {
                return;
            }
            let foreground = unsafe { GetForegroundWindow().0 as usize };
            if foreground == overlay {
                interacted = true;
            } else if interacted || foreground != initial || started.elapsed() >= Duration::from_secs(10) {
                // Hiding the preview must not answer or decline the invitation.
                let _ = window.hide();
                return;
            }
        }
    });
    Ok(())
}
