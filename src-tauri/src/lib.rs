use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tokio::sync::oneshot;

const KEYRING_SERVICE: &str = "dev.reqoon.app";

/// Set once the UI has had its chance to save; after that closing/quitting goes through.
static EXITING: AtomicBool = AtomicBool::new(false);

/// Asks the UI to write pending state (debounced saves, keychain vault) before the app goes away.
/// The UI answers with `exit_app`; if it doesn't within a couple of seconds, exit anyway.
fn request_flush(app: &AppHandle) {
    if app.emit("reqoon://flush-before-exit", ()).is_err() {
        EXITING.store(true, Ordering::SeqCst);
        app.exit(0);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        EXITING.store(true, Ordering::SeqCst);
        app.exit(0);
    });
}

/// The standard menu, plus "Settings…" (⌘,) in the macOS application menu, where Mac apps keep it.
fn app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let menu = tauri::menu::Menu::default(app)?;
    #[cfg(target_os = "macos")]
    if let Some(tauri::menu::MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        // Default items: About, separator, Services, ... — put Settings right after About.
        let settings = tauri::menu::MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
        app_menu.insert(&settings, 2)?;
        app_menu.insert(&tauri::menu::PredefinedMenuItem::separator(app)?, 3)?;
    }
    Ok(menu)
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    EXITING.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[derive(Default)]
struct InFlight(Mutex<HashMap<String, oneshot::Sender<()>>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpRequest {
    id: String,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    timeout_ms: Option<u64>,
    no_compression: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HttpResponse {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body: String,
    size: usize,
    time_ms: f64,
}

/// The UI sends User-Agent and Accept-Encoding itself (collection settings can change or drop
/// them), so the client adds no User-Agent. The plain client is for requests that turned
/// Accept-Encoding off: without it reqwest would add its own and negotiate compression anyway.
fn client(compression: bool) -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    static PLAIN: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if compression {
        CLIENT.get_or_init(|| reqwest::Client::builder().build().expect("http client"))
    } else {
        PLAIN.get_or_init(|| {
            reqwest::Client::builder()
                .no_gzip()
                .no_brotli()
                .no_deflate()
                .build()
                .expect("http client")
        })
    }
}

#[tauri::command]
async fn send_request(req: HttpRequest, inflight: State<'_, InFlight>) -> Result<HttpResponse, String> {
    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    let mut builder = client(!req.no_compression.unwrap_or(false)).request(method, &req.url);
    for (k, v) in &req.headers {
        builder = builder.header(k, v);
    }
    if let Some(body) = req.body {
        builder = builder.body(body);
    }
    builder = builder.timeout(Duration::from_millis(req.timeout_ms.unwrap_or(60_000)));

    let (tx, rx) = oneshot::channel();
    inflight.0.lock().unwrap().insert(req.id.clone(), tx);

    let start = Instant::now();
    let result = tokio::select! {
        r = async {
            let resp = builder.send().await?;
            let status = resp.status();
            let headers = resp
                .headers()
                .iter()
                .map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
                .collect::<Vec<_>>();
            let bytes = resp.bytes().await?;
            Ok::<_, reqwest::Error>((status, headers, bytes))
        } => r.map_err(|e| describe_error(&e)),
        _ = rx => Err("Request cancelled".to_string()),
    };
    inflight.0.lock().unwrap().remove(&req.id);

    let (status, headers, bytes) = result?;
    Ok(HttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        size: bytes.len(),
        body: String::from_utf8_lossy(&bytes).into_owned(),
        time_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
}

fn describe_error(e: &reqwest::Error) -> String {
    use std::error::Error;
    let mut msg = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        msg.push_str(": ");
        msg.push_str(&s.to_string());
        src = s.source();
    }
    msg
}

#[tauri::command]
fn cancel_request(id: String, inflight: State<'_, InFlight>) {
    if let Some(tx) = inflight.0.lock().unwrap().remove(&id) {
        let _ = tx.send(());
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileContent {
    content: String,
    modified_ms: u64,
}

#[tauri::command]
fn read_text_file(path: String) -> Result<FileContent, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(FileContent { content, modified_ms })
}

#[tauri::command]
fn file_modified(path: String) -> Result<u64, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0))
}

fn state_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid state name".into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{name}.json")))
}

#[tauri::command]
fn load_state(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let path = state_path(&app, &name)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn save_state(app: AppHandle, name: String, content: String) -> Result<(), String> {
    let path = state_path(&app, &name)?;
    // Write to a temp file and rename so a crash mid-write never corrupts saved data.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(InFlight::default())
        .invoke_handler(tauri::generate_handler![
            send_request,
            cancel_request,
            read_text_file,
            file_modified,
            load_state,
            save_state,
            secret_get,
            secret_set,
            secret_delete,
            exit_app
        ])
        .menu(app_menu)
        .on_menu_event(|app, event| {
            if event.id() == "settings" {
                let _ = app.emit("reqoon://menu", "settings");
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !EXITING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    request_flush(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running Reqoon")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, .. } = event {
                // With no window left there is no UI to flush; let it go.
                if !EXITING.load(Ordering::SeqCst) && !app.webview_windows().is_empty() {
                    api.prevent_exit();
                    request_flush(app);
                }
            }
        });
}
