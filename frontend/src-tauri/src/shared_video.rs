//! Bounded, read-only WebView2 shared memory for raw BGRA frames.
//! COM objects stay on the UI thread. The capture thread owns a separate mapped
//! view; closing either side cannot invalidate the other side's view.
use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Memory::{
    FILE_MAP_WRITE, MEMORY_MAPPED_VIEW_ADDRESS, MapViewOfFile, UnmapViewOfFile,
};
use windows::core::{HSTRING, Interface};

pub const CAPACITY: usize = 3840 * 2160 * 4;

pub struct SharedVideoMemory {
    view: MEMORY_MAPPED_VIEW_ADDRESS,
}
// The mapping is thread-independent. Only the WGC producer writes through &mut
// self; script receives read-only access and ACKs after VideoFrame copies bytes.
unsafe impl Send for SharedVideoMemory {}

impl SharedVideoMemory {
    pub fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > CAPACITY {
            return Err("Размер кадра превышает доступную память захвата.".into());
        }
        unsafe {
            std::ptr::copy_nonoverlapping(
                bytes.as_ptr(),
                self.view.Value.cast::<u8>(),
                bytes.len(),
            );
        }
        Ok(())
    }
}
impl Drop for SharedVideoMemory {
    fn drop(&mut self) {
        unsafe {
            let _ = UnmapViewOfFile(self.view);
        }
    }
}

pub async fn create(window: &WebviewWindow, capture_id: u64) -> Result<SharedVideoMemory, String> {
    if window.label() != "main"
        || !window
            .url()
            .is_ok_and(|u| crate::permissions::trusted_url(&u))
    {
        return Err("Захват доступен только в главном окне Coherent.".into());
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |native| {
            let result = unsafe {
                (|| -> Result<SharedVideoMemory, String> {
                    let environment = native
                        .environment()
                        .cast::<ICoreWebView2Environment12>()
                        .map_err(|_| {
                            "Обновите Microsoft Edge WebView2 для нативной демонстрации."
                                .to_string()
                        })?;
                    let webview = native
                        .controller()
                        .CoreWebView2()
                        .and_then(|w| w.cast::<ICoreWebView2_17>())
                        .map_err(|e| e.to_string())?;
                    let buffer = environment
                        .CreateSharedBuffer(CAPACITY as u64)
                        .map_err(|e| e.to_string())?;
                    let mut handle = HANDLE::default();
                    buffer
                        .FileMappingHandle(&mut handle)
                        .map_err(|e| e.to_string())?;
                    let view = MapViewOfFile(handle, FILE_MAP_WRITE, 0, 0, CAPACITY);
                    if view.Value.is_null() {
                        return Err("Недостаточно памяти для демонстрации.".into());
                    }
                    let memory = SharedVideoMemory { view };
                    let metadata = HSTRING::from(
                        serde_json::json!({"kind":"coherent-screen", "captureId":capture_id})
                            .to_string(),
                    );
                    webview
                        .PostSharedBufferToScript(
                            &buffer,
                            COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
                            &metadata,
                        )
                        .map_err(|e| e.to_string())?;
                    // Close only the original native view. The separate producer mapping
                    // and script mapping keep the underlying pages alive independently.
                    buffer.Close().map_err(|e| e.to_string())?;
                    Ok(memory)
                })()
            };
            let _ = sender.send(result);
        })
        .map_err(|e| e.to_string())?;
    receiver
        .await
        .map_err(|_| "Окно клиента закрыто.".to_string())?
}
