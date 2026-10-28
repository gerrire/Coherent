use tauri::{Emitter, WebviewWindow};

unsafe extern "C" {
    fn coherent_install_window_frame(
        parent: *mut std::ffi::c_void,
        event: extern "C" fn(*mut std::ffi::c_void, i32),
        context: *mut std::ffi::c_void,
    ) -> bool;
    fn coherent_window_frame_visible(parent: *mut std::ffi::c_void, visible: bool);
}

#[tauri::command]
pub fn desktop_window_frame_set_visible(window: WebviewWindow, visible: bool) -> Result<(), String> {
    if window.label() != "main" { return Err("Недоступно для этого окна".into()); }
    let parent = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
    window.run_on_main_thread(move || unsafe { coherent_window_frame_visible(parent as _, visible); })
        .map_err(|error| error.to_string())
}

extern "C" fn caption_event(context: *mut std::ffi::c_void, event: i32) {
    // The native parent owns this context until WM_NCDESTROY, on its UI thread.
    if event == -1 {
        unsafe { drop(Box::from_raw(context.cast::<WebviewWindow>())); }
    } else {
        let window = unsafe { &*context.cast::<WebviewWindow>() };
        let _ = window.emit("desktop-caption-hover", event == 1);
    }
}

pub fn install(window: &WebviewWindow) -> Result<(), String> {
    let parent = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
    let window = window.clone();
    let dispatcher = window.clone();
    dispatcher.run_on_main_thread(move || {
        let context = Box::into_raw(Box::new(window));
        if !unsafe { coherent_install_window_frame(parent as _, caption_event, context.cast()) } {
            unsafe { drop(Box::from_raw(context)); }
            crate::diagnostics::event("window.frame_failed", serde_json::json!({}));
        }
    }).map_err(|error| error.to_string())
}
