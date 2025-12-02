use crate::app_search;
use crate::everything_search;
use crate::file_history;
use crate::hooks;
use crate::memos;
use crate::open_history;
use crate::recording::{RecordingMeta, RecordingState};
use crate::replay::ReplayState;
use crate::shortcuts;
use crate::window_config;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
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
}

static SEARCH_TASK_MANAGER: LazyLock<Arc<Mutex<SearchTaskManager>>> = LazyLock::new(|| {
    Arc::new(Mutex::new(SearchTaskManager { cancel_flag: None }))
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

    // No background icon extraction - icons will be extracted on-demand during search
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

            // 如果存在旧的搜索标志，先将其置为取消
            if let Some(old_flag) = &manager.cancel_flag {
                old_flag.store(true, Ordering::Relaxed);
            }

            // 为本次搜索创建新的标志，并保存下来
            let new_flag = Arc::new(AtomicBool::new(false));
            manager.cancel_flag = Some(new_flag.clone());
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

            // Request maximum 500 results from Everything
            let resp = everything_search::windows::search_files(
                &query_clone,
                500,
                Some(&cancel_flag),
                Some(on_batch),
            )
            .map_err(|e| e.to_string())?;

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
        // Open Everything download page in default browser
        let url = "https://www.voidtools.com/downloads/";
        std::process::Command::new("cmd")
            .args(&["/C", "start", "", url])
            .spawn()
            .map_err(|e| format!("Failed to open download page: {}", e))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Everything is only available on Windows".to_string())
    }
}

#[tauri::command]
pub async fn download_es_exe(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        use std::fs::File;
        use std::io::Write;
        use std::os::windows::process::CommandExt;

        // First, find Everything installation directory
        let everything_dir = find_everything_installation_dir().ok_or_else(|| {
            "Everything installation directory not found. Please install Everything first."
                .to_string()
        })?;

        let es_exe_path = everything_dir.join("es.exe");

        // es.exe download URL (from GitHub releases)
        // Using the latest version from voidtools/es repository
        let download_url =
            "https://github.com/voidtools/es/releases/download/1.1.0.30/es-1.1.0.30.zip";

        // Download to temp directory first
        let temp_dir = std::env::temp_dir();
        let zip_path = temp_dir.join("es.zip");

        // Create HTTP client
        let client = reqwest::Client::new();
        let response = client
            .get(download_url)
            .send()
            .await
            .map_err(|e| format!("Failed to start download: {}", e))?;

        // Check HTTP status code
        let status = response.status();
        if !status.is_success() {
            return Err(format!(
                "下载失败：HTTP 状态码 {}。\n\n请手动从以下链接下载：\nhttps://github.com/voidtools/es/releases",
                status.as_u16()
            ));
        }

        let total_size = response
            .content_length()
            .ok_or_else(|| "Failed to get content length".to_string())?;

        // Validate expected ZIP file size (should be at least 10KB)
        if total_size < 10 * 1024 {
            return Err(format!(
                "下载的文件大小异常（{} 字节），可能是错误页面。\n\n请手动从以下链接下载：\nhttps://github.com/voidtools/es/releases",
                total_size
            ));
        }

        // Create file
        let mut file =
            File::create(&zip_path).map_err(|e| format!("Failed to create file: {}", e))?;

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
                let _ = window.emit("es-download-progress", progress);
            }
        }

        // Verify downloaded ZIP file size
        drop(file); // Close file before checking metadata
        let zip_metadata = std::fs::metadata(&zip_path)
            .map_err(|e| format!("Failed to get ZIP file metadata: {}", e))?;
        if zip_metadata.len() < 10 * 1024 {
            let _ = std::fs::remove_file(&zip_path);
            return Err(format!(
                "下载的 ZIP 文件大小异常（{} 字节），可能下载失败或文件损坏。\n\n请手动从以下链接下载：\nhttps://github.com/voidtools/es/releases",
                zip_metadata.len()
            ));
        }

        // Extract es.exe from zip to temp directory first
        let extract_result = std::process::Command::new("powershell")
            .args(&[
                "-Command",
                &format!(
                    "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                    zip_path.to_string_lossy(),
                    temp_dir.to_string_lossy()
                ),
            ])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW - 隐藏 PowerShell 窗口
            .output();

        // Clean up zip file
        let _ = std::fs::remove_file(&zip_path);

        // Find extracted es.exe in temp directory
        let temp_es_exe = if let Ok(extract_output) = extract_result {
            if !extract_output.status.success() {
                let error_msg = String::from_utf8_lossy(&extract_output.stderr);
                eprintln!("Extraction failed: {}", error_msg);
            }

            // Look for es.exe in temp directory
            let extracted_dir = temp_dir.join("es-1.1.0.30");
            let possible_paths = vec![
                temp_dir.join("es.exe"),
                extracted_dir.join("es.exe"),
                temp_dir.join("es").join("es.exe"),
            ];

            possible_paths
                .iter()
                .find(|path| {
                    if path.exists() {
                        // Verify file size - should be at least 10KB
                        if let Ok(metadata) = std::fs::metadata(path) {
                            return metadata.len() > 10 * 1024;
                        }
                    }
                    false
                })
                .cloned()
        } else {
            None
        };

        let temp_es_exe = match temp_es_exe {
            Some(path) => path,
            None => {
                // If extraction failed, try direct download
                return download_es_exe_direct(&es_exe_path, &app).await;
            }
        };

        // Final verification: check es.exe file size before copying
        let es_metadata = std::fs::metadata(&temp_es_exe)
            .map_err(|e| format!("Failed to get es.exe metadata: {}", e))?;
        if es_metadata.len() < 10 * 1024 {
            let _ = std::fs::remove_file(&temp_es_exe);
            return Err(format!(
                "解压后的 es.exe 文件大小异常（{} 字节），文件可能损坏。\n\n请手动从以下链接下载：\nhttps://github.com/voidtools/es/releases",
                es_metadata.len()
            ));
        }

        // Try to copy es.exe to Everything directory
        // First, try direct copy (might fail due to permissions)
        match std::fs::copy(&temp_es_exe, &es_exe_path) {
            Ok(_) => {
                // Success! Clean up temp file
                let _ = std::fs::remove_file(&temp_es_exe);
                Ok(es_exe_path.to_string_lossy().to_string())
            }
            Err(_) => {
                // Direct copy failed, try using PowerShell with elevated permissions
                // Create a batch script to copy the file
                let batch_script = temp_dir.join("copy_es_exe.bat");
                let batch_content = format!(
                    "@echo off\n\
                    copy /Y \"{}\" \"{}\"\n\
                    if %ERRORLEVEL% EQU 0 (\n\
                        echo SUCCESS\n\
                    ) else (\n\
                        echo FAILED\n\
                    )",
                    temp_es_exe.to_string_lossy().replace('\\', "\\\\"),
                    es_exe_path.to_string_lossy().replace('\\', "\\\\")
                );

                // Write batch script
                if let Err(_) = std::fs::write(&batch_script, batch_content) {
                    return Err(format!(
                        "需要管理员权限才能将 es.exe 复制到 Everything 安装目录。\n\n\
                        请手动执行以下操作：\n\
                        1. 以管理员身份运行本程序后重试\n\
                        2. 或者手动将 es.exe 复制到：{}\n\n\
                        临时文件位置：{}",
                        es_exe_path.to_string_lossy(),
                        temp_es_exe.to_string_lossy()
                    ));
                }

                // Try to run batch script with admin privileges
                let _ = std::process::Command::new("powershell")
                    .args(&[
                        "-Command",
                        &format!(
                            "$proc = Start-Process -FilePath '{}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $proc.ExitCode",
                            batch_script.to_string_lossy().replace('\\', "\\\\")
                        )
                    ])
                    .creation_flags(0x08000000) // CREATE_NO_WINDOW - 隐藏 PowerShell 窗口
                    .output();

                // Clean up batch script
                let _ = std::fs::remove_file(&batch_script);

                // Wait a bit for the copy to complete
                std::thread::sleep(std::time::Duration::from_millis(500));

                // Check if copy was successful
                if es_exe_path.exists() {
                    // Success! Clean up temp file
                    let _ = std::fs::remove_file(&temp_es_exe);
                    Ok(es_exe_path.to_string_lossy().to_string())
                } else {
                    // Copy failed, don't delete temp file so user can manually copy
                    Err(format!(
                        "需要管理员权限才能将 es.exe 复制到 Everything 安装目录。\n\n\
                        请手动执行以下操作：\n\
                        1. 以管理员身份运行本程序后重试\n\
                        2. 或者手动将 es.exe 复制到：{}\n\n\
                        临时文件位置：{}\n\n\
                        提示：您可以打开文件资源管理器，导航到临时文件位置，然后以管理员身份复制文件。",
                        es_exe_path.to_string_lossy(),
                        temp_es_exe.to_string_lossy()
                    ))
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("es.exe is only available on Windows".to_string())
    }
}

#[cfg(target_os = "windows")]
async fn download_es_exe_direct(
    target_path: &std::path::PathBuf,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    use futures_util::StreamExt;
    use std::fs::File;
    use std::io::Write;
    use std::os::windows::process::CommandExt;

    // Download to temp directory first (no permission issues)
    let temp_dir = std::env::temp_dir();
    let temp_es_exe = temp_dir.join("es.exe");

    // Try direct download URL (if available)
    // Note: This might not work if the direct URL doesn't exist
    // In that case, user will need to download manually
    let download_url = "https://github.com/voidtools/es/releases/download/1.1.0.30/es.exe";

    let client = reqwest::Client::new();
    let response = match client.get(download_url).send().await {
        Ok(r) => r,
        Err(e) => {
            return Err(format!(
                "无法连接到下载服务器：{}\n\n请手动从以下链接下载：\nhttps://github.com/voidtools/es/releases",
                e
            ));
        }
    };

    // Check HTTP status code
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "下载失败：HTTP 状态码 {}。\n\n请手动从以下链接下载：\nhttps://github.com/voidtools/es/releases",
            status.as_u16()
        ));
    }

    let total_size = response
        .content_length()
        .ok_or_else(|| "Failed to get content length".to_string())?;

    // Validate expected file size (should be at least 10KB)
    if total_size < 10 * 1024 {
        return Err(format!(
            "下载的文件大小异常（{} 字节），可能是错误页面。\n\n请手动从以下链接下载：\nhttps://github.com/voidtools/es/releases",
            total_size
        ));
    }

    let mut file =
        File::create(&temp_es_exe).map_err(|e| format!("Failed to create file: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|e| format!("Failed to read chunk: {}", e))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Failed to write chunk: {}", e))?;

        downloaded += chunk.len() as u64;

        let progress = (downloaded as f64 / total_size as f64 * 100.0) as u32;
        if let Some(window) = app.get_webview_window("launcher") {
            let _ = window.emit("es-download-progress", progress);
        }
    }

    // Verify downloaded file size
    drop(file); // Close file before checking metadata
    let file_metadata = std::fs::metadata(&temp_es_exe)
        .map_err(|e| format!("Failed to get file metadata: {}", e))?;
    if file_metadata.len() < 10 * 1024 {
        let _ = std::fs::remove_file(&temp_es_exe);
        return Err(format!(
            "下载的 es.exe 文件大小异常（{} 字节），可能下载失败或文件损坏。\n\n请手动从以下链接下载：\nhttps://github.com/voidtools/es/releases",
            file_metadata.len()
        ));
    }

    // Try to copy to target location
    // First, try direct copy (might fail due to permissions)
    match std::fs::copy(&temp_es_exe, target_path) {
        Ok(_) => {
            // Success! Clean up temp file
            let _ = std::fs::remove_file(&temp_es_exe);
            Ok(target_path.to_string_lossy().to_string())
        }
        Err(_) => {
            // Direct copy failed, try using batch script with admin privileges
            let temp_dir = std::env::temp_dir();
            let batch_script = temp_dir.join("copy_es_exe.bat");
            let batch_content = format!(
                "@echo off\n\
                    copy /Y \"{}\" \"{}\"\n\
                    if %ERRORLEVEL% EQU 0 (\n\
                        echo SUCCESS\n\
                    ) else (\n\
                        echo FAILED\n\
                    )",
                temp_es_exe.to_string_lossy().replace('\\', "\\\\"),
                target_path.to_string_lossy().replace('\\', "\\\\")
            );

            // Write batch script
            if let Err(_) = std::fs::write(&batch_script, batch_content) {
                return Err(format!(
                    "需要管理员权限才能将 es.exe 复制到 Everything 安装目录。\n\n\
                        请手动执行以下操作：\n\
                        1. 以管理员身份运行本程序后重试\n\
                        2. 或者手动将 es.exe 复制到：{}\n\n\
                        临时文件位置：{}",
                    target_path.to_string_lossy(),
                    temp_es_exe.to_string_lossy()
                ));
            }

            // Try to run batch script with admin privileges
            let _ = std::process::Command::new("powershell")
                    .args(&[
                        "-Command",
                        &format!(
                            "$proc = Start-Process -FilePath '{}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $proc.ExitCode",
                            batch_script.to_string_lossy().replace('\\', "\\\\")
                        )
                    ])
                    .creation_flags(0x08000000) // CREATE_NO_WINDOW - 隐藏 PowerShell 窗口
                    .output();

            // Clean up batch script
            let _ = std::fs::remove_file(&batch_script);

            // Wait a bit for the copy to complete
            std::thread::sleep(std::time::Duration::from_millis(500));

            // Check if copy was successful
            if target_path.exists() {
                // Success! Clean up temp file
                let _ = std::fs::remove_file(&temp_es_exe);
                Ok(target_path.to_string_lossy().to_string())
            } else {
                // Copy failed, don't delete temp file so user can manually copy
                Err(format!(
                        "需要管理员权限才能将 es.exe 复制到 Everything 安装目录。\n\n\
                        请手动执行以下操作：\n\
                        1. 以管理员身份运行本程序后重试\n\
                        2. 或者手动将 es.exe 复制到：{}\n\n\
                        临时文件位置：{}\n\n\
                        提示：您可以打开文件资源管理器，导航到临时文件位置，然后以管理员身份复制文件。",
                        target_path.to_string_lossy(),
                        temp_es_exe.to_string_lossy()
                    ))
            }
        }
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
        // Open URL in default browser on Windows
        std::process::Command::new("cmd")
            .args(&["/C", "start", "", &url])
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
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

    if !path_buf.exists() {
        return Err(format!("Path not found: {}", trimmed));
    }

    #[cfg(target_os = "windows")]
    {
        // On Windows, use explorer with /select flag to open folder and select file
        // Get the absolute canonical path to handle special characters properly
        let canonical_path = path_buf
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize path: {}", e))?;

        // Remove the \\?\ prefix if present (Windows long path prefix)
        // explorer /select doesn't work well with this prefix
        let mut path_str = canonical_path.to_string_lossy().to_string();
        println!("[reveal_in_folder] Original canonical path: {}", path_str);

        // Remove the \\?\ prefix if present
        if path_str.starts_with("\\\\?\\") {
            path_str = path_str[4..].to_string();
            println!("[reveal_in_folder] Removed \\\\?\\ prefix");
        }
        path_str = path_str.replace("/", "\\");

        println!("[reveal_in_folder] File path (cleaned): {}", path_str);

        // Get parent directory - this is the folder we want to open
        let parent_dir = canonical_path
            .parent()
            .ok_or_else(|| "File has no parent directory".to_string())?;

        // Remove the \\?\ prefix from parent directory too
        let mut parent_str = parent_dir.to_string_lossy().to_string();
        if parent_str.starts_with("\\\\?\\") {
            parent_str = parent_str[4..].to_string();
        }
        parent_str = parent_str.replace("/", "\\");
        println!("[reveal_in_folder] Parent directory: {}", parent_str);

        // Use explorer /select command with proper escaping
        // For paths with special characters, we'll use a simpler approach
        let escaped_path = path_str.replace("\"", "\"\"");
        let explorer_arg = format!("/select,\"{}\"", escaped_path);

        println!(
            "[reveal_in_folder] Explorer command: explorer {}",
            explorer_arg
        );
        println!("[reveal_in_folder] Will open parent folder: {}", parent_str);

        // Try using cmd /C to execute explorer command - this handles paths better
        Command::new("cmd")
            .args(&["/C", "explorer", &explorer_arg])
            .spawn()
            .map_err(|e| format!("Failed to execute explorer command: {}", e))?;

        println!("[reveal_in_folder] Explorer command spawned successfully");
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
        .title("快捷访问配置")
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
