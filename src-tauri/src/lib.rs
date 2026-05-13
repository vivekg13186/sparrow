// Sparrow — Tauri entry point.
//
// Builds the application, registers dialog/fs plugins, sets up a per-app
// terminal session manager backed by `portable-pty`, constructs the native
// File + Tools menus, and forwards menu clicks to the frontend.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Emitter, Manager, State,
};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// ---------------------------------------------------------------------------
// Terminal session management
// ---------------------------------------------------------------------------
//
// Each `terminal_spawn` call opens a PTY, launches the user's shell against
// it, and records the master end + child handle so we can later write input,
// resize, or kill it. A dedicated reader thread per session forwards PTY
// output to the frontend as Tauri events.
//
// Events emitted per session id:
//   terminal://<id>/data  — payload: Vec<u8> (raw PTY output chunk)
//   terminal://<id>/exit  — payload: ()      (PTY closed / process exited)

struct TermSession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
struct TerminalSessions(Mutex<HashMap<String, TermSession>>);

static TERM_COUNTER: AtomicU64 = AtomicU64::new(1);

#[tauri::command]
fn terminal_spawn(
    sessions: State<'_, TerminalSessions>,
    app: AppHandle,
    rows: u16,
    cols: u16,
) -> Result<String, String> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // Pick the user's preferred shell.
    //
    // Resolution order:
    //   1. SPARROW_SHELL — explicit override (lets users opt into
    //      PowerShell / pwsh / zsh / fish without touching their
    //      system-wide login shell).
    //   2. The OS-conventional env var (COMSPEC on Windows, SHELL
    //      everywhere else).
    //   3. A platform-sane default so the spawn doesn't fail blank.
    let shell = std::env::var("SPARROW_SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            if cfg!(windows) {
                std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
            } else {
                std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
            }
        });
    let mut cmd = CommandBuilder::new(shell);
    if let Ok(cwd) = std::env::current_dir() {
        cmd.cwd(cwd);
    }
    // Hint to apps like git/less that we have a real terminal.
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;
    // The slave side is no longer needed in the parent process.
    drop(pair.slave);

    let id = format!("term-{}", TERM_COUNTER.fetch_add(1, Ordering::SeqCst));

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Spawn the reader thread. It owns the read half of the PTY and pushes
    // every chunk to the frontend as a binary `data` event.
    let app_clone = app.clone();
    let id_for_thread = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = buf[..n].to_vec();
                    let _ = app_clone
                        .emit(&format!("terminal://{}/data", id_for_thread), chunk);
                }
                Err(_) => break,
            }
        }
        let _ = app_clone.emit::<()>(&format!("terminal://{}/exit", id_for_thread), ());
    });

    sessions.0.lock().unwrap().insert(
        id.clone(),
        TermSession {
            writer,
            master: pair.master,
            child,
        },
    );
    Ok(id)
}

#[tauri::command]
fn terminal_write(
    sessions: State<'_, TerminalSessions>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut map = sessions.0.lock().unwrap();
    let s = map.get_mut(&session_id).ok_or("no such session")?;
    s.writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn terminal_resize(
    sessions: State<'_, TerminalSessions>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let map = sessions.0.lock().unwrap();
    let s = map.get(&session_id).ok_or("no such session")?;
    s.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn terminal_kill(
    sessions: State<'_, TerminalSessions>,
    session_id: String,
) -> Result<(), String> {
    let mut map = sessions.0.lock().unwrap();
    if let Some(mut s) = map.remove(&session_id) {
        let _ = s.child.kill();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// HTTP client (for .http files)
// ---------------------------------------------------------------------------
//
// A single command — `send_http_request` — takes a parsed request from the
// frontend, fires it off via reqwest, and returns the full response. This is
// what backs the "Send Request" button on .http tabs (a Sparrow-native
// equivalent of the VS Code REST Client extension).

#[derive(serde::Deserialize)]
struct HttpRequestInput {
    method: String,
    url: String,
    /// Header pairs preserved in order so duplicates (e.g. multiple
    /// Set-Cookie or Cache-Control values) round-trip correctly.
    headers: Vec<(String, String)>,
    body: Option<String>,
    /// Optional request timeout in milliseconds. Defaults to 30 s.
    timeout_ms: Option<u64>,
}

#[derive(serde::Serialize)]
struct HttpResponseOutput {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body: String,
    duration_ms: u128,
    content_type: Option<String>,
    size_bytes: usize,
    /// True when the response body wasn't valid UTF-8 and was lossily decoded.
    /// The UI can hint at this so users don't get confused by replacement chars.
    body_was_lossy: bool,
}

#[tauri::command]
async fn send_http_request(
    input: HttpRequestInput,
) -> Result<HttpResponseOutput, String> {
    let timeout = std::time::Duration::from_millis(input.timeout_ms.unwrap_or(30_000));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;

    let method = reqwest::Method::from_bytes(input.method.to_uppercase().as_bytes())
        .map_err(|e| format!("invalid method: {}", e))?;

    let mut req = client.request(method, &input.url);
    for (k, v) in &input.headers {
        req = req.header(k, v);
    }
    if let Some(body) = input.body {
        req = req.body(body);
    }

    let start = std::time::Instant::now();
    let res = req.send().await.map_err(|e| e.to_string())?;

    let status = res.status().as_u16();
    let status_text = res
        .status()
        .canonical_reason()
        .unwrap_or("")
        .to_string();
    let headers: Vec<(String, String)> = res
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    let size_bytes = bytes.len();
    let (body, body_was_lossy) = match std::str::from_utf8(&bytes) {
        Ok(s) => (s.to_string(), false),
        Err(_) => (String::from_utf8_lossy(&bytes).to_string(), true),
    };
    let duration_ms = start.elapsed().as_millis();

    Ok(HttpResponseOutput {
        status,
        status_text,
        headers,
        body,
        duration_ms,
        content_type,
        size_bytes,
        body_was_lossy,
    })
}

// ---------------------------------------------------------------------------
// Python script action runner
// ---------------------------------------------------------------------------
//
// Spawns a Python interpreter against a user-picked `.py` file:
//   - extra args are appended to argv (after the script path)
//   - the active editor's selection (or whole file) is piped to stdin
//   - SPARROW_* env vars expose context (file path, dir, language, etc.)
//   - whatever the script writes to stdout is returned; the frontend uses
//     it to replace the selection it captured, giving us a clean "Unix
//     filter" workflow for formatting / replacing / transforming text.

#[derive(serde::Deserialize)]
struct RunPythonInput {
    script_path: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    stdin: String,
    cwd: Option<String>,
}

#[derive(serde::Serialize)]
struct RunPythonOutput {
    stdout: String,
    stderr: String,
    exit_code: i32,
    duration_ms: u128,
}

/// Pick a Python interpreter the user actually has on PATH.
///
/// Resolution order:
///   1. `$SPARROW_PYTHON` (explicit override — wins always).
///   2. The first of `python3`, `python` that successfully responds
///      to `--version`. Both are tried because:
///        - Linux/macOS distros vary: `python` may be 2.7, 3, or
///          absent entirely; `python3` is the modern default.
///        - Windows installs Python 3.x as both `python` and
///          `python3` since the Microsoft Store package, but
///          `python3` is sometimes a redirect stub if the user
///          hasn't picked an interpreter yet.
///   3. Fall back to a platform-sane default so the caller still
///      gets a sensible error message ("python3: not found") rather
///      than silently doing nothing.
fn resolve_python() -> String {
    use std::process::{Command, Stdio};
    if let Ok(v) = std::env::var("SPARROW_PYTHON") {
        let v = v.trim();
        if !v.is_empty() {
            return v.to_string();
        }
    }
    for candidate in &["python3", "python"] {
        let ok = Command::new(candidate)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return (*candidate).to_string();
        }
    }
    if cfg!(windows) {
        "python".into()
    } else {
        "python3".into()
    }
}

#[tauri::command]
fn run_python_action(input: RunPythonInput) -> Result<RunPythonOutput, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let start = std::time::Instant::now();

    let python = resolve_python();

    let mut cmd = Command::new(&python);
    cmd.arg(&input.script_path);
    for a in &input.args {
        cmd.arg(a);
    }
    for (k, v) in &input.env {
        cmd.env(k, v);
    }
    if let Some(cwd) = &input.cwd {
        if !cwd.is_empty() {
            cmd.current_dir(cwd);
        }
    }
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start `{}`: {}", python, e))?;

    // Pipe stdin. Drop the handle when done — that closes the write end so
    // the script's stdin EOFs.
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input.stdin.as_bytes())
            .map_err(|e| format!("writing to stdin: {}", e))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("waiting on process: {}", e))?;

    Ok(RunPythonOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
        duration_ms: start.elapsed().as_millis(),
    })
}

// ---------------------------------------------------------------------------
// AI assist (chat completion against OpenAI or Anthropic)
// ---------------------------------------------------------------------------
//
// Single command `ai_complete` that fans out to the configured provider. The
// frontend stores the API key and model in localStorage and forwards them
// along with the request; the Rust side just makes the HTTP call so we can
// keep keys off the network until the user explicitly asks for a completion.

#[derive(serde::Deserialize)]
struct AiCompleteInput {
    /// "openai" | "anthropic"
    provider: String,
    api_key: String,
    model: String,
    /// Full user prompt — the frontend is responsible for stitching the
    /// selected text and the user's instruction together.
    prompt: String,
    system: Option<String>,
    max_tokens: Option<u32>,
}

#[derive(serde::Serialize)]
struct AiCompleteOutput {
    text: String,
    duration_ms: u128,
}

#[tauri::command]
async fn ai_complete(input: AiCompleteInput) -> Result<AiCompleteOutput, String> {
    let start = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let text = match input.provider.as_str() {
        "openai" => call_openai(&client, &input).await?,
        "anthropic" => call_anthropic(&client, &input).await?,
        other => return Err(format!("unknown AI provider: {}", other)),
    };

    Ok(AiCompleteOutput {
        text,
        duration_ms: start.elapsed().as_millis(),
    })
}

async fn call_openai(
    client: &reqwest::Client,
    input: &AiCompleteInput,
) -> Result<String, String> {
    let system = input
        .system
        .as_deref()
        .unwrap_or("You are a helpful AI assistant.");
    let body = serde_json::json!({
        "model": input.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user",   "content": input.prompt }
        ],
        "max_tokens": input.max_tokens.unwrap_or(2048),
    });
    let res = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(&input.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("OpenAI {}: {}", status, body));
    }
    let parsed: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let text = parsed
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    Ok(text)
}

async fn call_anthropic(
    client: &reqwest::Client,
    input: &AiCompleteInput,
) -> Result<String, String> {
    let system = input
        .system
        .as_deref()
        .unwrap_or("You are a helpful AI assistant.");
    let body = serde_json::json!({
        "model": input.model,
        "max_tokens": input.max_tokens.unwrap_or(2048),
        "system": system,
        "messages": [
            { "role": "user", "content": input.prompt }
        ],
    });
    let res = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &input.api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Anthropic {}: {}", status, body));
    }
    let parsed: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    // Anthropic returns content as an array of typed blocks; concat all
    // text blocks (most responses have exactly one).
    let text = parsed
        .get("content")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    Ok(text)
}

// ---------------------------------------------------------------------------
// File-system browsing (for the in-app File Explorer tab)
// ---------------------------------------------------------------------------
//
// We expose two small commands the frontend uses to drive the explorer:
//   - `list_directory(path)` returns the immediate children of `path`,
//     sorted directories-first then alphabetically (case-insensitive).
//   - `path_parent(path)`    returns the parent path, or null at the root.
//
// Doing this in Rust (rather than through tauri-plugin-fs) keeps us out of
// per-directory scope rules — the user-picked folder dictates what's
// readable, and we just enumerate it.

#[derive(serde::Serialize)]
struct FsEntry {
    name: String,
    path: String,
    is_dir: bool,
    /// File size in bytes (None for directories or unstattable entries).
    size: Option<u64>,
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<FsEntry>, String> {
    let read = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in read.flatten() {
        // Skip entries we can't stat — broken symlinks, permission denied,
        // etc. — so a single bad child doesn't blow up the whole listing.
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        out.push(FsEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: metadata.is_dir(),
            size: if metadata.is_file() {
                Some(metadata.len())
            } else {
                None
            },
        });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

#[tauri::command]
fn path_parent(path: String) -> Option<String> {
    std::path::PathBuf::from(&path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
}

// ---------------------------------------------------------------------------
// App bootstrap
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(TerminalSessions::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_kill,
            send_http_request,
            list_directory,
            path_parent,
            ai_complete,
            run_python_action,
        ])
        .setup(|app| {
            // --- File menu ---
            let new_item = MenuItemBuilder::with_id("new", "New")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;
            let open_item = MenuItemBuilder::with_id("open", "Open...")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let save_item = MenuItemBuilder::with_id("save", "Save")
                .accelerator("CmdOrCtrl+S")
                .build(app)?;
            let save_as_item = MenuItemBuilder::with_id("save_as", "Save As...")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?;
            let check_updates_item =
                MenuItemBuilder::with_id("check_updates", "Check for Updates…")
                    .build(app)?;
            let next_tab_item = MenuItemBuilder::with_id("next_tab", "Next Tab")
                .accelerator("Ctrl+Tab")
                .build(app)?;
            let prev_tab_item =
                MenuItemBuilder::with_id("prev_tab", "Previous Tab")
                    .accelerator("Ctrl+Shift+Tab")
                    .build(app)?;
            let close_tab_item = MenuItemBuilder::with_id("close_tab", "Close Tab")
                .accelerator("CmdOrCtrl+W")
                .build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?;

            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&new_item)
                .item(&open_item)
                .separator()
                .item(&save_item)
                .item(&save_as_item)
                .separator()
                .item(&next_tab_item)
                .item(&prev_tab_item)
                .item(&close_tab_item)
                .separator()
                .item(&check_updates_item)
                .separator()
                .item(&quit_item)
                .build()?;

            // --- Edit menu ---
            // The std actions (undo/redo/cut/copy/paste/select all) use
            // Tauri's predefined items. On macOS these become the Cocoa Edit
            // menu items; on Windows/Linux they dispatch standard accelerators.
            // Monaco picks them up automatically when the editor is focused.
            let undo_item = PredefinedMenuItem::undo(app, None)?;
            let redo_item = PredefinedMenuItem::redo(app, None)?;
            let cut_item = PredefinedMenuItem::cut(app, None)?;
            let copy_item = PredefinedMenuItem::copy(app, None)?;
            let paste_item = PredefinedMenuItem::paste(app, None)?;
            // Select All goes through our menu event so Monaco's
            // `editor.action.selectAll` runs directly. Monaco doesn't render
            // into a normal contenteditable, so the OS-level `selectAll:`
            // action that PredefinedMenuItem::select_all dispatches lands
            // on Monaco's hidden input textarea instead of the visible
            // buffer — hence selects nothing.
            //
            // No accelerator here on purpose: Monaco already binds Cmd/Ctrl+A
            // when the editor is focused, and registering it at the menu
            // level would steal the shortcut from textareas / inputs
            // elsewhere in the app.
            let select_all_item =
                MenuItemBuilder::with_id("select_all", "Select All").build(app)?;

            // Find/Replace/Go-to-Line are Monaco-specific — we emit menu
            // events and the frontend runs the matching editor action.
            let find_item = MenuItemBuilder::with_id("find", "Find")
                .accelerator("CmdOrCtrl+F")
                .build(app)?;
            let replace_item = MenuItemBuilder::with_id("replace", "Replace")
                .accelerator("CmdOrCtrl+H")
                .build(app)?;
            let goto_line_item = MenuItemBuilder::with_id("goto_line", "Go to Line…")
                .accelerator("CmdOrCtrl+G")
                .build(app)?;
            let format_doc_item = MenuItemBuilder::with_id("format_document", "Format Document")
                .accelerator("Shift+Alt+F")
                .build(app)?;
            let format_sel_item = MenuItemBuilder::with_id("format_selection", "Format Selection")
                .accelerator("CmdOrCtrl+K CmdOrCtrl+F")
                .build(app)?;

            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .item(&undo_item)
                .item(&redo_item)
                .separator()
                .item(&cut_item)
                .item(&copy_item)
                .item(&paste_item)
                .item(&select_all_item)
                .separator()
                .item(&find_item)
                .item(&replace_item)
                .item(&goto_line_item)
                .separator()
                .item(&format_doc_item)
                .item(&format_sel_item)
                .build()?;

            // --- Tools menu ---
            let terminal_item = MenuItemBuilder::with_id("terminal", "Terminal")
                .accelerator("CmdOrCtrl+T")
                .build(app)?;
            let file_explorer_item =
                MenuItemBuilder::with_id("file_explorer", "File Explorer")
                    .accelerator("CmdOrCtrl+Shift+E")
                    .build(app)?;
            let ai_assist_item = MenuItemBuilder::with_id("ai_assist", "AI Assist")
                .accelerator("CmdOrCtrl+Shift+A")
                .build(app)?;
            let ai_settings_item =
                MenuItemBuilder::with_id("ai_settings", "AI Settings…").build(app)?;
            let save_snippet_item =
                MenuItemBuilder::with_id("save_snippet", "Save Selection as Snippet")
                    .build(app)?;
            let snippets_item =
                MenuItemBuilder::with_id("snippets", "Snippets…").build(app)?;
            let quick_actions_item =
                MenuItemBuilder::with_id("quick_actions", "Quick Actions…")
                    .build(app)?;
            let tools_menu = SubmenuBuilder::new(app, "Tools")
                .item(&terminal_item)
                .item(&file_explorer_item)
                .separator()
                .item(&ai_assist_item)
                .item(&ai_settings_item)
                .separator()
                .item(&save_snippet_item)
                .item(&snippets_item)
                .item(&quick_actions_item)
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&file_menu)
                .item(&edit_menu)
                .item(&tools_menu)
                .build()?;
            app.set_menu(menu)?;

            // Forward every menu click to the frontend, *including* Quit.
            // The frontend's window-close guard intercepts close requests and
            // prompts to save dirty tabs before letting the window actually
            // close — so we route Quit through `window.close()` over there
            // rather than slamming the process down with `handle.exit()`.
            let handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                let id = event.id().as_ref().to_string();
                let _ = handle.emit("menu", id);
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Fully exit the app process once the main window is
            // destroyed.
            //
            // Why this is needed: on macOS the default is to keep the
            // app alive in the Dock after the last window closes
            // (matching the standard macOS convention where Cmd+Q is
            // the "real" quit). Sparrow is single-window, so a user
            // clicking the X button or picking Discard/Save All & Quit
            // in our close-guard modal expects the whole app to go
            // away — not just the window.
            //
            // We listen for `Destroyed` (not `CloseRequested`) so the
            // JS-side close-guard gets to run first. If the user has
            // dirty tabs and hits Cancel in the modal, the window is
            // never destroyed and we never reach this branch. Once
            // the user confirms, the window destroys, this fires, and
            // the process exits cleanly.
            if let tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::Destroyed,
                ..
            } = event
            {
                app_handle.exit(0);
            }
        });
}
