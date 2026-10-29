include!("commands.rs");

fn main() {
    println!("cargo:rerun-if-env-changed=COHERENT_WINDOWS_IDENTITY_MANIFEST");
    for path in [
        "src",
        "native",
        "build.rs",
        "commands.rs",
        "permissions",
        "Cargo.lock",
        "tauri.conf.json",
        "capabilities",
        "../dist",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    let revision = std::process::Command::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .output()
        .ok()
        .filter(|r| r.status.success())
        .map(|r| String::from_utf8_lossy(&r.stdout).trim().to_string())
        .unwrap_or_else(|| "local".into());
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    println!("cargo:rustc-env=COHERENT_BUILD_ID={revision}-{timestamp}");
    cc::Build::new()
        .cpp(true)
        .file("native/process_loopback.cpp")
        .file("native/window_frame.cpp")
        .flag_if_supported("/std:c++20")
        .define("WINVER", Some("0x0A00"))
        .define("_WIN32_WINNT", Some("0x0A00"))
        .compile("coherent_loopback");
    println!("cargo:rustc-link-lib=mmdevapi");
    println!("cargo:rustc-link-lib=ole32");
    println!("cargo:rustc-link-lib=comctl32");
    println!("cargo:rustc-link-lib=dwmapi");
    let mut windows = tauri_build::WindowsAttributes::new();
    if let Some(path) = std::env::var_os("COHERENT_WINDOWS_IDENTITY_MANIFEST") {
        println!(
            "cargo:rerun-if-changed={}",
            std::path::Path::new(&path).display()
        );
        windows = windows.app_manifest(
            std::fs::read_to_string(path).expect("identity application manifest is missing"),
        );
    }
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(windows)
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("invalid desktop permission manifest");
}
