use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{ImageEncoder, ImageEncoderPixelFormat, ImageFormat};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    GraphicsCaptureItemType, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

#[derive(Clone, Copy)]
enum SourceItem {
    Monitor(Monitor),
    Window(Window),
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenSource {
    id: String,
    name: String,
    kind: &'static str,
    app_name: Option<String>,
    process_id: Option<u32>,
    width: u32,
    height: u32,
    minimized: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenFrame {
    capture_id: u64,
    width: u32,
    height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    jpeg: Option<String>,
}

enum FrameSink {
    Preview(mpsc::SyncSender<Result<String, String>>),
    Stream {
        app: AppHandle,
        capture_id: u64,
        waiting_for_ack: Arc<AtomicBool>,
        sent_at: Arc<Mutex<Instant>>,
        frame_rate: u32,
        shared: Option<crate::shared_video::SharedVideoMemory>,
    },
}

struct FrameHandler {
    encoder: ImageEncoder,
    sink: FrameSink,
    last_frame: Instant,
}

const MAX_STREAM_WIDTH: u32 = 1280;
const MAX_STREAM_HEIGHT: u32 = 720;
const MAX_STREAM_FRAME_RATE: u32 = 60;

fn stream_dimensions(width: u32, height: u32) -> (u32, u32) {
    let scale = (MAX_STREAM_WIDTH as f64 / width as f64)
        .min(MAX_STREAM_HEIGHT as f64 / height as f64)
        .min(1.0);
    (
        (width as f64 * scale).round().max(1.0) as u32,
        (height as f64 * scale).round().max(1.0) as u32,
    )
}

fn resize_bgra(
    source: &[u8],
    source_width: u32,
    source_height: u32,
    width: u32,
    height: u32,
) -> Vec<u8> {
    let mut output = vec![0_u8; width as usize * height as usize * 4];
    let x_ratio = source_width as f32 / width as f32;
    let y_ratio = source_height as f32 / height as f32;
    for y in 0..height as usize {
        let sy = ((y as f32 + 0.5) * y_ratio - 0.5).clamp(0.0, (source_height - 1) as f32);
        let y0 = sy.floor() as usize;
        let y1 = (y0 + 1).min(source_height as usize - 1);
        let fy = sy - y0 as f32;
        for x in 0..width as usize {
            let sx = ((x as f32 + 0.5) * x_ratio - 0.5).clamp(0.0, (source_width - 1) as f32);
            let x0 = sx.floor() as usize;
            let x1 = (x0 + 1).min(source_width as usize - 1);
            let fx = sx - x0 as f32;
            let p00 = (y0 * source_width as usize + x0) * 4;
            let p10 = (y0 * source_width as usize + x1) * 4;
            let p01 = (y1 * source_width as usize + x0) * 4;
            let p11 = (y1 * source_width as usize + x1) * 4;
            let dst = (y * width as usize + x) * 4;
            for channel in 0..4 {
                let top =
                    source[p00 + channel] as f32 * (1.0 - fx) + source[p10 + channel] as f32 * fx;
                let bottom =
                    source[p01 + channel] as f32 * (1.0 - fx) + source[p11 + channel] as f32 * fx;
                output[dst + channel] = (top * (1.0 - fy) + bottom * fy).round() as u8;
            }
        }
    }
    output
}

impl GraphicsCaptureApiHandler for FrameHandler {
    type Flags = FrameSink;
    type Error = String;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            encoder: ImageEncoder::new(ImageFormat::Jpeg, ImageEncoderPixelFormat::Bgra8)
                .map_err(|error| error.to_string())?,
            sink: ctx.flags,
            last_frame: Instant::now() - Duration::from_secs(1),
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if let FrameSink::Stream {
            waiting_for_ack,
            frame_rate,
            ..
        } = &self.sink
            && (waiting_for_ack.load(Ordering::Acquire)
                || self.last_frame.elapsed()
                    < Duration::from_secs_f64(
                        // A little scheduling tolerance avoids halving FPS when
                        // source/compositor ticks arrive just before the deadline.
                        // Canvas/WebRTC retain the requested output rate limit.
                        0.9 / f64::from((*frame_rate).min(MAX_STREAM_FRAME_RATE)),
                    ))
        {
            return Ok(());
        }

        let mut compact = Vec::new();
        let buffer = frame.buffer().map_err(|error| error.to_string())?;
        let source_width = buffer.width();
        let source_height = buffer.height();
        if source_width == 0 || source_height == 0 {
            return Ok(());
        }
        let source = buffer.as_nopadding_buffer(&mut compact);
        if let FrameSink::Stream {
            app,
            capture_id,
            waiting_for_ack,
            sent_at,
            shared: Some(memory),
            ..
        } = &mut self.sink
        {
            // No JPEG, Base64 or pixel data in Tauri events. One frame is in
            // flight; the producer cannot overwrite memory until script ACKs.
            let scaled = (source.len() > crate::shared_video::CAPACITY).then(|| {
                let scale = (3840.0 / source_width as f64)
                    .min(2160.0 / source_height as f64)
                    .min(1.0);
                let width = (source_width as f64 * scale).floor().max(1.0) as u32;
                let height = (source_height as f64 * scale).floor().max(1.0) as u32;
                (
                    resize_bgra(source, source_width, source_height, width, height),
                    width,
                    height,
                )
            });
            let (pixels, width, height) = scaled
                .as_ref()
                .map(|(p, w, h)| (p.as_slice(), *w, *h))
                .unwrap_or((source, source_width, source_height));
            memory.write(pixels)?;
            if let Ok(mut time) = sent_at.lock() {
                *time = Instant::now();
            }
            waiting_for_ack.store(true, Ordering::Release);
            self.last_frame = Instant::now();
            app.emit_to(
                "main",
                "coherent:screen-frame",
                ScreenFrame {
                    capture_id: *capture_id,
                    width,
                    height,
                    jpeg: None,
                },
            )
            .map_err(|e| e.to_string())?;
            return Ok(());
        }
        let (width, height) = if matches!(&self.sink, FrameSink::Stream { .. }) {
            stream_dimensions(source_width, source_height)
        } else {
            let scale = (480.0 / source_width as f64)
                .min(270.0 / source_height as f64)
                .min(1.0);
            (
                (source_width as f64 * scale).round().max(1.0) as u32,
                (source_height as f64 * scale).round().max(1.0) as u32,
            )
        };
        let scaled = (width != source_width || height != source_height)
            .then(|| resize_bgra(source, source_width, source_height, width, height));
        let jpeg = self
            .encoder
            .encode(scaled.as_deref().unwrap_or(source), width, height)
            .map_err(|error| error.to_string())?;
        let jpeg = STANDARD.encode(jpeg);
        self.last_frame = Instant::now();

        match &mut self.sink {
            FrameSink::Preview(sender) => {
                let _ = sender.send(Ok(jpeg));
                control.stop();
            }
            FrameSink::Stream {
                app,
                capture_id,
                waiting_for_ack,
                sent_at,
                ..
            } => {
                if let Ok(mut time) = sent_at.lock() {
                    *time = Instant::now();
                }
                waiting_for_ack.store(true, Ordering::Release);
                if let Err(error) = app.emit_to(
                    "main",
                    "coherent:screen-frame",
                    ScreenFrame {
                        capture_id: *capture_id,
                        width,
                        height,
                        jpeg: Some(jpeg),
                    },
                ) {
                    waiting_for_ack.store(false, Ordering::Release);
                    return Err(error.to_string());
                }
            }
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        if let FrameSink::Stream {
            app, capture_id, ..
        } = &self.sink
        {
            let _ = app.emit_to("main", "coherent:screen-ended", *capture_id);
        }
        Ok(())
    }
}

type CaptureHandle = CaptureControl<FrameHandler, String>;

struct ActiveCapture {
    id: u64,
    handle: CaptureHandle,
}

struct PendingFrame {
    id: u64,
    waiting_for_ack: Arc<AtomicBool>,
    sent_at: Arc<Mutex<Instant>>,
}

pub struct ScreenCaptureState {
    operation: Mutex<()>,
    preview_operation: Mutex<()>,
    preview_generation: AtomicU64,
    sources: Mutex<HashMap<String, SourceItem>>,
    active: Mutex<Option<ActiveCapture>>,
    ack: Mutex<Option<PendingFrame>>,
    next_id: AtomicU64,
    borderless: AtomicBool,
    borderless_file: Option<std::path::PathBuf>,
}

impl Default for ScreenCaptureState {
    fn default() -> Self {
        Self {
            operation: Mutex::new(()),
            preview_operation: Mutex::new(()),
            preview_generation: AtomicU64::new(0),
            sources: Mutex::new(HashMap::new()),
            active: Mutex::new(None),
            ack: Mutex::new(None),
            next_id: AtomicU64::new(1),
            borderless: AtomicBool::new(false),
            borderless_file: None,
        }
    }
}

impl ScreenCaptureState {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let file = crate::diagnostics::config_directory(app)?.join("capture-borderless.json");
        let preferred = std::fs::read(&file)
            .ok()
            .and_then(|v| serde_json::from_slice::<bool>(&v).ok())
            .unwrap_or(false);
        Ok(Self {
            borderless: AtomicBool::new(preferred),
            borderless_file: Some(file),
            ..Self::default()
        })
    }
    fn save_borderless(&self, value: bool) -> Result<(), String> {
        if let Some(file) = &self.borderless_file {
            std::fs::write(file, if value { "true" } else { "false" })
                .map_err(|e| e.to_string())?;
        }
        self.borderless.store(value, Ordering::Release);
        Ok(())
    }
    pub fn stop_all(&self) -> Result<(), String> {
        let _operation = self.operation.lock().map_err(|_| "Захват недоступен")?;
        self.preview_generation.store(0, Ordering::Release);
        *self.ack.lock().map_err(|e| e.to_string())? = None;
        let active = self.active.lock().map_err(|e| e.to_string())?.take();
        if let Some(active) = active {
            active.handle.stop().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

fn start_item<T>(item: T, sink: FrameSink, borderless: bool) -> Result<CaptureHandle, String>
where
    T: TryInto<GraphicsCaptureItemType> + Send + 'static,
{
    let settings = Settings::new(
        item,
        CursorCaptureSettings::Default,
        if borderless {
            DrawBorderSettings::WithoutBorder
        } else {
            DrawBorderSettings::Default
        },
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        sink,
    );
    FrameHandler::start_free_threaded(settings).map_err(|error| error.to_string())
}

fn start_source(
    source: SourceItem,
    sink: FrameSink,
    borderless: bool,
) -> Result<CaptureHandle, String> {
    match source {
        SourceItem::Monitor(monitor) => start_item(monitor, sink, borderless),
        SourceItem::Window(window) => {
            crate::capture_windows::restore(window)?;
            start_item(window, sink, borderless)
        }
    }
}

#[tauri::command]
pub fn desktop_screen_borderless_status(state: State<'_, Arc<ScreenCaptureState>>) -> bool {
    state.borderless.load(Ordering::Acquire)
}

#[tauri::command]
pub async fn desktop_screen_borderless(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<ScreenCaptureState>>,
    enabled: bool,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("Недоступно для этого окна".into());
    }
    let allowed = if enabled {
        request_borderless().await?
    } else {
        false
    };
    state.save_borderless(allowed)?;
    Ok(allowed)
}

async fn request_borderless() -> Result<bool, String> {
    use windows::Graphics::Capture::{GraphicsCaptureAccess, GraphicsCaptureAccessKind};
    use windows::Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus;
    let operation =
        GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless).map_err(
            |_| "Windows не разрешает захват без рамки для этой установки приложения.".to_string(),
        )?;
    let status = operation
        .await
        .map_err(|_| "Не удалось получить разрешение Windows на захват без рамки.".to_string())?;
    let allowed = status == AppCapabilityAccessStatus::Allowed;
    crate::diagnostics::event(
        "screen.borderless",
        serde_json::json!({"allowed": allowed, "status": status.0}),
    );
    Ok(allowed)
}

#[tauri::command]
pub async fn desktop_screen_sources(
    state: State<'_, Arc<ScreenCaptureState>>,
) -> Result<Vec<ScreenSource>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut sources = Vec::new();
        let mut handles = HashMap::new();
        for monitor in Monitor::enumerate().map_err(|error| error.to_string())? {
            let id = format!(
                "monitor-{}",
                monitor.index().map_err(|error| error.to_string())?
            );
            sources.push(ScreenSource {
                id: id.clone(),
                name: monitor.name().unwrap_or_else(|_| "Экран".to_string()),
                kind: "monitor",
                app_name: None,
                process_id: None,
                width: monitor.width().unwrap_or(0),
                height: monitor.height().unwrap_or(0),
                minimized: false,
            });
            handles.insert(id, SourceItem::Monitor(monitor));
        }
        for source in crate::capture_windows::enumerate()? {
            let id = format!("window-{:x}", source.window.as_raw_hwnd() as usize);
            sources.push(ScreenSource {
                id: id.clone(),
                name: source.name,
                kind: "window",
                app_name: source.app_name,
                process_id: Some(source.process_id),
                width: source.width,
                height: source.height,
                minimized: source.minimized,
            });
            handles.insert(id, SourceItem::Window(source.window));
        }
        *state.sources.lock().map_err(|error| error.to_string())? = handles;
        Ok(sources)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn desktop_screen_preview(
    state: State<'_, Arc<ScreenCaptureState>>,
    source_id: String,
    request_id: u64,
) -> Result<String, String> {
    state
        .preview_generation
        .store(request_id, Ordering::Release);
    let source = *state
        .sources
        .lock()
        .map_err(|error| error.to_string())?
        .get(&source_id)
        .ok_or("Источник больше недоступен")?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _preview = state
            .preview_operation
            .lock()
            .map_err(|_| "Предпросмотр недоступен")?;
        if state.preview_generation.load(Ordering::Acquire) != request_id {
            return Err("Предпросмотр отменён".into());
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        let handle = start_source(
            source,
            FrameSink::Preview(sender),
            state.borderless.load(Ordering::Acquire),
        )?;
        let started = Instant::now();
        let result = loop {
            if state.preview_generation.load(Ordering::Acquire) != request_id {
                break Err("Предпросмотр отменён".to_string());
            }
            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(frame) => break frame,
                Err(mpsc::RecvTimeoutError::Timeout)
                    if started.elapsed() < Duration::from_secs(4) =>
                {
                    continue;
                }
                Err(error) => break Err(error.to_string()),
            }
        };
        let stopped = handle.stop().map_err(|error| error.to_string());
        stopped?;
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn desktop_screen_preview_cancel(state: State<'_, Arc<ScreenCaptureState>>, request_id: u64) {
    let _ = state.preview_generation.compare_exchange(
        request_id,
        0,
        Ordering::AcqRel,
        Ordering::Acquire,
    );
}

#[tauri::command]
pub async fn desktop_screen_start(
    app: AppHandle,
    state: State<'_, Arc<ScreenCaptureState>>,
    source_id: String,
    frame_rate: u32,
    shared_memory: Option<bool>,
) -> Result<u64, String> {
    if !(1..=60).contains(&frame_rate) {
        return Err("Недопустимая частота кадров".into());
    }
    let state = state.inner().clone();
    let source = *state
        .sources
        .lock()
        .map_err(|error| error.to_string())?
        .get(&source_id)
        .ok_or("Источник больше недоступен")?;
    if state.borderless.load(Ordering::Acquire) {
        // Revalidate remembered preference; Windows can revoke access between runs.
        let allowed = request_borderless().await.unwrap_or(false);
        state.borderless.store(allowed, Ordering::Release);
    }
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let shared = if shared_memory == Some(true) {
        let main = app
            .get_webview_window("main")
            .ok_or("Главное окно недоступно")?;
        Some(crate::shared_video::create(&main, id).await?)
    } else {
        None
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = state.operation.lock().map_err(|_| "Захват недоступен")?;
        if state.active.lock().map_err(|e| e.to_string())?.is_some() {
            return Err("Сначала остановите текущую демонстрацию".into());
        }
        crate::diagnostics::event("screen.starting", serde_json::json!({"attempt": id, "requestedFps": frame_rate, "transport": if shared.is_some() { "shared_bgra" } else { "diagnostic_jpeg" }}));
        let waiting_for_ack = Arc::new(AtomicBool::new(false));
        let sent_at = Arc::new(Mutex::new(Instant::now()));
        *state.ack.lock().map_err(|error| error.to_string())? = Some(PendingFrame {
            id,
            waiting_for_ack: waiting_for_ack.clone(),
            sent_at: sent_at.clone(),
        });
        let sink = FrameSink::Stream {
            app: app.clone(),
            capture_id: id,
            waiting_for_ack,
            sent_at,
            frame_rate,
            shared,
        };
        let handle = match start_source(source, sink, state.borderless.load(Ordering::Acquire)) {
            Ok(handle) => handle,
            Err(error) => {
                *state.ack.lock().map_err(|error| error.to_string())? = None;
                return Err(error);
            }
        };
        *state.active.lock().map_err(|error| error.to_string())? =
            Some(ActiveCapture { id, handle });
        crate::diagnostics::event("screen.active", serde_json::json!({"attempt": id}));
        std::thread::spawn({
            let state = state.clone();
            move || loop {
                std::thread::sleep(Duration::from_secs(1));
                let Ok(_operation) = state.operation.lock() else { return; };
                let finished = state.active.lock().ok().is_some_and(|active| active.as_ref().is_some_and(|capture| capture.id == id && capture.handle.is_finished()));
                let expired = match state.ack.lock() {
                    Ok(guard) => match guard.as_ref() {
                        Some(pending) if pending.id == id => {
                            pending.waiting_for_ack.load(Ordering::Acquire)
                                && pending
                                    .sent_at
                                    .lock()
                                    .is_ok_and(|sent| sent.elapsed() > Duration::from_secs(30))
                        }
                        _ => return,
                    },
                    Err(_) => return,
                };
                if !expired && !finished {
                    continue;
                }
                let active = state.active.lock().ok().and_then(|mut guard| {
                    if guard.as_ref().is_some_and(|capture| capture.id == id) {
                        guard.take()
                    } else {
                        None
                    }
                });
                if let Ok(mut guard) = state.ack.lock()
                    && guard.as_ref().is_some_and(|pending| pending.id == id) {
                        *guard = None;
                    }
                if let Some(active) = active {
                    let result = active.handle.stop();
                    crate::diagnostics::event("screen.ended", serde_json::json!({"attempt": id, "consumerTimeout": expired, "error": result.err().map(|e| e.to_string())}));
                    let _ = app.emit_to("main", "coherent:screen-ended", id);
                }
                return;
            }
        });
        Ok(id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn desktop_screen_ack(
    state: State<'_, Arc<ScreenCaptureState>>,
    capture_id: u64,
) -> Result<(), String> {
    if let Some(pending) = state
        .ack
        .lock()
        .map_err(|error| error.to_string())?
        .as_ref()
        && pending.id == capture_id
    {
        pending.waiting_for_ack.store(false, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_screen_stop(
    state: State<'_, Arc<ScreenCaptureState>>,
    capture_id: u64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = state
            .operation
            .lock()
            .map_err(|_| "Не удалось остановить демонстрацию")?;
        let active = {
            let mut guard = state.active.lock().map_err(|error| error.to_string())?;
            if guard.as_ref().is_some_and(|active| active.id == capture_id) {
                guard.take()
            } else {
                None
            }
        };
        if let Some(active) = active {
            *state.ack.lock().map_err(|error| error.to_string())? = None;
            active.handle.stop().map_err(|error| error.to_string())?;
            crate::diagnostics::event("screen.stopped", serde_json::json!({"attempt": capture_id}));
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn desktop_screen_self_check() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let monitor = Monitor::enumerate()
            .map_err(|error| error.to_string())?
            .into_iter()
            .next()
            .ok_or("Монитор не найден")?;
        let (sender, receiver) = mpsc::sync_channel(1);
        let handle = start_source(
            SourceItem::Monitor(monitor),
            FrameSink::Preview(sender),
            false,
        )?;
        let result = receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|error| error.to_string());
        let stopped = handle.stop().map_err(|error| error.to_string());
        stopped?;
        let frame = result??;
        if frame.is_empty() {
            return Err("Пустой кадр".into());
        }
        Ok("Захват экрана работает. Кадр не сохранён и никому не отправлен.".to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
