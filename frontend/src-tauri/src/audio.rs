use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use serde_json::json;
use std::collections::HashSet;
use std::ffi::c_void;
use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{Notify, mpsc};

unsafe extern "C" {
    fn coherent_loopback_start(
        excluded_process: u32,
        callback: extern "C" fn(*const i16, u32, i32, *mut c_void),
        context: *mut c_void,
    ) -> *mut c_void;
    fn coherent_loopback_stop(capture: *mut c_void);
}

struct CallbackContext {
    sender: mpsc::Sender<Vec<i16>>,
    error: Arc<AtomicI32>,
    wake: Arc<Notify>,
    dropped: Arc<AtomicU64>,
    peak: AtomicI32,
}

extern "C" fn receive_packet(data: *const i16, frames: u32, error: i32, context: *mut c_void) {
    if context.is_null() {
        return;
    }
    // Native stop joins the producer before this allocation is freed.
    let context = unsafe { &*(context as *const CallbackContext) };
    if error != 0 {
        context.error.store(error, Ordering::Release);
        context.wake.notify_one();
    } else if !data.is_null() && frames > 0 && frames <= 48000 {
        let samples = unsafe { std::slice::from_raw_parts(data, frames as usize * 2) };
        let peak = samples
            .iter()
            .map(|sample| i32::from(*sample).abs())
            .max()
            .unwrap_or(0);
        context.peak.fetch_max(peak, Ordering::Relaxed);
        if context.sender.try_send(samples.to_vec()).is_err() {
            context.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

struct Capture {
    id: u64,
    native: *mut c_void,
    context: *mut CallbackContext,
    pump: Option<JoinHandle<()>>,
    pending: Arc<Mutex<HashSet<u64>>>,
}
unsafe impl Send for Capture {}

impl Drop for Capture {
    fn drop(&mut self) {
        let peak;
        unsafe {
            coherent_loopback_stop(self.native);
            peak = (*self.context).peak.load(Ordering::Relaxed);
            drop(Box::from_raw(self.context));
        }
        if let Some(pump) = self.pump.take() {
            pump.abort();
        }
        crate::diagnostics::event("audio.stopped", json!({"attempt": self.id, "peak": peak}));
    }
}

#[derive(Clone, Default)]
pub struct AudioState {
    capture: Arc<Mutex<Option<Capture>>>,
    next_id: Arc<AtomicU64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioPacket {
    capture_id: u64,
    sequence: u64,
    pcm: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioError {
    capture_id: u64,
    message: String,
}

fn spawn_pump(task: impl std::future::Future<Output = ()> + Send + 'static) -> JoinHandle<()> {
    // Commands may originate on the UI/COM thread without a Tokio context.
    tauri::async_runtime::spawn(task)
}

async fn playback_process(window: &tauri::WebviewWindow) -> Result<u32, String> {
    if window.label() != "main"
        || !window
            .url()
            .is_ok_and(|url| crate::permissions::trusted_url(&url))
    {
        return Err("Захват звука доступен только в главном окне.".into());
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |native| {
            let result = unsafe {
                native.controller().CoreWebView2().and_then(|webview| {
                    let mut id = 0;
                    webview.BrowserProcessId(&mut id)?;
                    Ok(id)
                })
            }
            .map_err(|_| "Не удалось определить процесс воспроизведения Coherent.".to_string());
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    // Never fall back to full endpoint loopback: that would send the call back
    // to its participants when the playback process cannot be identified.
    let id = receiver
        .await
        .map_err(|_| "Окно воспроизведения закрылось.")??;
    if id == 0 {
        return Err("Процесс воспроизведения Coherent недоступен.".into());
    }
    Ok(id)
}

#[tauri::command]
pub async fn start_system_audio(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AudioState>,
) -> Result<u64, String> {
    let excluded_process = playback_process(&window).await?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut active = state.capture.lock().map_err(|_| "Не удалось запустить звук")?;
        if active.is_some() { return Err("Системный звук уже захватывается".into()); }
        let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        crate::diagnostics::event("audio.start", json!({"attempt": id, "mode": "exclude_webview_playback_tree"}));
        let (sender, mut receiver) = mpsc::channel(8);
        let error = Arc::new(AtomicI32::new(0));
        let wake = Arc::new(Notify::new());
        let dropped = Arc::new(AtomicU64::new(0));
        let context = Box::into_raw(Box::new(CallbackContext { sender, error: error.clone(), wake: wake.clone(), dropped: dropped.clone(), peak: AtomicI32::new(0) }));
        let native = unsafe { coherent_loopback_start(excluded_process, receive_packet, context.cast()) };
        if native.is_null() {
            unsafe { drop(Box::from_raw(context)); }
            return Err("Не удалось запустить захват системного звука.".into());
        }
        // Establish RAII ownership before any task can fail.
        let pending = Arc::new(Mutex::new(HashSet::new()));
        let mut capture = Capture { id, native, context, pump: None, pending: pending.clone() };
        let cleanup = state.clone();
        capture.pump = Some(spawn_pump(async move {
            let mut packets = 0_u64;
            let mut peak = 0_i32;
            let mut sequence = 0_u64;
            loop {
                let code = error.load(Ordering::Acquire);
                if code != 0 {
                    crate::diagnostics::event("audio.failed", json!({"attempt": id, "hresult": code, "dropped": dropped.load(Ordering::Relaxed)}));
                    let _ = app.emit_to("main", "coherent:system-audio-error", AudioError {
                        capture_id: id,
                        message: format!("Системный звук Windows недоступен (0x{:08x}). Попробуйте включить его снова.", code as u32),
                    });
                    break;
                }
                tokio::select! {
                    _ = wake.notified() => continue,
                    samples = receiver.recv() => {
                        let Some(samples) = samples else { break; };
                        sequence += 1;
                        // The native channel alone does not bound WebView IPC or
                        // MessagePort queues. Credit returns only after playback.
                        {
                            let Ok(mut waiting) = pending.lock() else { break; };
                            if waiting.len() >= 8 {
                                dropped.fetch_add(1, Ordering::Relaxed);
                                continue;
                            }
                            waiting.insert(sequence);
                        }
                        peak = peak.max(samples.iter().map(|sample| i32::from(*sample).abs()).max().unwrap_or(0));
                        let bytes = unsafe { std::slice::from_raw_parts(samples.as_ptr().cast::<u8>(), samples.len() * 2) };
                        if app.emit_to("main", "coherent:system-audio", AudioPacket { capture_id: id, sequence, pcm: STANDARD.encode(bytes) }).is_err() { break; }
                        packets += 1;
                        if packets == 1 || packets.is_multiple_of(500) {
                            // Only a scalar level, never PCM samples or media content.
                            crate::diagnostics::event("audio.packets", json!({"attempt": id, "packets": packets, "peak": peak, "dropped": dropped.load(Ordering::Relaxed)}));
                            peak = 0;
                        }
                    }
                }
            }
            // Failed pumps release the producer and cannot clear a newer attempt.
            tauri::async_runtime::spawn_blocking(move || { let _ = cleanup.stop(Some(id)); });
        }));
        *active = Some(capture);
        Ok(id)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn desktop_audio_ack(state: State<'_, AudioState>, capture_id: u64, sequence: u64) {
    if let Ok(active) = state.capture.lock() {
        if let Some(capture) = active.as_ref().filter(|capture| capture.id == capture_id) {
            if let Ok(mut pending) = capture.pending.lock() {
                pending.remove(&sequence);
            }
        }
    }
}

impl AudioState {
    pub fn stop(&self, id: Option<u64>) -> Result<(), String> {
        let mut active = self
            .capture
            .lock()
            .map_err(|_| "Не удалось остановить звук")?;
        if active
            .as_ref()
            .is_some_and(|capture| id.is_none_or(|id| id == capture.id))
        {
            // Join old callbacks before a new capture can begin.
            drop(active.take());
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn stop_system_audio(
    state: State<'_, AudioState>,
    capture_id: u64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.stop(Some(capture_id)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn desktop_audio_bridge_status(
    window: tauri::WebviewWindow,
    capture_id: u64,
    frames: u32,
    peak: u32,
    underruns: u32,
) {
    if window.label() != "main" || frames > 480_128 || peak > 32768 || underruns > frames {
        return;
    }
    crate::diagnostics::event(
        "audio.bridge",
        json!({"attempt": capture_id, "frames": frames, "peak": peak, "underruns": underruns}),
    );
}

#[cfg(test)]
mod tests {
    #[test]
    fn pump_starts_on_a_thread_without_tokio_context() {
        std::thread::spawn(|| {
            assert!(tokio::runtime::Handle::try_current().is_err());
            let (sender, receiver) = std::sync::mpsc::channel();
            let task = super::spawn_pump(async move {
                let _ = sender.send(());
            });
            receiver
                .recv_timeout(std::time::Duration::from_secs(3))
                .expect("audio pump did not run");
            task.abort();
        })
        .join()
        .expect("the UI-thread audio start must not panic");
    }
}
