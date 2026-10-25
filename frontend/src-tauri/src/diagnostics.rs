//! Local, bounded diagnostics. Never record media, API payloads or credentials.
use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

static LOG: OnceLock<Mutex<PathBuf>> = OnceLock::new();
const MAX_BYTES: u64 = 2 * 1024 * 1024;

pub fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

pub fn profile_directory() -> Option<PathBuf> {
    // Explicit local QA profiles keep automated tests out of the owner's session.
    std::env::var_os("COHERENT_DATA_DIR")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

pub fn initialize() {
    let directory = profile_directory()
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Coherent")))
        .map(|p| p.join("diagnostics"));
    if let Some(directory) = directory
        && fs::create_dir_all(&directory).is_ok()
    {
        let _ = LOG.set(Mutex::new(directory));
    }
    event(
        "app.start",
        json!({
            "exe": std::env::current_exe().ok(),
            "build": env!("COHERENT_BUILD_ID"),
            "package": env!("CARGO_PKG_VERSION"),
            "startedAt": timestamp_ms(),
        }),
    );
    std::panic::set_hook(Box::new(|info| {
        let message = info
            .payload()
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| info.payload().downcast_ref::<&str>().copied())
            .unwrap_or("unknown panic");
        // Append both the original panic and a possible cannot-unwind panic.
        // Overwriting last-panic.log used to destroy the first failure.
        event(
            "rust.panic",
            json!({
                "message": message,
                "location": info.location().map(|p| format!("{}:{}", p.file(), p.line())),
                "backtrace": std::backtrace::Backtrace::force_capture().to_string(),
            }),
        );
    }));
}

pub fn event(stage: &str, details: Value) {
    let Some(lock) = LOG.get() else {
        return;
    };
    let Ok(directory) = lock.lock() else {
        return;
    };
    let path = directory.join("desktop.jsonl");
    if fs::metadata(&path).is_ok_and(|m| m.len() >= MAX_BYTES) {
        let _ = fs::remove_file(directory.join("desktop.3.jsonl"));
        for index in (1..3).rev() {
            let _ = fs::rename(
                directory.join(format!("desktop.{index}.jsonl")),
                directory.join(format!("desktop.{}.jsonl", index + 1)),
            );
        }
        let _ = fs::rename(&path, directory.join("desktop.1.jsonl"));
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let record = json!({"at": timestamp_ms(), "build": env!("COHERENT_BUILD_ID"), "stage": stage, "details": details});
        let _ = writeln!(file, "{record}");
    }
}

pub fn config_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    profile_directory()
        .map(Ok)
        .unwrap_or_else(|| app.path().app_config_dir().map_err(|e| e.to_string()))
}
