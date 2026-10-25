//! Read-only local QA. Never prints document/window titles.
#[allow(dead_code)]
#[path = "../src/capture_windows.rs"]
mod capture_windows;

fn main() -> Result<(), String> {
    let sources = capture_windows::enumerate()?;
    println!("{}", serde_json::to_string_pretty(&sources.iter().map(|source| serde_json::json!({
        "app": source.app_name, "width": source.width, "height": source.height, "minimized": source.minimized,
    })).collect::<Vec<_>>()).map_err(|error| error.to_string())?);
    Ok(())
}
