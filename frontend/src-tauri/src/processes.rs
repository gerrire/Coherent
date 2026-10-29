//! Read-only ownership and resource accounting. Never inspect command lines,
//! documents, unrelated applications, or modify the WebView2 runtime binaries.
use std::collections::{BTreeMap, BTreeSet};
use tauri::{Manager, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::*;
use windows::Win32::System::ProcessStatus::*;
use windows::Win32::System::Threading::*;
use windows::core::Interface;

struct OwnedHandle(HANDLE);
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRow {
    pid: u32,
    parent_pid: u32,
    image: String,
    kind: String,
    created_at: u64,
    private_bytes: Option<u64>,
    resident_private_bytes: Option<u64>,
    working_bytes: Option<u64>,
    cpu_ms: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMetrics {
    processes: usize,
    measured_processes: usize,
    complete: bool,
    private_bytes: u64,
    resident_private_bytes: Option<u64>,
    working_bytes: u64,
    logical_processors: usize,
    entries: Vec<ProcessRow>,
}

#[derive(Clone)]
struct SnapshotRow {
    pid: u32,
    parent: u32,
    image: String,
}

fn snapshot() -> windows::core::Result<Vec<SnapshotRow>> {
    unsafe {
        let handle = OwnedHandle(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)?);
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut rows = Vec::new();
        Process32FirstW(handle.0, &mut entry)?;
        loop {
            let end = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            rows.push(SnapshotRow {
                pid: entry.th32ProcessID,
                parent: entry.th32ParentProcessID,
                image: String::from_utf16_lossy(&entry.szExeFile[..end]),
            });
            if Process32NextW(handle.0, &mut entry).is_err() {
                break;
            }
        }
        Ok(rows)
    }
}

fn family(rows: &[SnapshotRow], root: u32, hints: &BTreeMap<u32, String>) -> BTreeSet<u32> {
    let mut ids: BTreeSet<u32> = hints.keys().copied().chain([root]).collect();
    // GetProcessInfos deliberately omits crashpad. Include owned WebView
    // descendants, while excluding other apps and any externally opened tool.
    loop {
        let before = ids.len();
        for row in rows {
            if ids.contains(&row.parent) && row.image.eq_ignore_ascii_case("msedgewebview2.exe") {
                ids.insert(row.pid);
            }
        }
        if ids.len() == before {
            return ids;
        }
    }
}

fn ticks(time: FILETIME) -> u64 {
    (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
}

fn measure(row: &SnapshotRow, kind: String) -> ProcessRow {
    let mut result = ProcessRow {
        pid: row.pid,
        parent_pid: row.parent,
        image: row.image.clone(),
        kind,
        created_at: 0,
        private_bytes: None,
        resident_private_bytes: None,
        working_bytes: None,
        cpu_ms: 0,
    };
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, row.pid)
        else {
            return result;
        };
        let handle = OwnedHandle(handle);
        let (mut created, mut exited, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        if GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user).is_ok() {
            result.created_at = ticks(created);
            result.cpu_ms = (ticks(kernel) + ticks(user)) / 10000;
        }
        let mut memory = PROCESS_MEMORY_COUNTERS_EX2 {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32,
            ..Default::default()
        };
        if GetProcessMemoryInfo(
            handle.0,
            (&mut memory as *mut PROCESS_MEMORY_COUNTERS_EX2).cast(),
            memory.cb,
        )
        .is_ok()
        {
            result.private_bytes = Some(memory.PrivateUsage as u64);
            result.resident_private_bytes = Some(memory.PrivateWorkingSetSize as u64);
            result.working_bytes = Some(memory.WorkingSetSize as u64);
        } else {
            let mut memory = PROCESS_MEMORY_COUNTERS_EX {
                cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
                ..Default::default()
            };
            if GetProcessMemoryInfo(
                handle.0,
                (&mut memory as *mut PROCESS_MEMORY_COUNTERS_EX).cast(),
                memory.cb,
            )
            .is_ok()
            {
                result.private_bytes = Some(memory.PrivateUsage as u64);
                result.working_bytes = Some(memory.WorkingSetSize as u64);
            }
        }
    }
    result
}

fn collect(
    root: u32,
    hints: BTreeMap<u32, String>,
    ownership_complete: bool,
) -> Result<ProcessMetrics, String> {
    let rows = snapshot().map_err(|e| e.to_string())?;
    let ids = family(&rows, root, &hints);
    let mut entries: Vec<_> = rows
        .iter()
        .filter(|row| ids.contains(&row.pid))
        .map(|row| {
            let kind = if row.pid == root {
                "native".into()
            } else {
                hints
                    .get(&row.pid)
                    .cloned()
                    .unwrap_or_else(|| "runtime-helper".into())
            };
            measure(row, kind)
        })
        .collect();
    let root_created = entries
        .iter()
        .find(|entry| entry.pid == root)
        .ok_or("Процесс клиента завершился")?
        .created_at;
    // Ignore stale parent IDs that Windows may reuse after a process exits.
    entries.retain(|entry| {
        entry.pid == root || entry.created_at == 0 || entry.created_at >= root_created
    });
    entries.sort_by_key(|entry| (entry.pid != root, entry.kind.clone(), entry.pid));
    let measured = entries
        .iter()
        .filter(|row| row.private_bytes.is_some())
        .count();
    Ok(ProcessMetrics {
        processes: entries.len(),
        measured_processes: measured,
        complete: ownership_complete && measured == entries.len(),
        private_bytes: entries.iter().filter_map(|row| row.private_bytes).sum(),
        resident_private_bytes: entries.iter().map(|row| row.resident_private_bytes).sum(),
        working_bytes: entries.iter().filter_map(|row| row.working_bytes).sum(),
        logical_processors: std::thread::available_parallelism().map_or(1, |count| count.get()),
        entries,
    })
}

fn role(kind: COREWEBVIEW2_PROCESS_KIND) -> &'static str {
    match kind {
        COREWEBVIEW2_PROCESS_KIND_BROWSER => "browser",
        COREWEBVIEW2_PROCESS_KIND_RENDERER => "renderer",
        COREWEBVIEW2_PROCESS_KIND_GPU => "gpu",
        COREWEBVIEW2_PROCESS_KIND_UTILITY => "utility",
        COREWEBVIEW2_PROCESS_KIND_SANDBOX_HELPER => "sandbox",
        _ => "runtime-helper",
    }
}

#[tauri::command]
pub async fn desktop_process_metrics(window: WebviewWindow) -> Result<ProcessMetrics, String> {
    if window.label() != "main" {
        return Err("Недоступно для этого окна".into());
    }
    let mut hints = BTreeMap::new();
    let mut complete = true;
    for view in window.app_handle().webview_windows().into_values() {
        let (send, receive) = tokio::sync::oneshot::channel();
        if view
            .with_webview(move |native| {
                let result = unsafe {
                    (|| -> windows::core::Result<Vec<(u32, String)>> {
                        let infos = native
                            .environment()
                            .cast::<ICoreWebView2Environment8>()?
                            .GetProcessInfos()?;
                        let mut count = 0;
                        infos.Count(&mut count)?;
                        let mut ids = Vec::new();
                        for index in 0..count.min(256) {
                            let info = infos.GetValueAtIndex(index)?;
                            let mut id = 0;
                            let mut kind = COREWEBVIEW2_PROCESS_KIND::default();
                            info.ProcessId(&mut id)?;
                            info.Kind(&mut kind)?;
                            if id > 0 {
                                ids.push((id as u32, role(kind).into()));
                            }
                        }
                        Ok(ids)
                    })()
                };
                let _ = send.send(result.map_err(|e| e.to_string()));
            })
            .is_err()
        {
            complete = false;
            continue;
        }
        match tokio::time::timeout(std::time::Duration::from_secs(2), receive).await {
            Ok(Ok(Ok(ids))) => hints.extend(ids),
            _ => complete = false,
        }
    }
    tauri::async_runtime::spawn_blocking(move || collect(std::process::id(), hints, complete))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn desktop_open_runtime_tasks(window: WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Недоступно для этого окна".into());
    }
    let (send, receive) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |native| {
            let result = unsafe {
                native
                    .controller()
                    .CoreWebView2()
                    .and_then(|view| view.cast::<ICoreWebView2_6>())
                    .and_then(|view| view.OpenTaskManagerWindow())
            };
            let _ = send.send(result.map_err(|e| e.to_string()));
        })
        .map_err(|e| e.to_string())?;
    receive.await.map_err(|e| e.to_string())?
}

pub fn set_identity(identifier: &str) {
    let identifier = windows::core::HSTRING::from(identifier);
    let result =
        unsafe { windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(&identifier) };
    crate::diagnostics::event(
        "app.windows_identity",
        serde_json::json!({"applied": result.is_ok()}),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(pid: u32, parent: u32, image: &str) -> SnapshotRow {
        SnapshotRow {
            pid,
            parent,
            image: image.into(),
        }
    }
    #[test]
    fn ownership_includes_crashpad_and_excludes_other_apps_and_tools() {
        let rows = vec![
            row(1, 0, "coherent-desktop.exe"),
            row(2, 1, "msedgewebview2.exe"),
            row(3, 2, "msedgewebview2.exe"),
            row(4, 2, "taskmgr.exe"),
            row(5, 0, "msedgewebview2.exe"),
            row(6, 5, "msedgewebview2.exe"),
            row(7, 1, "node.exe"),
        ];
        assert_eq!(
            family(&rows, 1, &BTreeMap::new()),
            BTreeSet::from([1, 2, 3])
        );
        // Environment-owned browser reparented by Windows, shared between views.
        let hints = BTreeMap::from([(5, "browser".into())]);
        assert_eq!(family(&rows, 1, &hints), BTreeSet::from([1, 2, 3, 5, 6]));
    }
    #[test]
    fn native_counters_include_a_readable_host() {
        let metrics = collect(std::process::id(), BTreeMap::new(), true).unwrap();
        assert!(metrics.complete);
        assert!(metrics.private_bytes > 0);
        assert!(metrics.resident_private_bytes.is_some());
        assert_eq!(metrics.entries[0].kind, "native");
        assert!(metrics.entries[0].created_at > 0);
    }
    #[test]
    fn inspect_existing_client_when_requested() {
        let Ok(root) = std::env::var("COHERENT_QA_PROCESS_ID") else {
            return;
        };
        let metrics = collect(root.parse().unwrap(), BTreeMap::new(), true).unwrap();
        assert!(metrics.processes > 1);
        assert!(metrics.complete);
        assert!(
            metrics
                .entries
                .iter()
                .all(|row| row.image.eq_ignore_ascii_case("coherent-desktop.exe")
                    || row.image.eq_ignore_ascii_case("msedgewebview2.exe"))
        );
        println!("{}", serde_json::to_string(&metrics).unwrap());
    }
}
