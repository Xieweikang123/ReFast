use crate::app_search;
use crate::everything_search;
use crate::file_history;
use crate::hooks;
use crate::memos;
use crate::open_history;
use crate::recording::{RecordingMeta, RecordingState};
use crate::replay::ReplayState;
use crate::settings;
use crate::shortcuts;
use crate::window_config;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use regex::Regex;
use tauri::{Emitter, Manager};

static RECORDING_STATE: LazyLock<Arc<Mutex<RecordingState>>> =
    LazyLock::new(|| Arc::new(Mutex::new(RecordingState::new())));

static REPLAY_STATE: LazyLock<Arc<Mutex<ReplayState>>> =
    LazyLock::new(|| Arc::new(Mutex::new(ReplayState::new())));

pub(crate) static APP_CACHE: LazyLock<Arc<Mutex<Option<Vec<app_search::AppInfo>>>>> =
    LazyLock::new(|| Arc::new(Mutex::new(None)));

// 搜索任务管理器：管理 Everything 搜索的取消标志
// 每次新搜索会将旧搜索的取消标志设为 true，从而让旧任务尽快退出
struct SearchTaskManager {
    cancel_flag: Option<Arc<AtomicBool>>,
    current_query: Option<String>, // 当前搜索的 query，用于避免相同 query 的重复搜索
}

static SEARCH_TASK_MANAGER: LazyLock<Arc<Mutex<SearchTaskManager>>> = LazyLock::new(|| {
    Arc::new(Mutex::new(SearchTaskManager { 
        cancel_flag: None,
        current_query: None,
    }))
});

pub fn get_app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Try to use Tauri's path API first
    if let Ok(path) = app.path().app_data_dir() {
        return Ok(path);
    }

    // Fallback to environment variable on Windows
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = env::var("APPDATA") {
            let app_name = app.package_info().name.clone();
            return Ok(PathBuf::from(appdata).join(&app_name));
        }
    }

    // Fallback to current directory
    Ok(env::current_dir()
        .map_err(|e| format!("Failed to get current directory: {}", e))?
        .join("recordings"))
}

#[tauri::command]
pub fn get_recording_status() -> Result<bool, String> {
    let state = RECORDING_STATE.clone();
    let state_guard = state.lock().map_err(|e| e.to_string())?;
    Ok(state_guard.is_recording)
}

#[tauri::command]
pub fn start_recording() -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        return Err("Recording is only supported on Windows".to_string());
    }

    let state = RECORDING_STATE.clone();
    let mut state_guard = state.lock().map_err(|e| e.to_string())?;

    if state_guard.is_recording {
        // If already recording, stop and clean up first
        state_guard.stop();
        drop(state_guard);
        hooks::windows::uninstall_hooks().ok(); // Try to uninstall hooks, ignore errors
                                                // Wait a bit for hooks to fully uninstall
        std::thread::sleep(std::time::Duration::from_millis(50));
        // Get state again after cleanup
        state_guard = state.lock().map_err(|e| e.to_string())?;
    }

    // Start fresh recording
    state_guard.start();
    drop(state_guard);

    // Install Windows hooks with shared state (clone Arc to avoid move)
    hooks::windows::install_hooks(state.clone())?;

    Ok(())
}

#[tauri::command]
pub fn stop_recording(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(not(target_os = "windows"))]
    {
        return Err("Recording is only supported on Windows".to_string());
    }

    let state = RECORDING_STATE.clone();
    let mut state_guard = state.lock().map_err(|e| e.to_string())?;

    if !state_guard.is_recording {
        return Err("Not currently recording".to_string());
    }

    // Get events before stopping
    let events = state_guard.events.clone();
    let duration_ms = state_guard.get_time_offset_ms().unwrap_or(0);

    state_guard.stop();
    drop(state_guard);

    // Uninstall Windows hooks
    hooks::windows::uninstall_hooks()?;

    // Save events to JSON file
    let app_data_dir = get_app_data_dir(&app)?;
    let recordings_dir = app_data_dir.join("recordings");

    // Create recordings directory if it doesn't exist
    fs::create_dir_all(&recordings_dir)
        .map_err(|e| format!("Failed to create recordings directory: {}", e))?;

    // Generate filename with timestamp
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let filename = format!("recording_{}.json", timestamp);
    let file_path = recordings_dir.join(&filename);

    // Create recording data structure
    let recording_data = serde_json::json!({
        "events": events,
        "duration_ms": duration_ms,
        "created_at": chrono::Local::now().to_rfc3339(),
    });

    // Write to file
    let json_string = serde_json::to_string_pretty(&recording_data)
        .map_err(|e| format!("Failed to serialize recording data: {}", e))?;
    fs::write(&file_path, json_string)
        .map_err(|e| format!("Failed to write recording file: {}", e))?;

    // Return relative path for display
    Ok(format!("recordings/{}", filename))
}

#[tauri::command]
pub fn list_recordings(app: tauri::AppHandle) -> Result<Vec<RecordingMeta>, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let recordings_dir = app_data_dir.join("recordings");

    // Create directory if it doesn't exist
    if !recordings_dir.exists() {
        fs::create_dir_all(&recordings_dir)
            .map_err(|e| format!("Failed to create recordings directory: {}", e))?;
        return Ok(vec![]);
    }

    let mut recordings = Vec::new();

    // Read directory entries
    let entries = fs::read_dir(&recordings_dir)
        .map_err(|e| format!("Failed to read recordings directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        // Only process JSON files
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            if let Ok(meta) = extract_recording_meta(&path, &recordings_dir) {
                recordings.push(meta);
            }
        }
    }

    // Sort by created_at (newest first)
    recordings.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    Ok(recordings)
}

#[tauri::command]
pub fn delete_recording(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let recordings_dir = app_data_dir.join("recordings");

    // Remove "recordings/" prefix if present
    let file_path = if path.starts_with("recordings/") {
        let filename = path
            .strip_prefix("recordings/")
            .ok_or_else(|| format!("Invalid path format: {}", path))?;
        recordings_dir.join(filename)
    } else {
        recordings_dir.join(&path)
    };

    // Validate that the file exists and is within the recordings directory
    if !file_path.exists() {
        return Err(format!("Recording file not found: {}", path));
    }

    // Ensure the file is actually within the recordings directory (security check)
    if !file_path.starts_with(&recordings_dir) {
        return Err("Invalid file path: outside recordings directory".to_string());
    }

    // Delete the file
    fs::remove_file(&file_path).map_err(|e| format!("Failed to delete recording file: {}", e))?;

    Ok(())
}

fn extract_recording_meta(
    file_path: &Path,
    recordings_dir: &Path,
) -> Result<RecordingMeta, String> {
    // Read file content
    let content = fs::read_to_string(file_path)
        .map_err(|e| format!("Failed to read file {}: {}", file_path.display(), e))?;

    // Parse JSON
    let json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse JSON from {}: {}", file_path.display(), e))?;

    // Extract metadata
    let duration_ms = json["duration_ms"]
        .as_u64()
        .ok_or_else(|| format!("Missing or invalid duration_ms in {}", file_path.display()))?;

    let event_count = json["events"].as_array().map(|arr| arr.len()).unwrap_or(0);

    let created_at = json["created_at"]
        .as_str()
        .ok_or_else(|| format!("Missing or invalid created_at in {}", file_path.display()))?
        .to_string();

    // Get file name and relative path
    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("Invalid file name: {}", file_path.display()))?
        .to_string();

    let relative_path = file_path
        .strip_prefix(recordings_dir)
        .ok()
        .and_then(|p| p.to_str())
        .map(|s| format!("recordings/{}", s))
        .unwrap_or_else(|| file_name.clone());

    Ok(RecordingMeta {
        file_path: relative_path,
        file_name,
        duration_ms,
        event_count,
        created_at,
    })
}

#[tauri::command]
pub fn play_recording(app: tauri::AppHandle, path: String, speed: f32) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        return Err("Replay is only supported on Windows".to_string());
    }

    let mut state = REPLAY_STATE.lock().map_err(|e| e.to_string())?;

    if state.is_playing {
        return Err("Already playing".to_string());
    }

    // Convert relative path to absolute path
    let app_data_dir = get_app_data_dir(&app)?;
    let recordings_dir = app_data_dir.join("recordings");

    // Remove "recordings/" prefix if present
    let file_path = if path.starts_with("recordings/") {
        let filename = path
            .strip_prefix("recordings/")
            .ok_or_else(|| format!("Invalid path format: {}", path))?;
        recordings_dir.join(filename)
    } else {
        recordings_dir.join(&path)
    };

    // Validate speed - limit to reasonable range to prevent system overload
    if speed <= 0.0 || speed > 10.0 {
        return Err("Speed must be between 0.1 and 10.0".to_string());
    }

    state.load_recording(&file_path)?;

    // Check if there are any events
    if state.current_events.is_empty() {
        return Err("Recording file contains no events".to_string());
    }

    // Limit the number of events to prevent system overload
    if state.current_events.len() > 100000 {
        return Err(format!(
            "Too many events ({}). Maximum allowed is 100000.",
            state.current_events.len()
        ));
    }

    state.start(speed);

    // Start replay task in a separate thread (not async) since Windows API calls
    // should be done in a blocking context
    let replay_state = Arc::clone(&REPLAY_STATE);
    let speed_multiplier = speed.max(0.1).min(10.0); // Ensure speed is between 0.1 and 10.0

    std::thread::spawn(move || {
        let mut last_time = 0u64;
        let mut last_mouse_move_time = 0u64;
        let mut event_count = 0u64;
        const MAX_EVENTS: u64 = 100000; // Safety limit
                                        // Minimum interval between mouse move events in the recording (based on event time offset)
                                        // This helps prevent system overload from too many rapid mouse moves
        const MIN_MOUSE_MOVE_INTERVAL_MS: u64 = 5; // 5ms minimum between recorded mouse moves

        loop {
            // Check if Esc key is pressed to stop playback
            #[cfg(target_os = "windows")]
            {
                use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
                const VK_ESCAPE: i32 = 0x1B;
                unsafe {
                    // GetAsyncKeyState returns negative value if key is currently pressed
                    // The high bit (0x8000) indicates the key is currently down
                    let key_state = GetAsyncKeyState(VK_ESCAPE) as u16;
                    if key_state & 0x8000 != 0 {
                        eprintln!("Esc key pressed, stopping playback");
                        if let Ok(mut state) = replay_state.lock() {
                            state.stop();
                        }
                        break;
                    }
                }
            }

            // Safety check: prevent infinite loops
            event_count += 1;
            if event_count > MAX_EVENTS {
                eprintln!("Reached maximum event limit, stopping playback");
                if let Ok(mut state) = replay_state.lock() {
                    state.stop();
                }
                break;
            }

            // Get event while holding lock briefly
            let (event_opt, is_playing) = {
                let mut state = match replay_state.lock() {
                    Ok(s) => s,
                    Err(_) => break,
                };

                if !state.is_playing {
                    break;
                }

                let event = state.get_next_event();
                let is_playing = state.is_playing;
                (event, is_playing)
            };

            if !is_playing {
                break;
            }

            if let Some(event) = event_opt {
                // For mouse move events, only skip if the time difference from last mouse move
                // is too small (based on recorded event times, not system time)
                if matches!(event.event_type, crate::recording::EventType::MouseMove) {
                    if last_mouse_move_time > 0 {
                        let time_diff = event.time_offset_ms.saturating_sub(last_mouse_move_time);
                        // Skip only if the recorded interval is less than minimum
                        if time_diff < MIN_MOUSE_MOVE_INTERVAL_MS && time_diff > 0 {
                            // Update last_time but skip execution
                            last_time = event.time_offset_ms;
                            continue;
                        }
                    }
                    last_mouse_move_time = event.time_offset_ms;
                }

                // Calculate delay based on time offset
                let delay_ms = if last_time == 0 {
                    // First event, add a small delay to let system stabilize
                    50
                } else {
                    let diff = event.time_offset_ms.saturating_sub(last_time);
                    // Use saturating cast to prevent overflow, ensure minimum delay
                    let calculated = (diff as f32 / speed_multiplier) as u64;
                    calculated.max(1).min(60000) // Between 1ms and 60 seconds
                };

                if delay_ms > 0 {
                    std::thread::sleep(Duration::from_millis(delay_ms));
                }

                // Execute the event with error handling
                match crate::replay::ReplayState::execute_event(&event) {
                    Ok(_) => {}
                    Err(e) => {
                        eprintln!("Failed to execute event: {}", e);
                        // Continue with next event instead of crashing
                    }
                }

                last_time = event.time_offset_ms;
            } else {
                // No more events, stop playback
                if let Ok(mut state) = replay_state.lock() {
                    state.stop();
                }
                break;
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_playback() -> Result<(), String> {
    let mut state = REPLAY_STATE.lock().map_err(|e| e.to_string())?;

    if !state.is_playing {
        return Err("Not currently playing".to_string());
    }

    state.stop();
    Ok(())
}

#[tauri::command]
pub fn get_playback_status() -> Result<bool, String> {
    let state = REPLAY_STATE.lock().map_err(|e| e.to_string())?;
    Ok(state.is_playing)
}

#[tauri::command]
pub fn get_playback_progress() -> Result<f32, String> {
    let state = REPLAY_STATE.lock().map_err(|e| e.to_string())?;
    Ok(state.get_progress())
}

#[tauri::command]
pub fn scan_applications(app: tauri::AppHandle) -> Result<Vec<app_search::AppInfo>, String> {
    let cache = APP_CACHE.clone();
    let mut cache_guard = cache.lock().map_err(|e| e.to_string())?;

    // Return cached apps if available
    if let Some(ref apps) = *cache_guard {
        return Ok(apps.clone());
    }

    // Try to load from disk cache first
    let app_data_dir = get_app_data_dir(&app)?;
    if let Ok(disk_cache) = app_search::windows::load_cache(&app_data_dir) {
        if !disk_cache.is_empty() {
            *cache_guard = Some(disk_cache.clone());
            // Return cached apps immediately, no background scan
            return Ok(disk_cache);
        }
    }

    // Scan applications (synchronous, but should be fast now without .lnk parsing)
    let apps = app_search::windows::scan_start_menu()?;

    // Cache the results
    *cache_guard = Some(apps.clone());

    // Save to disk cache
    let _ = app_search::windows::save_cache(&app_data_dir, &apps);

    // No background icon extraction - icons will be extracted on-demand during search
    Ok(apps)
}

#[tauri::command]
pub fn rescan_applications(app: tauri::AppHandle) -> Result<Vec<app_search::AppInfo>, String> {
    let cache = APP_CACHE.clone();
    let mut cache_guard = cache.lock().map_err(|e| e.to_string())?;

    // Clear memory cache
    *cache_guard = None;

    // Clear disk cache
    let app_data_dir = get_app_data_dir(&app)?;
    let cache_file = app_search::windows::get_cache_file_path(&app_data_dir);
    let _ = fs::remove_file(&cache_file); // Ignore errors if file doesn't exist

    // Force rescan
    let apps = app_search::windows::scan_start_menu()?;

    // Cache the results
    *cache_guard = Some(apps.clone());

    // Save to disk cache
    let _ = app_search::windows::save_cache(&app_data_dir, &apps);

    Ok(apps)
}

#[tauri::command]
pub fn search_applications(
    query: String,
    app: tauri::AppHandle,
) -> Result<Vec<app_search::AppInfo>, String> {
    let cache = APP_CACHE.clone();
    let cache_guard = cache.lock().map_err(|e| e.to_string())?;

    let apps = cache_guard
        .as_ref()
        .ok_or_else(|| "Applications not scanned yet. Call scan_applications first.".to_string())?;

    let results = app_search::windows::search_apps(&query, apps);

    // Icons are extracted asynchronously in background - don't block search
    // This prevents UI freezing when PowerShell commands take time

    // Extract icons for top results asynchronously in background (non-blocking)
    let cache_clone = cache.clone();
    let app_handle_clone = app.clone();
    let results_paths: Vec<String> = results
        .iter()
        .take(5)
        .filter(|r| r.icon.is_none())
        .map(|r| r.path.clone())
        .collect();
    std::thread::spawn(move || {
        let mut updated = false;

        // Get current cache
        if let Ok(mut guard) = cache_clone.lock() {
            if let Some(ref mut apps) = *guard {
                // Update icons for remaining search results
                for path_str in results_paths {
                    let path = std::path::Path::new(&path_str);
                    let ext = path
                        .extension()
                        .and_then(|s| s.to_str())
                        .map(|s| s.to_lowercase());
                    let icon = if ext == Some("lnk".to_string()) {
                        app_search::windows::extract_lnk_icon_base64(path)
                    } else if ext == Some("exe".to_string()) {
                        app_search::windows::extract_icon_base64(path)
                    } else {
                        None
                    };

                    if let Some(icon) = icon {
                        // Update in cache
                        if let Some(app) = apps.iter_mut().find(|a| a.path == path_str) {
                            app.icon = Some(icon);
                            updated = true;
                        }
                    }
                }

                // Save to disk if updated
                if updated {
                    if let Ok(app_data_dir) = get_app_data_dir(&app_handle_clone) {
                        let _ = app_search::windows::save_cache(&app_data_dir, apps);
                    }
                }
            }
        }
    });

    Ok(results)
}

#[tauri::command]
pub fn launch_application(app: app_search::AppInfo) -> Result<(), String> {
    app_search::windows::launch_app(&app)
}

/// 设置 launcher 窗口位置（居中但稍微偏上）
/// 优先使用保存的位置，如果没有保存的位置则计算默认位置
fn set_launcher_window_position(window: &tauri::WebviewWindow, app_data_dir: &std::path::Path) {
    use tauri::PhysicalPosition;
    use crate::window_config;
    
    // 首先尝试加载保存的位置
    if let Some(saved_pos) = window_config::get_launcher_position(app_data_dir) {
        // 验证保存的位置是否仍然有效（在屏幕范围内）
        if let Ok(monitor) = window.primary_monitor() {
            if let Some(monitor) = monitor {
                let monitor_size = monitor.size();
                let monitor_width = monitor_size.width as i32;
                let monitor_height = monitor_size.height as i32;
                
                // 检查位置是否在屏幕范围内（允许窗口稍微超出屏幕边界）
                if saved_pos.x >= -100 && saved_pos.x <= monitor_width + 100
                    && saved_pos.y >= -100 && saved_pos.y <= monitor_height + 100
                {
                    let _ = window.set_position(PhysicalPosition::new(saved_pos.x, saved_pos.y));
                    return;
                }
            }
        }
    }
    
    // 如果没有保存的位置或位置无效，则计算默认位置（居中但稍微偏上）
    if let Ok(size) = window.outer_size() {
        let window_width = size.width as f64;
        let window_height = size.height as f64;
        
        // 获取主显示器尺寸
        if let Ok(monitor) = window.primary_monitor() {
            if let Some(monitor) = monitor {
                let monitor_size = monitor.size();
                let monitor_width = monitor_size.width as f64;
                let monitor_height = monitor_size.height as f64;
                
                // 计算居中位置，但向上偏移半个窗口高度
                let x = (monitor_width - window_width) / 2.0;
                let center_y = (monitor_height - window_height) / 2.0; // 居中位置
                let y = center_y - window_height / 2.0; // 向上移动半个窗口高度
                
                // 设置窗口位置
                let pos = PhysicalPosition::new(x as i32, y as i32);
                let _ = window.set_position(pos);
                
                // 保存这个计算出的位置作为默认位置
                let _ = window_config::save_launcher_position(app_data_dir, pos.x, pos.y);
            }
        }
    }
}

#[tauri::command]
pub fn toggle_launcher(app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    
    if let Some(window) = app.get_webview_window("launcher") {
        if window.is_visible().unwrap_or(false) {
            // 在隐藏前保存当前位置
            if let Ok(position) = window.outer_position() {
                let _ = window_config::save_launcher_position(&app_data_dir, position.x, position.y);
            }
            let _ = window.hide();
        } else {
            set_launcher_window_position(&window, &app_data_dir);
            let _ = window.show();
            let _ = window.set_focus();
        }
    } else {
        return Err("Launcher window not found".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn hide_launcher(app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    
    if let Some(window) = app.get_webview_window("launcher") {
        // 在隐藏前保存当前位置
        if let Ok(position) = window.outer_position() {
            let _ = window_config::save_launcher_position(&app_data_dir, position.x, position.y);
        }
        let _ = window.hide();
    }
    Ok(())
}

#[tauri::command]
pub fn add_file_to_history(path: String, app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;

    // Load history first to ensure it's up to date
    file_history::load_history(&app_data_dir).ok(); // Ignore errors if file doesn't exist

    file_history::add_file_path(path, &app_data_dir)?;

    Ok(())
}

#[tauri::command]
pub fn search_file_history(query: String) -> Result<Vec<file_history::FileHistoryItem>, String> {
    Ok(file_history::search_file_history(&query))
}

#[tauri::command]
#[cfg(target_os = "windows")]
pub fn search_system_folders(query: String) -> Result<Vec<SystemFolderResult>, String> {
    use crate::system_folders_search;
    Ok(system_folders_search::windows::search_system_folders(&query)
        .into_iter()
        .map(|item| SystemFolderResult {
            name: item.name,
            path: item.path,
            display_name: item.display_name,
            is_folder: item.is_folder,
        })
        .collect())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn search_system_folders(_query: String) -> Result<Vec<SystemFolderResult>, String> {
    Ok(Vec::new())
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct SystemFolderResult {
    pub name: String,
    pub path: String,
    pub display_name: String,
    pub is_folder: bool,
}

#[tauri::command]
pub fn get_all_file_history(
    app: tauri::AppHandle,
) -> Result<Vec<file_history::FileHistoryItem>, String> {
    println!("[后端] get_all_file_history: START");
    let start_time = std::time::Instant::now();

    let app_data_dir = match get_app_data_dir(&app) {
        Ok(dir) => {
            println!("[后端] get_all_file_history: App data dir = {:?}", dir);
            dir
        }
        Err(e) => {
            println!(
                "[后端] get_all_file_history: ERROR getting app data dir: {}",
                e
            );
            return Err(e);
        }
    };

    // CRITICAL: Lock only once, then do all operations within the lock
    // This prevents nested locking and potential deadlocks
    println!("[后端] get_all_file_history: Acquiring lock...");
    let mut state = match file_history::lock_history() {
        Ok(guard) => {
            println!("[后端] get_all_file_history: Lock acquired successfully");
            guard
        }
        Err(e) => {
            println!("[后端] get_all_file_history: ERROR acquiring lock: {}", e);
            return Err(e);
        }
    };

    // Load history into the locked state (no additional locking)
    println!("[后端] get_all_file_history: Loading history from disk...");
    match file_history::load_history_into(&mut state, &app_data_dir) {
        Ok(_) => {
            println!(
                "[后端] get_all_file_history: History loaded successfully, {} items in memory",
                state.len()
            );
        }
        Err(e) => {
            println!("[后端] get_all_file_history: ERROR loading history: {}", e);
            return Err(e);
        }
    }

    // Search within the locked state (no additional locking)
    println!("[后端] get_all_file_history: Searching history (empty query = all items)...");
    let result = file_history::search_in_history(&state, "");
    println!(
        "[后端] get_all_file_history: Search completed, {} items found",
        result.len()
    );

    // Lock is automatically released when state goes out of scope
    let elapsed = start_time.elapsed();
    println!("[后端] get_all_file_history: END (took {:?})", elapsed);
    Ok(result)
}

#[tauri::command]
pub fn delete_file_history(path: String, app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    file_history::load_history(&app_data_dir)?;
    file_history::delete_file_history(path, &app_data_dir)
}

#[tauri::command]
pub fn update_file_history_name(
    path: String,
    new_name: String,
    app: tauri::AppHandle,
) -> Result<file_history::FileHistoryItem, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    file_history::load_history(&app_data_dir)?;
    file_history::update_file_history_name(path, new_name, &app_data_dir)
}

// ===== Memo commands =====

#[tauri::command]
pub fn get_all_memos(app: tauri::AppHandle) -> Result<Vec<memos::MemoItem>, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    memos::get_all_memos(&app_data_dir)
}

#[tauri::command]
pub fn add_memo(
    title: String,
    content: String,
    app: tauri::AppHandle,
) -> Result<memos::MemoItem, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    memos::add_memo(title, content, &app_data_dir)
}

#[tauri::command]
pub fn update_memo(
    id: String,
    title: Option<String>,
    content: Option<String>,
    app: tauri::AppHandle,
) -> Result<memos::MemoItem, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    memos::update_memo(id, title, content, &app_data_dir)
}

#[tauri::command]
pub fn delete_memo(id: String, app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    memos::delete_memo(id, &app_data_dir)
}

#[tauri::command]
pub fn search_memos(query: String, app: tauri::AppHandle) -> Result<Vec<memos::MemoItem>, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    memos::search_memos(&query, &app_data_dir)
}

#[tauri::command]
pub async fn search_everything(
    query: String,
    app: tauri::AppHandle,
) -> Result<everything_search::EverythingSearchResponse, String> {
    #[cfg(target_os = "windows")]
    {
        // 为新搜索准备取消标志，同时通知旧搜索退出
        let cancel_flag = {
            let mut manager = SEARCH_TASK_MANAGER
                .lock()
                .map_err(|e| format!("锁定搜索管理器失败: {}", e))?;

            // 检查是否是相同 query 的重复搜索
            if let Some(ref current_query) = manager.current_query {
                if current_query == &query {
                    // query 相同，说明是重复搜索，返回错误
                    eprintln!("[RUST] Duplicate search detected for query: {}, skipping", query);
                    return Err(format!("搜索 '{}' 正在进行中，跳过重复调用", query));
                }
            }

            // 只有当 query 不同时，才取消旧搜索
            // 这样可以避免新搜索被误取消
            if let Some(old_flag) = &manager.cancel_flag {
                // 只有当 query 不同时才取消
                if manager.current_query.as_ref() != Some(&query) {
                    eprintln!("[RUST] Cancelling previous search (query: {:?}) for new search (query: {})", 
                        manager.current_query, query);
                    old_flag.store(true, Ordering::Relaxed);
                } else {
                    eprintln!("[RUST] Same query detected, not cancelling previous search: {}", query);
                }
            }

            // 为本次搜索创建新的标志，并保存下来
            // 注意：新标志初始值为 false，确保新搜索不会被误取消
            let new_flag = Arc::new(AtomicBool::new(false));
            
            // 验证新标志的初始值
            let initial_flag_value = new_flag.load(Ordering::Relaxed);
            if initial_flag_value {
                eprintln!("[RUST] ERROR: New flag initial value is true! This should never happen!");
            }
            
            // 先更新 current_query，再更新 cancel_flag，确保状态一致性
            // 这样可以避免在更新过程中，其他线程看到不一致的状态
            let old_query = manager.current_query.clone();
            manager.current_query = Some(query.clone());
            manager.cancel_flag = Some(new_flag.clone());
            
            // 再次验证新标志的值，确保在更新过程中没有被修改
            let flag_value_after_update = new_flag.load(Ordering::Relaxed);
            eprintln!("[RUST] Created new search flag for query: {} (old query: {:?}, flag value: {})", 
                query, old_query, flag_value_after_update);
            
            // 如果标志值不是 false，说明有问题
            if flag_value_after_update {
                eprintln!("[RUST] CRITICAL ERROR: New flag is true after update! This indicates a serious bug!");
            }
            
            new_flag
        };

        // 获取窗口用于发送事件
        let window = app
            .get_webview_window("launcher")
            .ok_or_else(|| "无法获取 launcher 窗口".to_string())?;

        // 在后台线程执行搜索，避免阻塞
        let query_clone = query.clone();
        let window_clone = window.clone();

        // 获取异步运行时句柄，用于在阻塞线程中发送事件
        let rt_handle = tokio::runtime::Handle::current();
        
        tokio::task::spawn_blocking(move || {
            // 创建批次回调，用于实时发送结果（仅用于进度显示）
            let on_batch = |batch_results: &[everything_search::EverythingResult], total_count: u32, current_count: u32| {
                // 在异步运行时中发送事件
                let window = window_clone.clone();
                let batch_results = batch_results.to_vec();
                let handle = rt_handle.clone();
                
                // 使用运行时句柄在阻塞线程中发送异步事件
                handle.spawn(async move {
                    // 发送增量结果事件
                    let event_data = serde_json::json!({
                        "results": batch_results,
                        "total_count": total_count,
                        "current_count": current_count,
                    });
                    if let Err(e) = window.emit("everything-search-batch", &event_data) {
                        eprintln!("[DEBUG] Failed to emit search batch event: {}", e);
                    }
                });
            };

            // Request maximum 50 results from Everything
            let result = everything_search::windows::search_files(
                &query_clone,
                50,
                Some(&cancel_flag),
                Some(on_batch),
            );

            // 无论搜索成功还是失败，都要清理 current_query
            {
                let mut manager = SEARCH_TASK_MANAGER
                    .lock()
                    .map_err(|e| format!("锁定搜索管理器失败: {}", e))?;
                // 只有当当前 query 匹配时才清理（避免清理新搜索的 query）
                if manager.current_query.as_ref() == Some(&query_clone) {
                    manager.current_query = None;
                }
            }

            let resp = result.map_err(|e| e.to_string())?;

            // 调试：确认后端实际返回了多少条结果
            eprintln!(
                "[RUST] search_everything: search_files returned {} results (total_count={})",
                resp.results.len(),
                resp.total_count
            );

            Ok(resp)
        })
        .await
        .map_err(|e| format!("搜索任务失败: {}", e))?
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Everything search is only available on Windows".to_string())
    }
}

#[tauri::command]
pub fn is_everything_available() -> bool {
    #[cfg(target_os = "windows")]
    {
        everything_search::windows::is_everything_available()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// 获取 Everything 详细状态信息
/// 返回 (是否可用, 错误代码)
#[tauri::command]
pub fn get_everything_status() -> (bool, Option<String>) {
    #[cfg(target_os = "windows")]
    {
        everything_search::windows::check_everything_status()
    }
    #[cfg(not(target_os = "windows"))]
    {
        (false, Some("NOT_WINDOWS".to_string()))
    }
}

#[tauri::command]
pub fn get_everything_path() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(path) = everything_search::windows::get_everything_path() {
            Ok(path.to_str().map(|s| s.to_string()))
        } else {
            Ok(None)
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(None)
    }
}

#[tauri::command]
pub fn get_everything_version() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        Ok(everything_search::windows::get_everything_version())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(None)
    }
}

#[tauri::command]
pub fn get_everything_log_file_path() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(path) = everything_search::windows::get_log_file_path() {
            Ok(path.to_str().map(|s| s.to_string()))
        } else {
            Ok(None)
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(None)
    }
}

#[tauri::command]
pub fn open_everything_download() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        
        // Open Everything download page in default browser
        let url = "https://www.voidtools.com/downloads/";
        
        // Convert URL to wide string (UTF-16) for Windows API
        let url_wide: Vec<u16> = OsStr::new(url)
            .encode_wide()
            .chain(Some(0))
            .collect();
        
        // Use ShellExecuteW to open URL in default browser without showing command prompt
        let result = unsafe {
            ShellExecuteW(
                0, // hwnd - no parent window
                std::ptr::null(), // lpOperation - NULL means "open"
                url_wide.as_ptr(), // lpFile - URL
                std::ptr::null(), // lpParameters
                std::ptr::null(), // lpDirectory
                1, // nShowCmd - SW_SHOWNORMAL (1)
            )
        };
        
        // ShellExecuteW returns a value > 32 on success
        if result as i32 <= 32 {
            return Err(format!("Failed to open download page: {} (error code: {})", url, result as i32));
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Everything is only available on Windows".to_string())
    }
}


#[cfg(target_os = "windows")]
fn find_everything_installation_dir() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;

    let common_paths = [
        r"C:\Program Files\Everything",
        r"C:\Program Files (x86)\Everything",
    ];

    for path in &common_paths {
        let dir_path = PathBuf::from(path);
        if dir_path.exists() {
            // Check if Everything.exe exists in this directory
            let everything_exe = dir_path.join("Everything.exe");
            if everything_exe.exists() {
                return Some(dir_path);
            }
        }
    }

    None
}

#[tauri::command]
pub async fn start_everything() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        // 在后台线程执行，避免阻塞
        tokio::task::spawn_blocking(move || {
            // 查找 Everything.exe
            let everything_exe = everything_search::windows::find_everything_main_exe()
                .ok_or_else(|| "Everything.exe 未找到，请确保 Everything 已安装".to_string())?;

            // 启动 Everything.exe
            // 如果 Everything 已配置后台运行，启动后会自动最小化到托盘
            std::process::Command::new(&everything_exe)
                .creation_flags(0x08000000) // CREATE_NO_WINDOW - 不显示控制台窗口
                .spawn()
                .map_err(|e| format!("无法启动 Everything: {}", e))?;

            // 等待 Everything 启动并初始化服务（通常需要 1-2 秒）
            std::thread::sleep(std::time::Duration::from_millis(2000));

            Ok::<(), String>(())
        })
        .await
        .map_err(|e| format!("启动任务失败: {}", e))?
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Everything 仅在 Windows 上可用".to_string())
    }
}

#[tauri::command]
pub async fn download_everything(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        use std::fs::File;
        use std::io::Write;

        // Get temp directory
        let temp_dir = std::env::temp_dir();
        let installer_path = temp_dir.join("Everything-Setup.exe");

        // Determine download URL based on system architecture
        // For now, use 64-bit version (most common)
        let download_url = "https://www.voidtools.com/Everything-1.4.1.1024.x64-Setup.exe";

        // Create HTTP client
        let client = reqwest::Client::new();
        let response = client
            .get(download_url)
            .send()
            .await
            .map_err(|e| format!("Failed to start download: {}", e))?;

        let total_size = response
            .content_length()
            .ok_or_else(|| "Failed to get content length".to_string())?;

        // Create file
        let mut file =
            File::create(&installer_path).map_err(|e| format!("Failed to create file: {}", e))?;

        let mut downloaded: u64 = 0;
        let mut stream = response.bytes_stream();

        // Use tokio stream to read chunks
        use futures_util::StreamExt;
        while let Some(item) = stream.next().await {
            let chunk = item.map_err(|e| format!("Failed to read chunk: {}", e))?;
            file.write_all(&chunk)
                .map_err(|e| format!("Failed to write chunk: {}", e))?;

            downloaded += chunk.len() as u64;

            // Emit progress event to launcher window
            let progress = (downloaded as f64 / total_size as f64 * 100.0) as u32;
            if let Some(window) = app.get_webview_window("launcher") {
                let _ = window.emit("everything-download-progress", progress);
            }
        }

        let path_str = installer_path.to_string_lossy().to_string();
        Ok(path_str)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Everything is only available on Windows".to_string())
    }
}

#[tauri::command]
pub fn check_path_exists(path: String) -> Result<Option<file_history::FileHistoryItem>, String> {
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    // Normalize path: trim whitespace and remove trailing backslashes/slashes
    let trimmed = path.trim();
    let trimmed = trimmed.trim_end_matches(|c| c == '\\' || c == '/');

    // Normalize path (convert to absolute if relative)
    let path_buf = PathBuf::from(trimmed);
    let normalized_path = if path_buf.is_absolute() {
        path_buf
    } else {
        std::env::current_dir()
            .map_err(|e| format!("Failed to get current directory: {}", e))?
            .join(&path_buf)
    };

    let normalized_path_str = normalized_path.to_string_lossy().to_string();

    // Check if path exists (file or directory)
    if !Path::new(&normalized_path_str).exists() {
        return Ok(None);
    }

    // Check if path is a directory
    let is_folder = normalized_path.is_dir();

    // Get name (file name or directory name)
    let name = normalized_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| normalized_path.to_string_lossy().to_string());

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to get timestamp: {}", e))?
        .as_secs();

    Ok(Some(file_history::FileHistoryItem {
        path: normalized_path_str,
        name,
        last_used: timestamp,
        use_count: 0,
        is_folder: Some(is_folder),
    }))
}

#[tauri::command]
pub fn get_clipboard_file_path() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;
        use std::ptr;
        use windows_sys::Win32::System::DataExchange::*;
        use windows_sys::Win32::UI::Shell::*;

        const CF_HDROP: u32 = 15; // Clipboard format for HDROP

        unsafe {
            // Open clipboard
            if OpenClipboard(0) == 0 {
                return Err("Failed to open clipboard".to_string());
            }

            let result = (|| -> Result<Option<String>, String> {
                // Get HDROP handle from clipboard
                let hdrop = GetClipboardData(CF_HDROP) as isize;
                if hdrop == 0 {
                    return Ok(None);
                }

                // Get file count - DragQueryFileW with 0xFFFFFFFF returns count
                let file_count = DragQueryFileW(hdrop, 0xFFFFFFFF, ptr::null_mut(), 0);
                if file_count == 0 {
                    return Ok(None);
                }

                // Get first file path
                let mut buffer = vec![0u16; 260]; // MAX_PATH
                let len = DragQueryFileW(hdrop, 0, buffer.as_mut_ptr(), buffer.len() as u32);
                if len == 0 {
                    return Ok(None);
                }

                buffer.truncate(len as usize);
                let path = OsString::from_wide(&buffer);
                Ok(Some(path.to_string_lossy().to_string()))
            })();

            CloseClipboard();
            result
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Clipboard file path is only supported on Windows".to_string())
    }
}

#[tauri::command]
pub fn get_clipboard_text() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;
        use windows_sys::Win32::System::DataExchange::*;
        use windows_sys::Win32::System::Memory::*;

        const CF_UNICODETEXT: u32 = 13; // Clipboard format for Unicode text

        unsafe {
            // Open clipboard
            if OpenClipboard(0) == 0 {
                return Err("Failed to open clipboard".to_string());
            }

            let result = (|| -> Result<Option<String>, String> {
                // Get clipboard data handle
                let hmem = GetClipboardData(CF_UNICODETEXT) as isize;
                if hmem == 0 {
                    return Ok(None);
                }

                // Lock the memory to get a pointer
                let ptr = GlobalLock(hmem as *mut _);
                if ptr.is_null() {
                    return Ok(None);
                }

                // Calculate the length of the string (null-terminated)
                let mut len = 0;
                let mut current = ptr as *const u16;
                while *current != 0 {
                    len += 1;
                    current = current.add(1);
                }

                // Copy the string
                let slice = std::slice::from_raw_parts(ptr as *const u16, len);
                let os_string = OsString::from_wide(slice);
                let text = os_string.to_string_lossy().to_string();

                // Unlock the memory
                GlobalUnlock(hmem as *mut _);

                Ok(Some(text))
            })();

            CloseClipboard();
            result
        }
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let output = Command::new("pbpaste")
            .output()
            .map_err(|e| format!("Failed to read clipboard: {}", e))?;
        
        if output.stdout.is_empty() {
            Ok(None)
        } else {
            String::from_utf8(output.stdout)
                .map(Some)
                .map_err(|e| format!("Failed to decode clipboard text: {}", e))
        }
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        let output = Command::new("xclip")
            .arg("-selection")
            .arg("clipboard")
            .arg("-o")
            .output()
            .map_err(|e| format!("Failed to read clipboard: {}", e))?;
        
        if output.stdout.is_empty() {
            Ok(None)
        } else {
            String::from_utf8(output.stdout)
                .map(Some)
                .map_err(|e| format!("Failed to decode clipboard text: {}", e))
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("Clipboard text reading is not supported on this platform".to_string())
    }
}

#[tauri::command]
pub fn launch_file(path: String, app: tauri::AppHandle) -> Result<(), String> {
    // Add to history when launched
    let app_data_dir = get_app_data_dir(&app)?;
    file_history::load_history(&app_data_dir).ok(); // Ignore errors
    file_history::add_file_path(path.clone(), &app_data_dir).ok(); // Ignore errors

    // Launch the file
    file_history::launch_file(&path)
}

#[tauri::command]
pub fn get_all_shortcuts(app: tauri::AppHandle) -> Result<Vec<shortcuts::ShortcutItem>, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    shortcuts::load_shortcuts(&app_data_dir)?;
    Ok(shortcuts::get_all_shortcuts())
}

#[tauri::command]
pub fn add_shortcut(
    name: String,
    path: String,
    icon: Option<String>,
    app: tauri::AppHandle,
) -> Result<shortcuts::ShortcutItem, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    shortcuts::load_shortcuts(&app_data_dir)?;
    shortcuts::add_shortcut(name, path, icon, &app_data_dir)
}

#[tauri::command]
pub fn update_shortcut(
    id: String,
    name: Option<String>,
    path: Option<String>,
    icon: Option<String>,
    app: tauri::AppHandle,
) -> Result<shortcuts::ShortcutItem, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    shortcuts::load_shortcuts(&app_data_dir)?;
    shortcuts::update_shortcut(id, name, path, icon, &app_data_dir)
}

#[tauri::command]
pub fn delete_shortcut(id: String, app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    shortcuts::load_shortcuts(&app_data_dir)?;
    shortcuts::delete_shortcut(id, &app_data_dir)
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        
        // Convert URL to wide string (UTF-16) for Windows API
        let url_wide: Vec<u16> = OsStr::new(&url)
            .encode_wide()
            .chain(Some(0))
            .collect();
        
        // Use ShellExecuteW to open URL in default browser without showing command prompt
        let result = unsafe {
            ShellExecuteW(
                0, // hwnd - no parent window
                std::ptr::null(), // lpOperation - NULL means "open"
                url_wide.as_ptr(), // lpFile - URL
                std::ptr::null(), // lpParameters
                std::ptr::null(), // lpDirectory
                1, // nShowCmd - SW_SHOWNORMAL (1)
            )
        };
        
        // ShellExecuteW returns a value > 32 on success
        if result as i32 <= 32 {
            return Err(format!("Failed to open URL: {} (error code: {})", url, result as i32));
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        // Open URL in default browser on macOS
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        // Open URL in default browser on Linux
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("URL opening is not supported on this platform".to_string())
    }
}

#[tauri::command]
pub fn reveal_in_folder(path: String) -> Result<(), String> {
    use std::path::PathBuf;
    use std::process::Command;

    // Normalize path
    let trimmed = path.trim();
    let trimmed = trimmed.trim_end_matches(|c| c == '\\' || c == '/');
    let path_buf = PathBuf::from(trimmed);

    // Get the absolute path (even if file doesn't exist, we can still open parent folder)
    let absolute_path = if path_buf.is_absolute() {
        path_buf.clone()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("Failed to get current directory: {}", e))?
            .join(&path_buf)
    };

    #[cfg(target_os = "windows")]
    {
        // Get parent directory from the path string itself (more reliable)
        // This works even if the file doesn't exist
        let parent_dir = if absolute_path.exists() {
            // If path exists, get canonical parent
            let canonical_path = absolute_path
                .canonicalize()
                .map_err(|e| format!("Failed to canonicalize path: {}", e))?;
            canonical_path
                .parent()
                .ok_or_else(|| "File has no parent directory".to_string())?
                .to_path_buf()
        } else {
            // If path doesn't exist, construct parent from path components
            absolute_path
                .parent()
                .ok_or_else(|| "File has no parent directory".to_string())?
                .to_path_buf()
        };

        // Try to canonicalize parent directory to ensure it exists
        let parent_dir = if parent_dir.exists() {
            parent_dir
                .canonicalize()
                .map_err(|e| format!("Failed to canonicalize parent directory: {}", e))?
        } else {
            // If parent doesn't exist, return error
            return Err(format!("Parent directory does not exist: {}", parent_dir.display()));
        };

        // Convert parent directory to string and normalize
        let mut parent_str = parent_dir.to_string_lossy().to_string();
        if parent_str.starts_with("\\\\?\\") {
            parent_str = parent_str[4..].to_string();
        }
        parent_str = parent_str.replace("/", "\\");

        // If file exists and is a file, use explorer /select to open folder and select file
        // Otherwise, just open the parent folder
        if absolute_path.exists() && absolute_path.is_file() {
            let mut file_path = if let Ok(canonical) = absolute_path.canonicalize() {
                canonical
            } else {
                absolute_path
            };
            
            let mut path_str = file_path.to_string_lossy().to_string();
            if path_str.starts_with("\\\\?\\") {
                path_str = path_str[4..].to_string();
            }
            path_str = path_str.replace("/", "\\");
            
            // Escape quotes in path
            let escaped_path = path_str.replace("\"", "\"\"");
            let explorer_arg = format!("/select,\"{}\"", escaped_path);
            
            // Use explorer /select to open folder and select file
            Command::new("explorer")
                .arg(&explorer_arg)
                .spawn()
                .map_err(|e| format!("Failed to execute explorer command: {}", e))?;
        } else {
            // File doesn't exist or is a directory, just open the parent folder
            Command::new("explorer")
                .arg(&parent_str)
                .spawn()
                .map_err(|e| format!("Failed to open folder: {}", e))?;
        }
    }

    #[cfg(target_os = "macos")]
    {
        // On macOS, use open with -R flag to reveal in Finder
        Command::new("open")
            .args(&["-R", trimmed])
            .spawn()
            .map_err(|e| format!("Failed to reveal in folder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // On Linux, try to open the parent directory
        if let Some(parent) = path_buf.parent() {
            Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| format!("Failed to reveal in folder: {}", e))?;
        } else {
            return Err("No parent directory found".to_string());
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        return Err("Reveal in folder is not supported on this platform".to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn show_shortcuts_config(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    println!("[后端] show_shortcuts_config: START");

    // 1. 尝试获取现有窗口
    if let Some(window) = app.get_webview_window("shortcuts-config") {
        println!("[后端] show_shortcuts_config: 窗口已存在，执行显示操作");
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        // 设置窗口始终在最前面，确保在主程序窗口前面
        window.set_always_on_top(true).map_err(|e| e.to_string())?;

        // 既然窗口没销毁，前端组件还在，需要通知它刷新数据
        let window_clone = window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            match window_clone.emit("shortcuts-config:refresh", ()) {
                Ok(_) => {
                    println!("[后端] show_shortcuts_config: Refresh event emitted successfully");
                }
                Err(e) => {
                    println!(
                        "[后端] show_shortcuts_config: ERROR emitting refresh event: {}",
                        e
                    );
                }
            }
        });
    } else {
        println!("[后端] show_shortcuts_config: 窗口不存在，开始动态创建");

        // 2. 动态创建窗口
        // 注意：这里 URL 设为 index.html，React 会根据 window label 路由到正确的组件
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "shortcuts-config",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("历史访问")
        .inner_size(700.0, 600.0)
        .resizable(true)
        .always_on_top(true)
        .center()
        .build()
        .map_err(|e| format!("创建窗口失败: {}", e))?;

        println!("[后端] show_shortcuts_config: 窗口创建成功");

        // 新窗口创建后，前端组件挂载会自动 loadData，不需要 emit refresh
        // 但为了保险，可以保留 emit，前端防抖即可
        let window_clone = window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            match window_clone.emit("shortcuts-config:refresh", ()) {
                Ok(_) => {
                    println!("[后端] show_shortcuts_config: Refresh event emitted for new window");
                }
                Err(e) => {
                    println!(
                        "[后端] show_shortcuts_config: ERROR emitting refresh event: {}",
                        e
                    );
                }
            }
        });
    }

    println!("[后端] show_shortcuts_config: END");
    Ok(())
}

#[tauri::command]
pub fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn record_open_history(key: String, app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    open_history::record_open(key, &app_data_dir)
}

#[tauri::command]
pub fn get_open_history(app: tauri::AppHandle) -> Result<std::collections::HashMap<String, u64>, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    open_history::get_all_history(&app_data_dir)
}

#[tauri::command]
pub async fn show_memo_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    // 尝试获取现有窗口
    if let Some(window) = app.get_webview_window("memo-window") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
        // 动态创建窗口
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "memo-window",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("备忘录")
        .inner_size(700.0, 700.0)
        .resizable(true)
        .min_inner_size(500.0, 400.0)
        .center()
        .build()
        .map_err(|e| format!("创建备忘录窗口失败: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn show_plugin_list_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    // 尝试获取现有窗口
    if let Some(window) = app.get_webview_window("plugin-list-window") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
        // 动态创建窗口
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "plugin-list-window",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("插件列表")
        .inner_size(700.0, 600.0)
        .resizable(true)
        .min_inner_size(500.0, 400.0)
        .center()
        .build()
        .map_err(|e| format!("创建插件列表窗口失败: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn show_json_formatter_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    // 尝试获取现有窗口
    if let Some(window) = app.get_webview_window("json-formatter-window") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
        // 动态创建窗口
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "json-formatter-window",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("JSON 格式化查看器")
        .inner_size(900.0, 700.0)
        .resizable(true)
        .min_inner_size(600.0, 500.0)
        .center()
        .build()
        .map_err(|e| format!("创建 JSON 格式化窗口失败: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn show_file_toolbox_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    // 尝试获取现有窗口
    if let Some(window) = app.get_webview_window("file-toolbox-window") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
        // 动态创建窗口
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "file-toolbox-window",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("文件工具箱")
        .inner_size(900.0, 800.0)
        .resizable(true)
        .min_inner_size(700.0, 600.0)
        .center()
        .build()
        .map_err(|e| format!("创建文件工具箱窗口失败: {}", e))?;
    }

    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReplaceParams {
    folder_path: String,
    search_text: String,
    replace_text: String,
    file_extensions: Vec<String>,
    use_regex: bool,
    case_sensitive: bool,
    backup_folder: bool,
    replace_file_name: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReplaceResult {
    file_path: String,
    matches: usize,
    success: bool,
    error: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReplaceResponse {
    results: Vec<FileReplaceResult>,
    total_matches: usize,
    total_files: usize,
}

fn process_file_replace(
    params: &FileReplaceParams,
    execute: bool,
) -> Result<FileReplaceResponse, String> {
    use std::path::Path;
    use regex::Regex;

    let folder_path = Path::new(&params.folder_path);
    if !folder_path.exists() || !folder_path.is_dir() {
        return Err("文件夹不存在或不是有效目录".to_string());
    }

    // 如果需要执行替换且需要备份，先备份文件夹
    if execute && params.backup_folder {
        backup_folder(folder_path)?;
    }

    let mut results = Vec::new();
    let mut total_matches = 0;
    let mut total_files = 0;

    // 构建正则表达式或普通字符串匹配
    let pattern = if params.use_regex {
        let flags = if params.case_sensitive { "" } else { "(?i)" };
        Regex::new(&format!("{}{}", flags, params.search_text))
            .map_err(|e| format!("正则表达式错误: {}", e))?
    } else {
        // 对于普通字符串，转义特殊字符
        let escaped = regex::escape(&params.search_text);
        let flags = if params.case_sensitive { "" } else { "(?i)" };
        Regex::new(&format!("{}{}", flags, escaped))
            .map_err(|e| format!("构建匹配模式失败: {}", e))?
    };

    // 处理目标文件夹本身的名字（如果启用替换文件名）
    let mut actual_folder_path = folder_path.to_path_buf();
    if params.replace_file_name {
        if let Some(folder_name) = folder_path.file_name().and_then(|n| n.to_str()) {
            if pattern.is_match(folder_name) {
                let new_folder_name = pattern.replace_all(folder_name, &params.replace_text).to_string();
                let parent = folder_path.parent().ok_or_else(|| "无法获取文件夹父目录".to_string())?;
                let new_folder_path = parent.join(&new_folder_name);
                
                if execute {
                    // 执行模式：如果新文件夹名与旧文件夹名不同，执行重命名
                    if new_folder_path != folder_path {
                        std::fs::rename(folder_path, &new_folder_path)
                            .map_err(|e| format!("重命名目标文件夹失败: {}", e))?;
                        actual_folder_path = new_folder_path.clone();
                        total_matches += 1;
                        results.push(FileReplaceResult {
                            file_path: new_folder_path.to_string_lossy().to_string(),
                            matches: 1,
                            success: true,
                            error: None,
                        });
                    }
                } else {
                    // 预览模式：记录文件夹名匹配
                    total_matches += 1;
                    results.push(FileReplaceResult {
                        file_path: new_folder_path.to_string_lossy().to_string(),
                        matches: 1,
                        success: true,
                        error: None,
                    });
                }
            }
        }
    }

    // 递归遍历文件夹
    fn walk_dir(
        dir: &Path,
        pattern: &Regex,
        replace_text: &str,
        file_extensions: &[String],
        execute: bool,
        replace_file_name: bool,
        results: &mut Vec<FileReplaceResult>,
        total_matches: &mut usize,
        total_files: &mut usize,
    ) -> Result<(), String> {
        use std::fs;

        for entry in fs::read_dir(dir).map_err(|e| format!("读取目录失败: {}", e))? {
            let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
            let path = entry.path();

            if path.is_dir() {
                // 处理文件夹名替换
                let mut final_dir_path = path.clone();
                let mut dir_name_matches = 0;
                let mut content_dir_path = path.clone(); // 用于递归遍历的路径
                
                if replace_file_name {
                    if let Some(dir_name) = path.file_name().and_then(|n| n.to_str()) {
                        if pattern.is_match(dir_name) {
                            dir_name_matches = 1;
                            let new_dir_name = pattern.replace_all(dir_name, replace_text).to_string();
                            let parent = path.parent().ok_or_else(|| "无法获取文件夹父目录".to_string())?;
                            final_dir_path = parent.join(&new_dir_name);
                            
                            if execute {
                                // 执行模式：如果新文件夹名与旧文件夹名不同，执行重命名
                                if final_dir_path != path {
                                    fs::rename(&path, &final_dir_path)
                                        .map_err(|e| format!("重命名文件夹失败: {}", e))?;
                                    content_dir_path = final_dir_path.clone(); // 重命名后使用新路径
                                    *total_matches += dir_name_matches;
                                    results.push(FileReplaceResult {
                                        file_path: final_dir_path.to_string_lossy().to_string(),
                                        matches: dir_name_matches,
                                        success: true,
                                        error: None,
                                    });
                                }
                            } else {
                                // 预览模式：记录文件夹名匹配
                                *total_matches += dir_name_matches;
                                results.push(FileReplaceResult {
                                    file_path: final_dir_path.to_string_lossy().to_string(),
                                    matches: dir_name_matches,
                                    success: true,
                                    error: None,
                                });
                            }
                        }
                    }
                }
                
                // 递归处理子目录（使用实际存在的路径）
                walk_dir(
                    &content_dir_path,
                    pattern,
                    replace_text,
                    file_extensions,
                    execute,
                    replace_file_name,
                    results,
                    total_matches,
                    total_files,
                )?;
            } else if path.is_file() {
                // 检查文件扩展名
                let should_process = if file_extensions.is_empty() {
                    true
                } else {
                    path.extension()
                        .and_then(|ext| ext.to_str())
                        .map(|ext| {
                            file_extensions
                                .iter()
                                .any(|allowed| ext.eq_ignore_ascii_case(allowed.trim()))
                        })
                        .unwrap_or(false)
                };

                if should_process {
                    *total_files += 1;
                    
                    // 处理文件名替换
                    let mut final_path = path.clone();
                    let mut file_name_matches = 0;
                    let mut content_path = path.clone(); // 用于读取文件内容的路径
                    
                    if replace_file_name {
                        if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                            if pattern.is_match(file_name) {
                                file_name_matches = 1;
                                let new_file_name = pattern.replace_all(file_name, replace_text).to_string();
                                let parent = path.parent().ok_or_else(|| "无法获取文件父目录".to_string())?;
                                final_path = parent.join(&new_file_name);
                                
                                if execute {
                                    // 执行模式：如果新文件名与旧文件名不同，执行重命名
                                    if final_path != path {
                                        fs::rename(&path, &final_path)
                                            .map_err(|e| format!("重命名文件失败: {}", e))?;
                                        content_path = final_path.clone(); // 重命名后使用新路径
                                    }
                                }
                                // 预览模式：final_path 是新路径（用于显示），但 content_path 仍然是原路径（用于读取）
                            }
                        }
                    }
                    
                    // 处理文件内容替换（使用实际存在的文件路径）
                    match process_single_file(&content_path, pattern, replace_text, execute) {
                        Ok(content_matches) => {
                            let total_file_matches = content_matches + file_name_matches;
                            if total_file_matches > 0 {
                                *total_matches += total_file_matches;
                                results.push(FileReplaceResult {
                                    file_path: final_path.to_string_lossy().to_string(),
                                    matches: total_file_matches,
                                    success: true,
                                    error: None,
                                });
                            }
                        }
                        Err(e) => {
                            // 如果文件名被替换了，即使内容无法处理（如二进制文件），也显示为成功
                            // 因为文件名替换已经成功了
                            if file_name_matches > 0 {
                                *total_matches += file_name_matches;
                                results.push(FileReplaceResult {
                                    file_path: final_path.to_string_lossy().to_string(),
                                    matches: file_name_matches,
                                    success: true,
                                    error: None,
                                });
                            } else {
                                // 如果文件名没有被替换，且内容无法处理，静默跳过（不显示错误）
                                // 这是二进制文件或非文本文件，属于正常情况
                            }
                        }
                    }
                }
            }
        }

        Ok(())
    }

    walk_dir(
        &actual_folder_path,
        &pattern,
        &params.replace_text,
        &params.file_extensions,
        execute,
        params.replace_file_name,
        &mut results,
        &mut total_matches,
        &mut total_files,
    )?;

    Ok(FileReplaceResponse {
        results,
        total_matches,
        total_files,
    })
}

/// 备份文件夹到父目录，备份文件夹名称包含时间戳
fn backup_folder(folder_path: &Path) -> Result<std::path::PathBuf, String> {
    use std::fs;
    use std::path::PathBuf;
    use chrono::Local;

    let parent_dir = folder_path
        .parent()
        .ok_or_else(|| "无法获取文件夹的父目录".to_string())?;

    let folder_name = folder_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "无法获取文件夹名称".to_string())?;

    // 生成备份文件夹名称，格式：原文件夹名_backup_YYYYMMDD_HHMMSS
    let timestamp = Local::now().format("%Y%m%d_%H%M%S");
    let backup_name = format!("{}_backup_{}", folder_name, timestamp);
    let backup_path = parent_dir.join(&backup_name);

    // 如果备份文件夹已存在，添加序号
    let mut final_backup_path = backup_path.clone();
    let mut counter = 1;
    while final_backup_path.exists() {
        let new_backup_name = format!("{}_backup_{}_{}", folder_name, timestamp, counter);
        final_backup_path = parent_dir.join(&new_backup_name);
        counter += 1;
    }

    // 复制整个文件夹
    copy_dir_all(folder_path, &final_backup_path)
        .map_err(|e| format!("备份文件夹失败: {}", e))?;

    Ok(final_backup_path)
}

/// 递归复制目录及其所有内容
fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    use std::fs;

    // 创建目标目录
    fs::create_dir_all(dst)
        .map_err(|e| format!("创建备份目录失败: {}", e))?;

    // 遍历源目录
    for entry in fs::read_dir(src)
        .map_err(|e| format!("读取源目录失败: {}", e))?
    {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let path = entry.path();
        let file_name = entry
            .file_name()
            .to_str()
            .ok_or_else(|| "文件名包含无效字符".to_string())?
            .to_string();

        let dst_path = dst.join(&file_name);

        if path.is_dir() {
            // 递归复制子目录
            copy_dir_all(&path, &dst_path)?;
        } else {
            // 复制文件
            fs::copy(&path, &dst_path)
                .map_err(|e| format!("复制文件 {} 失败: {}", file_name, e))?;
        }
    }

    Ok(())
}

fn process_single_file(
    file_path: &Path,
    pattern: &Regex,
    replace_text: &str,
    execute: bool,
) -> Result<usize, String> {
    use std::fs;
    use std::io::Write;

    // 读取文件内容（只处理 UTF-8 文本文件）
    let content = match fs::read_to_string(file_path) {
        Ok(content) => content,
        Err(e) => {
            // 如果文件不是有效的 UTF-8 文本，跳过该文件
            return Err(format!("文件不是有效的文本文件（UTF-8）: {}", e));
        }
    };

    // 查找匹配
    let matches: Vec<_> = pattern.find_iter(&content).collect();
    let match_count = matches.len();

    if match_count > 0 && execute {
        // 执行替换
        let new_content = pattern.replace_all(&content, replace_text).to_string();

        // 写回文件
        let mut file = fs::File::create(file_path)
            .map_err(|e| format!("打开文件写入失败: {}", e))?;
        file.write_all(new_content.as_bytes())
            .map_err(|e| format!("写入文件失败: {}", e))?;
    }

    Ok(match_count)
}

#[tauri::command(rename_all = "camelCase")]
pub fn preview_file_replace(
    folder_path: String,
    search_text: String,
    replace_text: String,
    file_extensions: Vec<String>,
    use_regex: bool,
    case_sensitive: bool,
    backup_folder: bool,
    replace_file_name: bool,
) -> Result<FileReplaceResponse, String> {
    let params = FileReplaceParams {
        folder_path,
        search_text,
        replace_text,
        file_extensions,
        use_regex,
        case_sensitive,
        backup_folder,
        replace_file_name,
    };
    process_file_replace(&params, false)
}

#[tauri::command(rename_all = "camelCase")]
pub fn execute_file_replace(
    folder_path: String,
    search_text: String,
    replace_text: String,
    file_extensions: Vec<String>,
    use_regex: bool,
    case_sensitive: bool,
    backup_folder: bool,
    replace_file_name: bool,
) -> Result<FileReplaceResponse, String> {
    let params = FileReplaceParams {
        folder_path,
        search_text,
        replace_text,
        file_extensions,
        use_regex,
        case_sensitive,
        backup_folder,
        replace_file_name,
    };
    process_file_replace(&params, true)
}

#[tauri::command]
pub fn select_folder() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        // 使用 COM 对象 Shell.Application 来选择文件夹（更可靠，不需要 Add-Type）
        let script = r#"
            $shell = New-Object -ComObject Shell.Application
            $folder = $shell.BrowseForFolder(0, "选择要处理的文件夹", 0, 0)
            if ($folder) {
                $path = $folder.Self.Path
                if ($path) {
                    Write-Output $path
                }
            }
        "#;
        
        let output = Command::new("powershell")
            .args(&["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .map_err(|e| format!("执行 PowerShell 失败: {}", e))?;
        
        // 检查 stderr 是否有错误（但忽略一些警告信息）
        let stderr_str = String::from_utf8_lossy(&output.stderr);
        if !stderr_str.is_empty() && !stderr_str.contains("警告") && !stderr_str.contains("Warning") {
            return Err(format!("PowerShell 错误: {}", stderr_str));
        }
        
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if path.is_empty() {
                Ok(None) // 用户取消了选择
            } else {
                Ok(Some(path))
            }
        } else {
            Ok(None) // 用户取消了选择或没有选择
        }
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        // 其他平台暂时返回 None，表示不支持
        Ok(None)
    }
}

#[tauri::command]
pub fn get_plugin_directory(app: tauri::AppHandle) -> Result<String, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let plugin_dir = app_data_dir.join("plugins");
    
    // 确保目录存在
    if !plugin_dir.exists() {
        fs::create_dir_all(&plugin_dir).map_err(|e| e.to_string())?;
    }
    
    Ok(plugin_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn scan_plugin_directory(directory: String) -> Result<Vec<String>, String> {
    let path = PathBuf::from(directory);
    if !path.exists() {
        return Ok(vec![]);
    }
    
    let mut plugin_dirs = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            // 检查是否有 manifest.json
            if path.join("manifest.json").exists() {
                plugin_dirs.push(path.to_string_lossy().to_string());
            }
        }
    }
    
    Ok(plugin_dirs)
}

#[tauri::command]
pub fn read_plugin_manifest(plugin_dir: String) -> Result<String, String> {
    let manifest_path = PathBuf::from(plugin_dir).join("manifest.json");
    if !manifest_path.exists() {
        return Err("manifest.json not found".to_string());
    }
    
    let content = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read manifest: {}", e))?;
    
    Ok(content)
}

// ===== Settings commands =====

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Result<settings::Settings, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    settings::load_settings(&app_data_dir)
}

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, settings: settings::Settings) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    settings::save_settings(&app_data_dir, &settings)
}

#[tauri::command]
pub async fn show_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    println!("[后端] show_settings_window: START");

    // 1. 尝试获取现有窗口
    if let Some(window) = app.get_webview_window("settings") {
        println!("[后端] show_settings_window: 窗口已存在，执行显示操作");
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;

        // 通知前端刷新数据
        let window_clone = window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            match window_clone.emit("settings:refresh", ()) {
                Ok(_) => {
                    println!("[后端] show_settings_window: Refresh event emitted successfully");
                }
                Err(e) => {
                    println!(
                        "[后端] show_settings_window: ERROR emitting refresh event: {}",
                        e
                    );
                }
            }
        });
    } else {
        println!("[后端] show_settings_window: 窗口不存在，开始动态创建");

        // 2. 动态创建窗口
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "settings",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("设置")
        .inner_size(600.0, 500.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| format!("创建设置窗口失败: {}", e))?;

        println!("[后端] show_settings_window: 窗口创建成功");

        // 通知前端刷新数据
        let window_clone = window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            match window_clone.emit("settings:refresh", ()) {
                Ok(_) => {
                    println!("[后端] show_settings_window: Refresh event emitted for new window");
                }
                Err(e) => {
                    println!(
                        "[后端] show_settings_window: ERROR emitting refresh event: {}",
                        e
                    );
                }
            }
        });
    }

    println!("[后端] show_settings_window: END");
    Ok(())
}

#[cfg(target_os = "windows")]
mod startup {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW,
        RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_ALL_ACCESS, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_SZ,
    };

    const REGISTRY_PATH: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const APP_NAME: &str = "ReFast";

    /// 将字符串转换为宽字符（UTF-16）数组
    fn to_wide_string(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    /// 打开注册表键
    fn open_registry_key(
        hkey: HKEY,
        sub_key: &str,
        access: u32,
    ) -> Result<HKEY, String> {
        let sub_key_wide = to_wide_string(sub_key);
        let mut h_result: HKEY = 0;

        unsafe {
            let result = RegOpenKeyExW(
                hkey,
                sub_key_wide.as_ptr(),
                0,
                access,
                &mut h_result,
            );

            if result == 0 {
                Ok(h_result)
            } else {
                Err(format!("Failed to open registry key: error code {}", result))
            }
        }
    }


    /// 获取当前应用的可执行文件路径
    pub fn get_exe_path() -> Result<String, String> {
        std::env::current_exe()
            .map_err(|e| format!("Failed to get current exe path: {}", e))?
            .to_str()
            .ok_or_else(|| "Invalid exe path encoding".to_string())
            .map(|s| s.to_string())
    }

    /// 检查是否已设置开机启动
    pub fn is_startup_enabled() -> Result<bool, String> {
        let hkey = match open_registry_key(HKEY_CURRENT_USER, REGISTRY_PATH, KEY_QUERY_VALUE) {
            Ok(key) => key,
            Err(_) => return Ok(false), // 如果注册表键不存在，说明未启用
        };

        let value_name_wide = to_wide_string(APP_NAME);

        unsafe {
            // 尝试读取注册表值来检查是否存在
            let mut value_type: u32 = 0;
            let mut value_data: Vec<u8> = vec![0; 520]; // 足够大的缓冲区
            let mut value_size: u32 = value_data.len() as u32;

            let result = RegQueryValueExW(
                hkey,
                value_name_wide.as_ptr(),
                std::ptr::null_mut(),
                &mut value_type,
                value_data.as_mut_ptr(),
                &mut value_size,
            );

            RegCloseKey(hkey);

            Ok(result == 0 && value_type == REG_SZ)
        }
    }

    /// 设置开机启动
    pub fn enable_startup() -> Result<(), String> {
        let exe_path = get_exe_path()?;
        // Run 键应该总是存在的，使用 KEY_ALL_ACCESS 以确保可以写入
        let hkey = open_registry_key(HKEY_CURRENT_USER, REGISTRY_PATH, KEY_ALL_ACCESS)?;

        let value_name_wide = to_wide_string(APP_NAME);
        let value_data_wide = to_wide_string(&exe_path);

        unsafe {
            let result = RegSetValueExW(
                hkey,
                value_name_wide.as_ptr(),
                0,
                REG_SZ,
                value_data_wide.as_ptr() as *const u8,
                (value_data_wide.len() * std::mem::size_of::<u16>()) as u32,
            );

            RegCloseKey(hkey);

            if result == 0 {
                Ok(())
            } else {
                Err(format!("Failed to set registry value: error code {}", result))
            }
        }
    }

    /// 取消开机启动
    pub fn disable_startup() -> Result<(), String> {
        let hkey = open_registry_key(HKEY_CURRENT_USER, REGISTRY_PATH, KEY_SET_VALUE)?;
        let value_name_wide = to_wide_string(APP_NAME);

        unsafe {
            let result = RegDeleteValueW(hkey, value_name_wide.as_ptr());
            RegCloseKey(hkey);

            if result == 0 {
                Ok(())
            } else {
                // 如果值不存在，也认为是成功（已经禁用）
                if result == 2 {
                    // ERROR_FILE_NOT_FOUND
                    Ok(())
                } else {
                    Err(format!("Failed to delete registry value: error code {}", result))
                }
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod startup {
    pub fn is_startup_enabled() -> Result<bool, String> {
        Err("Startup is only supported on Windows".to_string())
    }

    pub fn enable_startup() -> Result<(), String> {
        Err("Startup is only supported on Windows".to_string())
    }

    pub fn disable_startup() -> Result<(), String> {
        Err("Startup is only supported on Windows".to_string())
    }
}

/// 检查是否已设置开机启动
#[tauri::command]
pub fn is_startup_enabled() -> Result<bool, String> {
    startup::is_startup_enabled()
}

/// 设置开机启动
#[tauri::command]
pub fn set_startup_enabled(enabled: bool) -> Result<(), String> {
    if enabled {
        startup::enable_startup()
    } else {
        startup::disable_startup()
    }
}

/// 同步开机启动设置（内部使用）
pub fn sync_startup_setting(startup_enabled: bool) -> Result<(), String> {
    let current = startup::is_startup_enabled().unwrap_or(false);
    if current != startup_enabled {
        if startup_enabled {
            startup::enable_startup()?;
        } else {
            startup::disable_startup()?;
        }
    }
    Ok(())
}
