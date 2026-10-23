use base64::{Engine, engine::general_purpose::STANDARD};
use std::ffi::c_void;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tokio::task::JoinHandle;

unsafe extern "C" {
    fn coherent_loopback_start(
        callback: extern "C" fn(*const i16, u32, i32, *mut c_void),
        context: *mut c_void,
    ) -> *mut c_void;
    fn coherent_loopback_stop(capture: *mut c_void);
}

enum Packet {
    Samples(Vec<i16>),
    Error(i32),
}

extern "C" fn receive_packet(data: *const i16, frames: u32, error: i32, context: *mut c_void) {
    if context.is_null() { return; }
    let sender = unsafe { &*(context as *const UnboundedSender<Packet>) };
    if error != 0 {
        let _ = sender.send(Packet::Error(error));
    } else if !data.is_null() && frames > 0 {
        let samples = unsafe { std::slice::from_raw_parts(data, frames as usize * 2) };
        let _ = sender.send(Packet::Samples(samples.to_vec()));
    }
}

struct Capture {
    native: *mut c_void,
    context: *mut UnboundedSender<Packet>,
    pump: JoinHandle<()>,
}

// The native capture thread stops and joins before its callback context is freed.
unsafe impl Send for Capture {}

impl Drop for Capture {
    fn drop(&mut self) {
        unsafe {
            coherent_loopback_stop(self.native);
            drop(Box::from_raw(self.context));
        }
        self.pump.abort();
    }
}

#[derive(Default)]
pub struct AudioState(Mutex<Option<Capture>>);

#[tauri::command]
pub fn start_system_audio(app: AppHandle, state: State<'_, AudioState>) -> Result<(), String> {
    let mut capture = state.0.lock().map_err(|e| e.to_string())?;
    if capture.is_some() { return Ok(()); }
    let (sender, mut receiver) = unbounded_channel();
    let context = Box::into_raw(Box::new(sender));
    let native = unsafe { coherent_loopback_start(receive_packet, context.cast()) };
    if native.is_null() {
        unsafe { drop(Box::from_raw(context)); }
        return Err("Не удалось запустить захват системного звука.".into());
    }
    let pump = tokio::spawn(async move {
        while let Some(packet) = receiver.recv().await {
            match packet {
                Packet::Samples(samples) => {
                    let bytes = unsafe {
                        std::slice::from_raw_parts(samples.as_ptr().cast::<u8>(), samples.len() * 2)
                    };
                    let _ = app.emit("coherent:system-audio", STANDARD.encode(bytes));
                }
                Packet::Error(code) => {
                    let _ = app.emit("coherent:system-audio-error",
                        format!("Системный звук Windows недоступен (0x{:08x}).", code as u32));
                    break;
                }
            }
        }
    });
    *capture = Some(Capture { native, context, pump });
    Ok(())
}

#[tauri::command]
pub fn stop_system_audio(state: State<'_, AudioState>) -> Result<(), String> {
    let old = state.0.lock().map_err(|e| e.to_string())?.take();
    drop(old);
    Ok(())
}
