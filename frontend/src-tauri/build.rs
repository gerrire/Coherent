fn main() {
  cc::Build::new()
    .cpp(true)
    .file("native/process_loopback.cpp")
    .flag_if_supported("/std:c++20")
    .define("WINVER", Some("0x0A00"))
    .define("_WIN32_WINNT", Some("0x0A00"))
    .compile("coherent_loopback");
  println!("cargo:rustc-link-lib=mmdevapi");
  println!("cargo:rustc-link-lib=ole32");
  tauri_build::build()
}
