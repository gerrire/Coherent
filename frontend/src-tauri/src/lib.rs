mod audio;
mod network;

use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .invoke_handler(tauri::generate_handler![
      network::api_initialize_csrf,
      network::api_request,
      network::events_connect,
      network::events_disconnect,
      audio::start_system_audio,
      audio::stop_system_audio,
    ])
    .setup(|app| {
      app.manage(Arc::new(network::NetworkState::new(app.handle())?));
      app.manage(audio::AudioState::default());
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
