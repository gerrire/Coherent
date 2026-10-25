//! User-facing top-level windows, including minimized windows. Do not confuse
//! WS_VISIBLE with visibility: shell/UWP hosts can be DWM-cloaked on this desktop.
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{BOOL, PWSTR};
use windows_capture::window::Window;

pub struct CaptureWindow {
    pub window: Window,
    pub name: String,
    pub app_name: Option<String>,
    pub process_id: u32,
    pub width: u32,
    pub height: u32,
    pub minimized: bool,
}

fn service_process(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "textinputhost.exe"
            | "systemsettings.exe"
            | "shellexperiencehost.exe"
            | "startmenuexperiencehost.exe"
            | "searchhost.exe"
            | "searchapp.exe"
            | "lockapp.exe"
            | "runtimebroker.exe"
            | "widgets.exe"
    )
}

fn process_name(id: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, id).ok()?;
        let mut path = [0u16; 32768];
        let mut length = path.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut length,
        );
        let _ = CloseHandle(process);
        result.ok()?;
        let path = String::from_utf16_lossy(&path[..length as usize]);
        path.rsplit('\\').next().map(str::to_owned)
    }
}

unsafe extern "system" fn app_child(hwnd: HWND, data: LPARAM) -> BOOL {
    let owner = unsafe { &mut *(data.0 as *mut (u32, Option<u32>)) };
    let mut id = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut id));
    }
    if id != 0 && id != owner.0 && unsafe { IsWindowVisible(hwnd).as_bool() } {
        owner.1 = Some(id);
        return BOOL(0);
    }
    BOOL(1)
}

fn inspect(hwnd: HWND) -> Option<CaptureWindow> {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() {
            return None;
        }
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            (&mut cloaked as *mut u32).cast(),
            size_of::<u32>() as u32,
        );
        if cloaked != 0 {
            return None;
        }
        let styles = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        let extended = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        let app_window = extended & WS_EX_APPWINDOW.0 != 0;
        if styles & WS_CHILD.0 != 0
            || (!app_window
                && (extended & WS_EX_TOOLWINDOW.0 != 0
                    || GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| !owner.is_invalid())))
        {
            return None;
        }
        let mut affinity = 0;
        if GetWindowDisplayAffinity(hwnd, &mut affinity).is_ok() && affinity != WDA_NONE.0 {
            return None;
        }
        let mut class = [0u16; 256];
        let count = GetClassNameW(hwnd, &mut class);
        let class = String::from_utf16_lossy(&class[..count.max(0) as usize]);
        if matches!(
            class.as_str(),
            "Progman"
                | "WorkerW"
                | "Shell_TrayWnd"
                | "Shell_SecondaryTrayWnd"
                | "Windows.UI.Core.CoreWindow"
        ) {
            return None;
        }
        let window = Window::from_raw_hwnd(hwnd.0);
        let mut process_id = window.process_id().ok()?;
        if process_id == std::process::id() {
            return None;
        }
        let mut app_name = process_name(process_id);
        if app_name
            .as_deref()
            .is_some_and(|name| name.eq_ignore_ascii_case("ApplicationFrameHost.exe"))
        {
            // A real UWP app is hosted by this frame. Resolve its child instead
            // of offering a background ApplicationFrameHost as an application.
            let mut child = (process_id, None);
            let _ = EnumChildWindows(
                Some(hwnd),
                Some(app_child),
                LPARAM((&mut child as *mut (u32, Option<u32>)) as isize),
            );
            process_id = child.1?;
            app_name = process_name(process_id);
        }
        if app_name.as_deref().is_some_and(service_process) {
            return None;
        }
        let name = window.title().ok()?;
        if name.trim().is_empty() {
            return None;
        }
        let minimized = IsIconic(hwnd).as_bool();
        let mut rect = RECT::default();
        if minimized {
            let mut placement = WINDOWPLACEMENT {
                length: size_of::<WINDOWPLACEMENT>() as u32,
                ..Default::default()
            };
            GetWindowPlacement(hwnd, &mut placement).ok()?;
            rect = placement.rcNormalPosition;
        } else {
            GetWindowRect(hwnd, &mut rect).ok()?;
        }
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width < 64 || height < 64 {
            return None;
        }
        Some(CaptureWindow {
            window,
            name,
            app_name,
            process_id,
            width: width as u32,
            height: height as u32,
            minimized,
        })
    }
}

unsafe extern "system" fn collect(hwnd: HWND, data: LPARAM) -> BOOL {
    if let Some(window) = inspect(hwnd) {
        unsafe { &mut *(data.0 as *mut Vec<CaptureWindow>) }.push(window);
    }
    BOOL(1)
}

pub fn enumerate() -> Result<Vec<CaptureWindow>, String> {
    let mut windows = Vec::new();
    unsafe {
        EnumWindows(
            Some(collect),
            LPARAM((&mut windows as *mut Vec<CaptureWindow>) as isize),
        )
    }
    .map_err(|error| error.to_string())?;
    Ok(windows)
}

pub fn restore(window: Window) -> Result<(), String> {
    let hwnd = HWND(window.as_raw_hwnd());
    if unsafe { !IsWindow(Some(hwnd)).as_bool() } {
        return Err("Выбранное окно уже закрыто.".into());
    }
    if unsafe { IsIconic(hwnd).as_bool() } {
        let _ = unsafe { ShowWindowAsync(hwnd, SW_RESTORE) };
        for _ in 0..20 {
            if unsafe { !IsIconic(hwnd).as_bool() } {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        return Err("Не удалось восстановить свёрнутое окно. Разверните его вручную.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn filters_shell_helpers_without_hiding_regular_applications() {
        for name in ["TextInputHost.exe", "SystemSettings.exe", "SearchHost.exe"] {
            assert!(super::service_process(name));
        }
        for name in [
            "notepad.exe",
            "explorer.exe",
            "chrome.exe",
            "Code.exe",
            "Telegram.exe",
        ] {
            assert!(!super::service_process(name));
        }
    }
}
