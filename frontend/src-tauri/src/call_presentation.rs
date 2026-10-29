//! Incoming calls must never interrupt an exclusive/fullscreen application or
//! steal a game's cursor. Only observe Windows state; never release its capture.
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
};
use windows::Win32::UI::Shell::{QUNS_ACCEPTS_NOTIFICATIONS, SHQueryUserNotificationState};
use windows::Win32::UI::WindowsAndMessaging::*;

fn covers_monitor(window: RECT, monitor: RECT) -> bool {
    window.left <= monitor.left
        && window.top <= monitor.top
        && window.right >= monitor.right
        && window.bottom >= monitor.bottom
}

fn confined(clip: RECT, desktop: RECT) -> bool {
    clip.left > desktop.left
        || clip.top > desktop.top
        || clip.right < desktop.right
        || clip.bottom < desktop.bottom
}

pub fn suppression_reason() -> Option<&'static str> {
    unsafe {
        let foreground = GetForegroundWindow();
        let mut process_id = 0;
        if !foreground.is_invalid() {
            GetWindowThreadProcessId(foreground, Some(&mut process_id));
            if process_id == std::process::id() {
                return None;
            }
        }
        // Includes exclusive Direct3D, presentations, busy/fullscreen and lock.
        if SHQueryUserNotificationState().is_ok_and(|state| state != QUNS_ACCEPTS_NOTIFICATIONS) {
            return Some("windows_busy");
        }
        // A missing foreground window or failed observation must not prompt an
        // unexpected window on a secure desktop or during a display transition.
        if foreground.is_invalid() || process_id == 0 {
            return Some("foreground_unavailable");
        }
        let mut cursor = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        if GetCursorInfo(&mut cursor).is_err() || cursor.flags.0 & CURSOR_SHOWING.0 == 0 {
            return Some("cursor_unavailable");
        }
        let (left, top) = (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
        );
        let desktop = RECT {
            left,
            top,
            right: left + GetSystemMetrics(SM_CXVIRTUALSCREEN),
            bottom: top + GetSystemMetrics(SM_CYVIRTUALSCREEN),
        };
        let mut clip = RECT::default();
        if GetClipCursor(&mut clip).is_err() || confined(clip, desktop) {
            return Some("cursor_confined");
        }
        // Detect borderless fullscreen too; do not treat a maximized work-area
        // window (which leaves the taskbar visible) as fullscreen.
        let mut bounds = RECT::default();
        let mut monitor = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetWindowRect(foreground, &mut bounds).is_err()
            || !GetMonitorInfoW(
                MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST),
                &mut monitor,
            )
            .as_bool()
        {
            return Some("display_unavailable");
        }
        if foreground != GetDesktopWindow()
            && foreground != GetShellWindow()
            && covers_monitor(bounds, monitor.rcMonitor)
        {
            return Some("fullscreen");
        }
    }
    None
}

pub fn show_without_activation(window: &tauri::WebviewWindow) -> Result<(), String> {
    let handle = window.hwnd().map_err(|error| error.to_string())?;
    // SWP_SHOWWINDOW plus SWP_NOACTIVATE makes the window visible without
    // changing the foreground app. A normal Z-order lets subsequent apps cover
    // it naturally, including a game started while this call is still ringing.
    unsafe {
        SetWindowPos(
            handle,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
        .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> RECT {
        RECT {
            left,
            top,
            right,
            bottom,
        }
    }

    #[test]
    fn fullscreen_includes_borderless_and_negative_monitor_coordinates() {
        let monitor = rect(-1920, 0, 0, 1080);
        assert!(covers_monitor(monitor, monitor));
        assert!(covers_monitor(rect(-1928, -8, 8, 1088), monitor));
        assert!(!covers_monitor(rect(-1920, 0, 0, 1040), monitor));
        assert!(!covers_monitor(rect(0, 0, 1920, 1080), monitor));
    }

    #[test]
    fn cursor_confinement_includes_one_monitor_and_single_pixel_lock() {
        let desktop = rect(-1920, 0, 1920, 1080);
        assert!(!confined(desktop, desktop));
        assert!(confined(rect(0, 0, 1920, 1080), desktop));
        assert!(confined(rect(500, 500, 501, 501), desktop));
    }
}
