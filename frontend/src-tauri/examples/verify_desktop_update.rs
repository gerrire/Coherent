//! Local artifact verification with the same minisign library as Tauri Updater.
//! No network requests, private keys or installer execution.
use base64::{Engine, engine::general_purpose::STANDARD};
use minisign_verify::{PublicKey, Signature};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let installer = std::env::args().nth(1).ok_or("pass the installer path")?;
    let config: serde_json::Value = serde_json::from_slice(&std::fs::read("tauri.conf.json")?)?;
    let public = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("missing public key")?;
    let public = String::from_utf8(STANDARD.decode(public)?)?;
    let signature = std::fs::read_to_string(format!("{installer}.sig"))?;
    let signature = String::from_utf8(STANDARD.decode(signature.trim())?)?;
    let public = PublicKey::decode(&public)?;
    let signature = Signature::decode(&signature)?;
    let mut data = std::fs::read(installer)?;
    public.verify(&data, &signature, true)?;
    let signed_version = signature
        .trusted_comment()
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"));
    if signed_version != config["version"].as_str() {
        return Err("signed version mismatch".into());
    }
    if data.is_empty() {
        return Err("empty installer".into());
    }
    data[0] ^= 1;
    if public.verify(&data, &signature, true).is_ok() {
        return Err("tampered installer was accepted".into());
    }
    println!(
        "Installer signature and signed package version verified. Tampered installer rejected."
    );
    Ok(())
}
