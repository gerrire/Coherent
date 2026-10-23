use futures_util::StreamExt;
use reqwest::header::{COOKIE, SET_COOKIE};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

#[derive(Default)]
struct Session {
    token: Option<String>,
    csrf_cookie: Option<String>,
    csrf_token: Option<String>,
}

pub struct NetworkState {
    client: reqwest::Client,
    base_url: String,
    session_file: PathBuf,
    session: Mutex<Session>,
    event_task: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Serialize)]
pub struct ApiReply {
    status: u16,
    body: Value,
}

impl NetworkState {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let base_url = std::env::var("COHERENT_API_BASE_URL")
            .unwrap_or_else(|_| "https://coherent-web.ru".to_string())
            .trim_end_matches('/')
            .to_string();
        if !base_url.starts_with("https://") && !base_url.starts_with("http://127.0.0.1:")
            && !base_url.starts_with("http://localhost:")
        {
            return Err("COHERENT_API_BASE_URL must use HTTPS or local development HTTP".into());
        }
        let directory = app.path().app_config_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let session_file = directory.join("session.dat");
        let token = std::fs::read(&session_file)
            .ok()
            .and_then(|bytes| unprotect(&bytes).ok())
            .and_then(|bytes| String::from_utf8(bytes).ok());
        Ok(Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|e| e.to_string())?,
            base_url,
            session_file,
            session: Mutex::new(Session { token, ..Session::default() }),
            event_task: Mutex::new(None),
        })
    }

    fn cookie_header(session: &Session) -> String {
        let mut cookies = Vec::new();
        if let Some(token) = &session.token {
            cookies.push(format!("coherent_session={token}"));
        }
        if let Some(csrf) = &session.csrf_cookie {
            cookies.push(format!("coherent_csrf={csrf}"));
        }
        cookies.join("; ")
    }

    fn update_cookies(&self, session: &mut Session, response: &reqwest::Response) -> Result<(), String> {
        for header in response.headers().get_all(SET_COOKIE) {
            let text = header.to_str().map_err(|e| e.to_string())?;
            let Some((name, value)) = text.split(';').next().and_then(|part| part.split_once('=')) else {
                continue;
            };
            let expired = text.to_ascii_lowercase().contains("max-age=0");
            match name {
                "coherent_session" => {
                    session.token = if expired || value.is_empty() { None } else { Some(value.into()) };
                    if let Some(token) = &session.token {
                        std::fs::write(&self.session_file, protect(token.as_bytes())?)
                            .map_err(|e| e.to_string())?;
                    } else if self.session_file.exists() {
                        std::fs::remove_file(&self.session_file).map_err(|e| e.to_string())?;
                    }
                }
                "coherent_csrf" => {
                    session.csrf_cookie = if expired || value.is_empty() { None } else { Some(value.into()) };
                }
                _ => {}
            }
        }
        Ok(())
    }

    async fn initialize_csrf(&self, session: &mut Session) -> Result<(), String> {
        let mut request = self.client.get(format!("{}/api/v1/auth/csrf", self.base_url));
        let cookies = Self::cookie_header(session);
        if !cookies.is_empty() {
            request = request.header(COOKIE, cookies);
        }
        let response = request.send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("CSRF request failed: {}", response.status()));
        }
        self.update_cookies(session, &response)?;
        let body: Value = response.json().await.map_err(|e| e.to_string())?;
        session.csrf_token = body.get("csrf_token").and_then(Value::as_str).map(str::to_owned);
        if session.csrf_token.is_none() || session.csrf_cookie.is_none() {
            return Err("Server did not issue a CSRF token".into());
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn api_initialize_csrf(state: State<'_, Arc<NetworkState>>) -> Result<(), String> {
    let mut session = state.session.lock().await;
    state.initialize_csrf(&mut session).await
}

#[tauri::command]
pub async fn api_request(
    state: State<'_, Arc<NetworkState>>,
    path: String,
    method: String,
    body: Option<Value>,
) -> Result<ApiReply, String> {
    if !path.starts_with("/api/v1/") || path.contains("..") || path.contains('#')
        || path.contains("\\") || path.contains("://")
    {
        return Err("Invalid API path".into());
    }
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    if !matches!(method, reqwest::Method::GET | reqwest::Method::POST | reqwest::Method::PATCH | reqwest::Method::DELETE) {
        return Err("Unsupported API method".into());
    }
    let mut session = state.session.lock().await;
    if method != reqwest::Method::GET && session.csrf_token.is_none() {
        state.initialize_csrf(&mut session).await?;
    }
    let mut request = state.client.request(method.clone(), format!("{}{}", state.base_url, path));
    let cookies = NetworkState::cookie_header(&session);
    if !cookies.is_empty() {
        request = request.header(COOKIE, cookies);
    }
    if method != reqwest::Method::GET {
        if let Some(csrf) = &session.csrf_token {
            request = request.header("X-CSRF-Token", csrf);
        }
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    state.update_cookies(&mut session, &response)?;
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let body = if bytes.is_empty() { Value::Null } else {
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())?
    };
    Ok(ApiReply { status, body })
}

#[tauri::command]
pub async fn events_connect(app: AppHandle, state: State<'_, Arc<NetworkState>>) -> Result<(), String> {
    let token = state.session.lock().await.token.clone().ok_or("Sign in before opening events")?;
    let mut task = state.event_task.lock().await;
    if let Some(old) = task.take() { old.abort(); }
    let url = state.base_url.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1)
        + "/api/v1/conversations/events";
    let origin = if state.base_url.starts_with("http://") {
        "http://localhost:5173".to_string()
    } else {
        state.base_url.clone()
    };
    *task = Some(tokio::spawn(async move {
        let result = async {
            let mut request = url.into_client_request().map_err(|e| e.to_string())?;
            request.headers_mut().insert("Origin", HeaderValue::from_str(&origin).map_err(|e| e.to_string())?);
            request.headers_mut().insert("Cookie", HeaderValue::from_str(&format!("coherent_session={token}")).map_err(|e| e.to_string())?);
            let (socket, _) = connect_async(request).await.map_err(|e| e.to_string())?;
            let _ = app.emit("coherent:event-open", ());
            let (_, mut read) = socket.split();
            while let Some(message) = read.next().await {
                match message {
                    Ok(message) if message.is_text() => {
                        let _ = app.emit("coherent:event", message.into_text().map_err(|e| e.to_string())?.to_string());
                    }
                    Ok(message) if message.is_close() => break,
                    Err(error) => return Err(error.to_string()),
                    _ => {}
                }
            }
            Ok::<(), String>(())
        }.await;
        let _ = app.emit("coherent:event-close", result.err().unwrap_or_default());
    }));
    Ok(())
}

#[tauri::command]
pub async fn events_disconnect(state: State<'_, Arc<NetworkState>>) -> Result<(), String> {
    if let Some(task) = state.event_task.lock().await.take() { task.abort(); }
    Ok(())
}

#[repr(C)]
struct DataBlob {
    size: u32,
    data: *mut u8,
}

#[link(name = "Crypt32")]
unsafe extern "system" {
    fn CryptProtectData(input: *mut DataBlob, description: *const u16, entropy: *mut DataBlob,
        reserved: *mut std::ffi::c_void, prompt: *mut std::ffi::c_void, flags: u32,
        output: *mut DataBlob) -> i32;
    fn CryptUnprotectData(input: *mut DataBlob, description: *mut *mut u16, entropy: *mut DataBlob,
        reserved: *mut std::ffi::c_void, prompt: *mut std::ffi::c_void, flags: u32,
        output: *mut DataBlob) -> i32;
}

#[link(name = "Kernel32")]
unsafe extern "system" {
    fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
}

fn crypt(data: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    let mut input = DataBlob { size: data.len() as u32, data: data.as_ptr() as *mut u8 };
    let mut output = DataBlob { size: 0, data: std::ptr::null_mut() };
    // DPAPI binds the saved session to the current Windows user.
    let ok = unsafe {
        if decrypt {
            CryptUnprotectData(&mut input, std::ptr::null_mut(), std::ptr::null_mut(),
                std::ptr::null_mut(), std::ptr::null_mut(), 0, &mut output)
        } else {
            CryptProtectData(&mut input, std::ptr::null(), std::ptr::null_mut(),
                std::ptr::null_mut(), std::ptr::null_mut(), 0, &mut output)
        }
    };
    if ok == 0 { return Err(std::io::Error::last_os_error().to_string()); }
    let bytes = unsafe { std::slice::from_raw_parts(output.data, output.size as usize).to_vec() };
    unsafe { LocalFree(output.data.cast()); }
    Ok(bytes)
}

fn protect(data: &[u8]) -> Result<Vec<u8>, String> { crypt(data, false) }
fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> { crypt(data, true) }
