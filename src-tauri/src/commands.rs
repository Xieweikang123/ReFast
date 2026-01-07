// 子命令模块
pub mod color_picker;

// 重新导出子模块中的所有命令
pub use color_picker::{show_color_picker_window, pick_color_from_screen};

use crate::app_search;
use crate::db;
use crate::everything_search;
use crate::everything_filters;
use crate::file_history;
use crate::hooks;
use crate::memos;
use crate::open_history;
use crate::plugin_usage;
use crate::word_records;
use crate::recording::{RecordingMeta, RecordingState};
use crate::replay::ReplayState;
use crate::settings;
use crate::shortcuts;
use crate::system_folders_search;
use crate::window_config;
use base64::{engine::general_purpose, Engine as _};
use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, UNIX_EPOCH};
use futures_util::StreamExt;
use std::hash::{Hash, Hasher};
use std::collections::hash_map::DefaultHasher;
use tauri::{async_runtime, Emitter, Manager};

static RECORDING_STATE: LazyLock<Arc<Mutex<RecordingState>>> =
    LazyLock::new(|| Arc::new(Mutex::new(RecordingState::new())));

static REPLAY_STATE: LazyLock<Arc<Mutex<ReplayState>>> =
    LazyLock::new(|| Arc::new(Mutex::new(ReplayState::new())));

pub(crate) static APP_CACHE: LazyLock<Arc<Mutex<Option<Arc<Vec<app_search::AppInfo>>>>>> =
    LazyLock::new(|| Arc::new(Mutex::new(None)));

// 搜索任务管理器：管理 Everything 搜索的取消标志
// 每次新搜索会将旧搜索的取消标志设为 true，从而让旧任务尽快退出
struct SearchTaskManager {
    cancel_flag: Option<Arc<AtomicBool>>,
    current_query: Option<String>, // 当前搜索的 query（含过滤拼装后的最终串），用于避免相同 query 的重复搜索
}

static SEARCH_TASK_MANAGER: LazyLock<Arc<Mutex<SearchTaskManager>>> = LazyLock::new(|| {
    Arc::new(Mutex::new(SearchTaskManager { 
        cancel_flag: None,
        current_query: None,
    }))
});

// 会话管理器：存储 Everything 搜索会话的结果
#[derive(Debug, Clone)]
struct SearchSession {
    query: String,
    results: Vec<everything_search::EverythingResult>,
    total_count: u32,
    created_at: std::time::Instant,
}

struct SearchSessionManager {
    sessions: std::collections::HashMap<String, SearchSession>,
}

static SEARCH_SESSION_MANAGER: LazyLock<Arc<Mutex<SearchSessionManager>>> = LazyLock::new(|| {
    Arc::new(Mutex::new(SearchSessionManager {
        sessions: std::collections::HashMap::new(),
    }))
});

/// 安全地获取 APP_CACHE 锁，自动处理 poisoned lock
/// 如果锁被 poisoned（之前的线程 panic），会恢复数据并继续使用
/// 这样可以防止因为一次 panic 导致整个应用无法使用缓存
/// 
/// 返回 Arc 的 clone，调用者需要自己 lock
fn get_app_cache() -> Arc<Mutex<Option<Arc<Vec<app_search::AppInfo>>>>> {
    APP_CACHE.clone()
}

/// 安全地 lock APP_CACHE，自动处理 poisoned lock
/// 接受 Arc 参数，返回 guard
fn lock_app_cache_safe(cache: &Arc<Mutex<Option<Arc<Vec<app_search::AppInfo>>>>>) -> MutexGuard<'_, Option<Arc<Vec<app_search::AppInfo>>>> {
    // 使用 unwrap_or_else 处理 poisoned lock：如果锁被 poisoned，恢复数据并继续使用
    // 当锁被 poisoned 时，into_inner() 会恢复数据并清除 poisoned 状态
    cache.lock().unwrap_or_else(|poisoned| {
        // 锁被 poisoned，恢复数据（这会清除 poisoned 状态）
        let _recovered = poisoned.into_inner();
        // 重新获取锁（这次应该成功，因为 poisoned 状态已被清除）
        // 如果再次失败（理论上不应该发生），会 panic
        cache.lock().expect("无法恢复 poisoned lock：锁状态异常")
    })
}

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

/// 统一的窗口显示辅助函数
/// 
/// 处理窗口的显示、取消最小化和聚焦逻辑，确保窗口正确显示在最前面
/// 
/// # 参数
/// - `window`: Tauri 窗口引用
/// 
/// # 返回
/// - `Ok(())`: 窗口成功显示并聚焦
/// - `Err(String)`: 操作失败的错误信息
pub(crate) fn show_and_focus_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    // 1. 先取消最小化（如果窗口被最小化）
    //    unminimize() 对未最小化的窗口调用是安全的，不会产生副作用
    window.unminimize().map_err(|e| format!("Failed to unminimize window: {}", e))?;
    
    // 2. 显示窗口（如果窗口被隐藏）
    window.show().map_err(|e| format!("Failed to show window: {}", e))?;
    
    // 3. 将窗口聚焦到前台
    window.set_focus().map_err(|e| format!("Failed to focus window: {}", e))?;
    
    Ok(())
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
pub async fn scan_applications(app: tauri::AppHandle) -> Result<Vec<app_search::AppInfo>, String> {
    let app_clone = app.clone();
    async_runtime::spawn_blocking(move || {
        let cache = get_app_cache();
        
        // 先检查缓存是否已存在（快速路径）
        {
            let cache_guard = lock_app_cache_safe(&cache);
            if let Some(ref cached_apps) = *cache_guard {
                // Return cached apps if available (Arc 共享引用，只增加引用计数)
                let apps_vec: Vec<app_search::AppInfo> = (**cached_apps).clone();
                return Ok(apps_vec);
            }
            // 锁在这里自动释放
        }

        // 缓存不存在，需要扫描或从磁盘加载
        // ⚠️ 重要：在扫描期间不持有锁，避免阻塞其他操作
        let app_data_dir = get_app_data_dir(&app_clone)?;
        let apps_vec = if let Ok(disk_cache) = app_search::windows::load_cache(&app_data_dir) {
            if !disk_cache.is_empty() {
                disk_cache
            } else {
                // Scan applications (potentially slow) - 在没有锁的情况下执行
                app_search::windows::scan_start_menu(None)?
            }
        } else {
            // Scan applications (potentially slow) - 在没有锁的情况下执行
            app_search::windows::scan_start_menu(None)?
        };

        // 扫描完成后，更新缓存（持有锁的时间很短）
        {
            let mut cache_guard = lock_app_cache_safe(&cache);
            *cache_guard = Some(Arc::new(apps_vec.clone()));
            // 锁在这里自动释放
        }

        // Save to disk cache (including builtin apps)
        let _ = app_search::windows::save_cache(&app_data_dir, &apps_vec);

        // No background icon extraction - icons will be extracted on-demand during search
        Ok(apps_vec)
    })
    .await
    .map_err(|e| format!("scan_applications join error: {}", e))?
}

/// 测试命令：验证 UWP 应用扫描结果，特别是中文编码
#[tauri::command]
pub async fn test_uwp_apps_scan() -> Result<Vec<app_search::AppInfo>, String> {
    async_runtime::spawn_blocking(move || {
        match app_search::windows::scan_uwp_apps_direct() {
            Ok(apps) => {
                eprintln!("[test_uwp_apps_scan] 扫描到 {} 个 UWP 应用", apps.len());
                
                // 统计中文应用
                let chinese_apps: Vec<_> = apps.iter()
                    .filter(|app| {
                        app.name.chars().any(|c| {
                            matches!(c as u32,
                                0x4E00..=0x9FFF |  // CJK Unified Ideographs
                                0x3400..=0x4DBF |  // CJK Extension A
                                0x20000..=0x2A6DF | // CJK Extension B
                                0x2A700..=0x2B73F | // CJK Extension C
                                0x2B740..=0x2B81F | // CJK Extension D
                                0xF900..=0xFAFF |  // CJK Compatibility Ideographs
                                0x2F800..=0x2FA1F   // CJK Compatibility Ideographs Supplement
                            )
                        })
                    })
                    .collect();
                
                eprintln!("[test_uwp_apps_scan] 其中包含中文的应用: {} 个", chinese_apps.len());
                
                // 输出前20个应用用于验证
                eprintln!("[test_uwp_apps_scan] 前20个应用列表:");
                for (idx, app) in apps.iter().take(20).enumerate() {
                    let has_chinese = chinese_apps.iter().any(|a| a.name == app.name);
                    eprintln!("[test_uwp_apps_scan]   {}. '{}' (path: {}, has_chinese: {})", 
                        idx + 1, app.name, app.path, has_chinese);
                }
                
                // 输出所有中文应用
                if !chinese_apps.is_empty() {
                    eprintln!("[test_uwp_apps_scan] 所有中文应用列表:");
                    for (idx, app) in chinese_apps.iter().enumerate() {
                        eprintln!("[test_uwp_apps_scan]   {}. '{}' (path: {}, pinyin: {:?}, initials: {:?})", 
                            idx + 1, app.name, app.path, app.name_pinyin, app.name_pinyin_initials);
                    }
                }
                
                Ok(apps)
            }
            Err(e) => {
                eprintln!("[test_uwp_apps_scan] 扫描失败: {}", e);
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| format!("test_uwp_apps_scan join error: {}", e))?
}

#[tauri::command]
pub async fn rescan_applications(app: tauri::AppHandle) -> Result<(), String> {
    // 获取所有可能的窗口，应用中心可能在启动器窗口或独立窗口中
    let windows_to_notify: Vec<_> = vec![
        app.get_webview_window("launcher"),
        app.get_webview_window("plugin-list-window"),
        app.get_webview_window("main"),
    ]
    .into_iter()
    .flatten()
    .collect();
    
    if windows_to_notify.is_empty() {
        return Err("无法获取窗口".to_string());
    }
    
    let app_clone = app.clone();
    
    // 立即返回，在后台执行扫描
    async_runtime::spawn(async move {
        // 创建通道用于传递进度信息（使用标准库通道，因为需要在阻塞线程中使用）
        let (tx, rx) = std::sync::mpsc::channel::<(u8, String)>();
        
        // 启动进度监听任务，向所有可能的窗口发送事件
        let windows_for_progress: Vec<_> = windows_to_notify.iter().map(|w| w.clone()).collect();
        async_runtime::spawn(async move {
            // 在异步上下文中轮询接收进度信息
            loop {
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok((progress, message)) => {
                        let event_data = serde_json::json!({
                            "progress": progress,
                            "message": message
                        });
                        // 向所有可能的窗口发送进度事件
                        for window in &windows_for_progress {
                            let _ = window.emit("app-rescan-progress", &event_data);
                        }
                        if progress >= 100 {
                            break;
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        // 超时，继续等待
                        continue;
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        // 发送端已关闭
                        break;
                    }
                }
            }
        });
        
        let scan_result = async_runtime::spawn_blocking(move || -> Result<Vec<app_search::AppInfo>, String> {
            let cache = get_app_cache();
            
            // Clear memory cache and disk cache
            {
                let mut cache_guard = lock_app_cache_safe(&cache);
                *cache_guard = None;
                // 锁在这里自动释放
            }

            let app_data_dir = get_app_data_dir(&app_clone).map_err(|e| format!("获取应用数据目录失败: {}", e))?;
            let cache_file = app_search::windows::get_cache_file_path(&app_data_dir);
            let _ = fs::remove_file(&cache_file); // Ignore errors if file doesn't exist

            // Force rescan with progress callback (在没有持有锁的情况下执行耗时的扫描)
            let apps_vec = app_search::windows::scan_start_menu(Some(tx))?;

            // Cache the results (快速更新缓存，持有锁的时间很短)
            {
                let mut cache_guard = lock_app_cache_safe(&cache);
                *cache_guard = Some(Arc::new(apps_vec.clone()));
                // 锁在这里自动释放
            }

            // Save to disk cache
            let _ = app_search::windows::save_cache(&app_data_dir, &apps_vec);

            Ok(apps_vec)
        })
        .await;
        
        // 在异步上下文中发送事件到所有可能的窗口
        let windows_for_result: Vec<_> = windows_to_notify.iter().map(|w| w.clone()).collect();
        match scan_result {
            Ok(Ok(apps)) => {
                let event_data = serde_json::json!({
                    "apps": apps
                });
                for window in &windows_for_result {
                    let _ = window.emit("app-rescan-complete", &event_data);
                }
            }
            Ok(Err(e)) => {
                let event_data = serde_json::json!({
                    "error": e
                });
                for window in &windows_for_result {
                    let _ = window.emit("app-rescan-error", &event_data);
                }
            }
            Err(e) => {
                let event_data = serde_json::json!({
                    "error": format!("扫描任务失败: {}", e)
                });
                for window in &windows_for_result {
                    let _ = window.emit("app-rescan-error", &event_data);
                }
            }
        }
    });
    
    Ok(())
}

#[tauri::command]
pub async fn search_applications(
    query: String,
    app: tauri::AppHandle,
) -> Result<Vec<app_search::AppInfo>, String> {
    eprintln!("[搜索应用] 函数被调用: query={}", query);
    let cache = get_app_cache();
    let app_handle_clone = app.clone();
    let query_clone = query.clone();
    
    // 在后台线程执行搜索，避免阻塞 UI
    let cache_for_search = cache.clone();
    let app_handle_for_scan = app_handle_clone.clone();
    
    let results = async_runtime::spawn_blocking(move || -> Result<Vec<app_search::AppInfo>, String> {
        let total_start = std::time::Instant::now();
        
        // 步骤1: 获取锁并读取数据，然后立即释放锁
        let lock_start = std::time::Instant::now();
        let apps = {
            let cache = get_app_cache();
            let mut cache_guard = lock_app_cache_safe(&cache);
            let lock_acquired = std::time::Instant::now();
            let lock_wait_time = lock_acquired.duration_since(lock_start);
            if lock_wait_time.as_millis() > 1 {
                eprintln!("[性能警告] 获取 APP_CACHE 锁等待时间: {:?}", lock_wait_time);
            }
            
            // 如果内存缓存为空，从磁盘加载
            let disk_load_start = std::time::Instant::now();
            if cache_guard.is_none() {
                let app_data_dir = get_app_data_dir(&app_handle_for_scan)?;
                if let Ok(disk_cache) = app_search::windows::load_cache(&app_data_dir) {
                    if !disk_cache.is_empty() {
                        *cache_guard = Some(Arc::new(disk_cache));
                    }
                }
            }
            let disk_load_time = disk_load_start.elapsed();
            if disk_load_time.as_millis() > 10 {
                eprintln!("[性能警告] 从磁盘加载缓存耗时: {:?}", disk_load_time);
            }
            
            // 获取应用列表的 Arc 引用（只增加引用计数，不克隆数据）
            let apps_arc = cache_guard
                .as_ref()
                .ok_or_else(|| "Applications not scanned yet. Call scan_applications first.".to_string())?
                .clone();  // 克隆 Arc，只增加引用计数，不克隆 Vec 数据
            
            let lock_held_time = std::time::Instant::now().duration_since(lock_acquired);
            if lock_held_time.as_millis() > 5 {
                eprintln!("[性能警告] 持有 APP_CACHE 锁时间: {:?}", lock_held_time);
            }
            
            apps_arc
        }; // 锁在这里释放
        let lock_total_time = std::time::Instant::now().duration_since(lock_start);
        
        // 步骤2: 先执行搜索（避免预先检查计算器，节省时间）
        let search_start = std::time::Instant::now();
        let mut results = app_search::windows::search_apps(&query_clone, apps.as_slice());
        let search_time = search_start.elapsed();
        
        // #region agent log
        use std::fs::OpenOptions;
        use std::io::Write;
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(r"d:\project\re-fast\.cursor\debug.log") {
            let _ = writeln!(file, r#"{{"id":"log_search_apps_1","timestamp":{},"location":"commands.rs:716","message":"search_applications search completed","data":{{"query":"{}","results_count":{},"apps_total":{}}},"sessionId":"debug-session","runId":"run1","hypothesisId":"A"}}"#, 
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(),
                query_clone, results.len(), apps.len());
            // 记录前5个搜索结果
            for (idx, r) in results.iter().take(5).enumerate() {
                let _ = writeln!(file, r#"{{"id":"log_search_apps_2","timestamp":{},"location":"commands.rs:722","message":"search result","data":{{"idx":{},"name":"{}","path":"{}","has_icon":{}}},"sessionId":"debug-session","runId":"run1","hypothesisId":"A"}}"#, 
                    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(),
                    idx, r.name, r.path, r.icon.is_some());
            }
            // 检查是否有 iTunes 相关的应用
            let itunes_apps: Vec<_> = apps.iter().filter(|a| a.name.to_lowercase().contains("itunes")).collect();
            if !itunes_apps.is_empty() {
                for (idx, app) in itunes_apps.iter().enumerate() {
                    let _ = writeln!(file, r#"{{"id":"log_search_apps_3","timestamp":{},"location":"commands.rs:730","message":"iTunes app found in cache","data":{{"idx":{},"name":"{}","path":"{}","has_icon":{}}},"sessionId":"debug-session","runId":"run1","hypothesisId":"A"}}"#, 
                        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(),
                        idx, app.name, app.path, app.icon.is_some());
                }
            } else {
                let _ = writeln!(file, r#"{{"id":"log_search_apps_4","timestamp":{},"location":"commands.rs:737","message":"iTunes app NOT found in cache","data":{{"query":"{}"}},"sessionId":"debug-session","runId":"run1","hypothesisId":"A"}}"#, 
                    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(),
                    query_clone);
            }
        }
        // #endregion
        
        let total_time = std::time::Instant::now().duration_since(total_start);
        
        // 步骤3: 如果查询非空，检查是否需要添加内置计算器
        if !query_clone.trim().is_empty() {
            let query_lower = query_clone.to_lowercase();
            // 检查查询是否匹配计算器相关关键词
            let query_matches_calculator = query_lower == "计算器" || query_lower == "calculator" ||
                query_lower == "jsq" || query_lower == "jisuanqi" ||
                query_lower.contains("计算器") || query_lower.contains("calculator");
            
            // 只在查询匹配计算器时才检查结果中是否有计算器
            if query_matches_calculator {
                let has_calculator_in_results = results.iter().any(|app| {
                    let name_lower = app.name.to_lowercase();
                    name_lower == "计算器" || name_lower == "calculator" ||
                    name_lower.contains("计算器") || name_lower.contains("calculator")
                });
                
                // 如果结果中没有计算器，添加内置计算器
                if !has_calculator_in_results {
                    let builtin_calculator = app_search::AppInfo {
                        name: "计算器".to_string(),
                        path: "shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App".to_string(),
                        icon: None,
                        description: Some("Windows 计算器".to_string()),
                        name_pinyin: Some("jisuanqi".to_string()),
                        name_pinyin_initials: Some("jsq".to_string()),
                    };
                    // 插入到结果开头（最高优先级）
                    results.insert(0, builtin_calculator);
                }
            }
        }
        
        Ok(results)
    })
    .await
    .map_err(|e| format!("搜索任务失败: {}", e))??;
    
    eprintln!("[搜索应用] 搜索完成: 结果数量={}", results.len());
    
    // 优化：先返回搜索结果，图标提取完全在后台异步执行，不阻塞搜索返回
    // 克隆需要的数据用于后台线程
    let results_clone = results.clone();
    let cache_clone = cache.clone();
    let app_handle_for_emit = app_handle_clone.clone();
    let app_handle_for_save = app_handle_clone.clone();
    
    // 在后台线程中异步处理图标提取，不阻塞搜索返回
    std::thread::spawn(move || {
        // #region agent log
        use std::fs::OpenOptions;
        use std::io::Write;
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(r"d:\project\re-fast\.cursor\debug.log") {
            let _ = writeln!(file, r#"{{"id":"log_extract_icons_1","timestamp":{},"location":"commands.rs:902","message":"extract_icons_for_results entry","data":{{"results_count":{},"results_with_icons":{},"results_without_icons":{}}},"sessionId":"debug-session","runId":"run1","hypothesisId":"A"}}"#, 
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(),
                results_clone.len(),
                results_clone.iter().filter(|r| r.icon.is_some()).count(),
                results_clone.iter().filter(|r| r.icon.is_none()).count());
        }
        // #endregion
        
        // 筛选出缺少图标的应用，并去重（在后台线程中执行，不阻塞搜索返回）
        eprintln!("[图标提取] 开始筛选缺少图标的应用: 搜索结果总数={}", results_clone.len());
        let results_with_icons = results_clone.iter().filter(|r| r.icon.is_some()).count();
        let results_without_icons = results_clone.iter().filter(|r| r.icon.is_none()).count();
        eprintln!("[图标提取] 搜索结果统计: 有图标={}, 缺少图标={}", results_with_icons, results_without_icons);
        
        // 筛选出缺少图标的应用，同时检查缓存中是否已标记为失败
        let mut results_paths: Vec<String> = {
            let cache_guard_for_filter = cache_clone.lock().ok();
            results_clone
                .iter()
                .filter(|r| {
                    // 先检查搜索结果中的 icon 字段
                    let missing_icon_in_result = r.icon.is_none();
                    
                    // 如果搜索结果中没有图标，再检查缓存中是否已标记为失败
                    if missing_icon_in_result {
                        // 检查缓存中是否已标记为失败
                        if let Some(ref guard) = cache_guard_for_filter {
                            if let Some(ref apps_arc) = **guard {
                                if let Some(app) = apps_arc.iter().find(|a| a.path == r.path) {
                                    if app_search::windows::is_icon_extraction_failed(&app.icon) {
                                        eprintln!("[图标提取] 搜索结果中缺少图标，但缓存中已标记为失败，跳过: name={}, path={}", r.name, r.path);
                                        return false; // 已标记为失败，跳过
                                    }
                                    if !app_search::windows::needs_icon_extraction(&app.icon) {
                                        eprintln!("[图标提取] 搜索结果中缺少图标，但缓存中已有图标，跳过: name={}, path={}", r.name, r.path);
                                        return false; // 缓存中已有图标，跳过
                                    }
                                }
                            }
                        }
                        eprintln!("[图标提取] 搜索结果缺少图标: name={}, path={}", r.name, r.path);
                        true
                    } else {
                        false
                    }
                })
                .map(|r| r.path.clone())
                .collect()
            // cache_guard_for_filter 在这里自动释放
        };
        
        eprintln!("[图标提取] 筛选完成: 缺少图标的应用数量={}", results_paths.len());
        
        // 去重：移除重复的路径
        results_paths.sort();
        results_paths.dedup();
        
        // #region agent log
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(r"d:\project\re-fast\.cursor\debug.log") {
            let _ = writeln!(file, r#"{{"id":"log_extract_icons_3","timestamp":{},"location":"commands.rs:950","message":"results_paths collected","data":{{"paths_count":{}}},"sessionId":"debug-session","runId":"run1","hypothesisId":"A"}}"#, 
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(),
                results_paths.len());
        }
        // #endregion
        
        // 先检查缓存中是否已有图标，避免重复提取
        let mut paths_to_extract: Vec<String> = {
            let cache_guard = cache_clone.lock().ok();
            if let Some(guard) = cache_guard {
                if let Some(ref apps_arc) = *guard {
                    // 过滤出缓存中确实没有图标的应用（排除已标记为失败的应用）
                    results_paths.iter()
                        .filter(|path_str| {
                            let need_extract: bool = apps_arc.iter()
                                .find(|a| a.path == **path_str)
                                .map(|a| {
                                    let needs_extract = app_search::windows::needs_icon_extraction(&a.icon);
                                    if needs_extract {
                                        eprintln!("[图标提取] 缓存中缺少图标: path={}", path_str);
                                    } else if app_search::windows::is_icon_extraction_failed(&a.icon) {
                                        eprintln!("[图标提取] 缓存中已标记为提取失败，跳过: path={}", path_str);
                                    } else {
                                        eprintln!("[图标提取] 缓存中已有图标，跳过: path={}", path_str);
                                    }
                                    needs_extract
                                })
                                .unwrap_or_else(|| {
                                    eprintln!("[图标提取] 缓存中未找到应用，需要提取: path={}", path_str);
                                    true // 如果找不到应用，需要提取
                                });
                            need_extract
                        })
                        .cloned()
                        .collect()
                } else {
                    eprintln!("[图标提取] 缓存为空，需要提取所有图标: paths_count={}", results_paths.len());
                    results_paths
                }
            } else {
                eprintln!("[图标提取] 无法获取缓存锁，需要提取所有图标: paths_count={}", results_paths.len());
                results_paths
            }
        };
        
        // 再次去重，确保没有重复路径（防止并发情况下的重复提取）
        let before_final_dedup = paths_to_extract.len();
        paths_to_extract.sort();
        paths_to_extract.dedup();
        let after_final_dedup = paths_to_extract.len();
        if before_final_dedup != after_final_dedup {
            eprintln!("[图标提取] 最终去重：去重前: {}, 去重后: {}, 移除重复: {}", 
                before_final_dedup, after_final_dedup, before_final_dedup - after_final_dedup);
        }
        
        if paths_to_extract.is_empty() {
            eprintln!("[图标提取] 所有应用的图标都在缓存中，无需提取");
            return;
        }
        
        eprintln!("[图标提取] 需要提取图标的应用数量: {}", paths_to_extract.len());
        
        // 先提取所有图标（不持有锁），避免阻塞搜索操作
        let mut icon_updates: Vec<(String, String)> = Vec::new(); // (path, icon_data)
        let mut failed_paths: Vec<String> = Vec::new(); // 记录提取失败的路径
        
        for (idx, path_str) in paths_to_extract.iter().enumerate() {
            eprintln!("[图标提取] 开始提取图标 [{}/{}]: path={}", idx + 1, paths_to_extract.len(), path_str);
            
            let path_lower = path_str.to_lowercase();
            let icon = if path_lower.starts_with("shell:appsfolder\\") {
                // #region agent log
                use std::fs::OpenOptions;
                use std::io::Write;
                if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(r"d:\project\re-fast\.cursor\debug.log") {
                    let _ = writeln!(file, r#"{{"id":"log_uwp_icon_cmd_1","timestamp":{},"location":"commands.rs:781","message":"extracting icon for UWP app","data":{{"path":"{}"}},"sessionId":"debug-session","runId":"run1","hypothesisId":"A"}}"#, 
                        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(), path_str);
                }
                // #endregion
                // UWP app - extract icon using special method
                let icon_result = app_search::windows::extract_uwp_app_icon_base64(&path_str);
                // #region agent log
                if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(r"d:\project\re-fast\.cursor\debug.log") {
                    let icon_success = icon_result.is_some();
                    let icon_len = icon_result.as_ref().map(|s| s.len()).unwrap_or(0);
                    let _ = writeln!(file, r#"{{"id":"log_uwp_icon_cmd_2","timestamp":{},"location":"commands.rs:785","message":"icon extraction result","data":{{"path":"{}","success":{},"icon_len":{}}},"sessionId":"debug-session","runId":"run1","hypothesisId":"A"}}"#, 
                        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(), 
                        path_str, icon_success, icon_len);
                }
                // #endregion
                icon_result
            } else {
                let path = std::path::Path::new(&path_str);
                let ext = path
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_lowercase());
                if ext == Some("lnk".to_string()) {
                    app_search::windows::extract_lnk_icon_base64(path)
                } else if ext == Some("exe".to_string()) {
                    app_search::windows::extract_icon_base64(path)
                } else if ext == Some("msc".to_string()) {
                    // .msc 文件（Microsoft Management Console）使用 Shell API 提取图标
                    app_search::windows::extract_icon_png_via_shell(path, 32)
                } else if ext == Some("url".to_string()) {
                    // .url 文件（Internet Shortcut）使用专门的解析和提取方法
                    app_search::windows::extract_url_icon_base64(path)
                } else {
                    None
                }
            };

            if let Some(icon_data) = icon {
                icon_updates.push((path_str.clone(), icon_data));
                eprintln!("[图标提取] 提取成功: path={}", path_str);
            } else {
                failed_paths.push(path_str.clone());
                eprintln!("[图标提取] 提取失败，将标记为失败: path={}", path_str);
            }
        }

        // 更新缓存：成功提取的图标和失败标记
        if !icon_updates.is_empty() || !failed_paths.is_empty() {
            let mut updated = false;
            // Get current cache - 只在更新时持有锁，时间尽可能短
            if let Ok(mut guard) = cache_clone.lock() {
                if let Some(ref apps_arc) = *guard {
                    // 克隆 Vec 以便修改
                    let mut apps: Vec<app_search::AppInfo> = (**apps_arc).clone();
                    
                    // 更新缓存中的图标（成功提取的）
                    for (path_str, icon_data) in &icon_updates {
                        if let Some(app) = apps.iter_mut().find(|a| a.path == *path_str) {
                            app.icon = Some(icon_data.clone());
                            updated = true;
                        }
                    }
                    
                    // 标记提取失败的路径
                    for path_str in &failed_paths {
                        if let Some(app) = apps.iter_mut().find(|a| a.path == *path_str) {
                            app.icon = Some(app_search::windows::ICON_EXTRACTION_FAILED_MARKER.to_string());
                            updated = true;
                            eprintln!("[图标提取] 已标记为提取失败: path={}", path_str);
                        }
                    }

                    // Save to disk if updated
                    if updated {
                        // 更新缓存（用新的 Arc 替换）
                        *guard = Some(Arc::new(apps.clone()));
                        if let Ok(app_data_dir) = get_app_data_dir(&app_handle_for_save) {
                            let _ = app_search::windows::save_cache(&app_data_dir, &apps);
                        }
                    }
                }
            }

            // 发送事件通知前端图标已更新（只发送成功提取的图标）
            if !icon_updates.is_empty() {
                if let Err(e) = app_handle_for_emit.emit("app-icons-updated", icon_updates) {
                    eprintln!("Failed to emit app-icons-updated event: {}", e);
                }
            }
        }
    });

    Ok(results)
}

#[tauri::command]
pub fn search_system_folders(query: String) -> Result<Vec<system_folders_search::windows::SystemFolderItem>, String> {
    let results = system_folders_search::windows::search_system_folders(&query);
    Ok(results)
}

/// Populate icons for cached applications (best-effort, limited to avoid long blocks).
/// Returns the updated app list (with any newly extracted icons).
#[tauri::command]
pub async fn populate_app_icons(
    app: tauri::AppHandle,
    limit: Option<usize>,
) -> Result<Vec<app_search::AppInfo>, String> {
    let app_clone = app.clone();
    async_runtime::spawn_blocking(move || {
        let max_to_process = limit.unwrap_or(100);

        let cache = get_app_cache();
        
        // 快速获取应用列表的副本，然后立即释放锁
        let mut apps: Vec<app_search::AppInfo> = {
            let cache_guard = lock_app_cache_safe(&cache);
            let apps_arc = cache_guard.as_ref().ok_or_else(|| {
                "Applications not scanned yet. Call scan_applications first.".to_string()
            })?;
            // 克隆 Vec 以便修改
            (**apps_arc).clone()
            // 锁在这里自动释放
        };

        // 在没有持有锁的情况下提取图标（这是耗时操作）
        let mut processed = 0usize;
        let mut updated = false;

        for app_info in apps.iter_mut() {
            if processed >= max_to_process {
                break;
            }

            // 如果应用已经有图标或已标记为失败，跳过提取
            if !app_search::windows::needs_icon_extraction(&app_info.icon) {
                processed += 1;
                continue;
            } else {
                eprintln!("[图标提取] 应用无图标: name={}, path={}", app_info.name, app_info.path);
            }

            let path = Path::new(&app_info.path);
            let path_str = app_info.path.to_lowercase();
            
            // #region agent log
            eprintln!("[图标提取] 处理应用: name={}, path={}, has_existing_icon={}", 
                app_info.name, app_info.path, app_info.icon.is_some());
            // #endregion
            
            let icon = if path_str.starts_with("shell:appsfolder\\") {
                // UWP app - extract icon using special method
                app_search::windows::extract_uwp_app_icon_base64(&app_info.path)
            } else {
                let ext = path
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_lowercase());
                
                if ext == Some("lnk".to_string()) {
                    app_search::windows::extract_lnk_icon_base64(path)
                } else if ext == Some("exe".to_string()) {
                    app_search::windows::extract_icon_base64(path)
                } else if ext == Some("msc".to_string()) {
                    // .msc 文件（Microsoft Management Console）使用 Shell API 提取图标
                    app_search::windows::extract_icon_png_via_shell(path, 32)
                } else if ext == Some("url".to_string()) {
                    // .url 文件（Internet Shortcut）使用专门的解析和提取方法
                    app_search::windows::extract_url_icon_base64(path)
                } else {
                    None
                }
            };

            // #region agent log
            let icon_extracted = icon.is_some();
            let icon_len = icon.as_ref().map(|s| s.len()).unwrap_or(0);
            eprintln!("[图标提取] 提取结果: name={}, path={}, icon_extracted={}, icon_len={}", 
                app_info.name, app_info.path, icon_extracted, icon_len);
            // #endregion

            // 更新应用信息：成功提取图标或标记为失败
            if let Some(icon_data) = icon {
                app_info.icon = Some(icon_data);
                updated = true;
            } else {
                // 提取失败，标记为失败以避免重复尝试
                app_info.icon = Some(app_search::windows::ICON_EXTRACTION_FAILED_MARKER.to_string());
                updated = true;
                eprintln!("[图标提取] 已标记为提取失败: name={}, path={}", app_info.name, app_info.path);
            }

            processed += 1;
        }

        if updated {
            // 快速更新缓存，持有锁的时间很短
            {
                let mut cache_guard = lock_app_cache_safe(&cache);
                *cache_guard = Some(Arc::new(apps.clone()));
                // 锁在这里自动释放
            }
            let app_data_dir = get_app_data_dir(&app_clone)?;
            let _ = app_search::windows::save_cache(&app_data_dir, &apps);
        }

        Ok(apps)
    })
    .await
    .map_err(|e| format!("populate_app_icons join error: {}", e))?
}

#[tauri::command]
pub fn launch_application(app: app_search::AppInfo) -> Result<(), String> {
    app_search::windows::launch_app(&app)
}

/// 从应用索引中删除指定的应用
#[tauri::command]
pub async fn remove_app_from_index(app_path: String, app: tauri::AppHandle) -> Result<(), String> {
    let app_clone = app.clone();
    async_runtime::spawn_blocking(move || {
        let cache = get_app_cache();
        let mut cache_guard = lock_app_cache_safe(&cache);

        let apps_arc = cache_guard.as_ref().ok_or_else(|| {
            "Applications not scanned yet. Call scan_applications first.".to_string()
        })?;

        // 克隆 Vec 以便修改
        let mut apps: Vec<app_search::AppInfo> = (**apps_arc).clone();
        let initial_len = apps.len();
        apps.retain(|app_info| app_info.path != app_path);
        
        // 如果应用不在索引中，这实际上是我们想要的状态，所以返回成功而不是错误
        if apps.len() == initial_len {
            // 应用已经不在索引中，这是一个幂等操作，返回成功
            println!("[删除应用] 应用不在索引中（可能已被删除）: {}", app_path);
            return Ok(());
        }

        // 更新缓存（用新的 Arc 替换）
        *cache_guard = Some(Arc::new(apps.clone()));
        
        // 保存更新后的缓存到磁盘
        let app_data_dir = get_app_data_dir(&app_clone)?;
        let _ = app_search::windows::save_cache(&app_data_dir, &apps);

        println!("[删除应用] 成功从索引中删除: {}", app_path);
        Ok(())
    })
    .await
    .map_err(|e| format!("remove_app_from_index join error: {}", e))?
}

/// 调试命令：查找指定名称的应用并尝试提取图标，返回详细信息
#[tauri::command]
pub async fn debug_app_icon(app_name: String, _app: tauri::AppHandle) -> Result<String, String> {
    use std::path::Path;
    
    // 在后台线程执行耗时操作，避免阻塞 UI
    async_runtime::spawn_blocking(move || {
        let cache = get_app_cache();
        let cache_guard = lock_app_cache_safe(&cache);
        
        let apps = cache_guard
            .as_ref()
            .ok_or_else(|| "Applications not scanned yet. Call scan_applications first.".to_string())?;
        
        // 查找匹配的应用（不区分大小写）
        let matched_apps: Vec<_> = apps
            .iter()
            .filter(|a| a.name.to_lowercase().contains(&app_name.to_lowercase()))
            .collect();
        
        if matched_apps.is_empty() {
            return Err(format!("未找到名称包含 '{}' 的应用", app_name));
        }
        
        let mut result = String::new();
        result.push_str(&format!("找到 {} 个匹配的应用:\n\n", matched_apps.len()));
        
        for (idx, app_info) in matched_apps.iter().enumerate() {
            result.push_str(&format!("[{}/{}] {}\n", idx + 1, matched_apps.len(), app_info.name));
            result.push_str(&format!("  路径: {}\n", app_info.path));
            result.push_str(&format!("  图标状态: {}\n", 
                if app_info.icon.is_some() { "已缓存" } else { "未提取" }));
            
            let path = Path::new(&app_info.path);
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_lowercase());
            
            result.push_str(&format!("  文件扩展名: {}\n", 
                ext.as_ref().map(|s| s.as_str()).unwrap_or("无")));
            
            // 尝试提取图标（这是耗时操作）
            if app_info.icon.is_none() {
                result.push_str("  正在尝试提取图标...\n");
                let icon_result = if ext == Some("lnk".to_string()) {
                    app_search::windows::extract_lnk_icon_base64(path)
                } else if ext == Some("exe".to_string()) {
                    app_search::windows::extract_icon_base64(path)
                } else if ext == Some("msc".to_string()) {
                    // .msc 文件（Microsoft Management Console）使用 Shell API 提取图标
                    app_search::windows::extract_icon_png_via_shell(path, 32)
                } else if ext == Some("url".to_string()) {
                    // .url 文件（Internet Shortcut）使用专门的解析和提取方法
                    app_search::windows::extract_url_icon_base64(path)
                } else {
                    None
                };
                
                if let Some(icon) = icon_result {
                    result.push_str("  ✓ 图标提取成功！\n");
                    result.push_str(&format!("  图标数据长度: {} 字节\n", icon.len()));
                } else {
                    result.push_str("  ✗ 图标提取失败\n");
                    result.push_str("  请查看控制台日志获取详细错误信息\n");
                }
            } else {
                result.push_str(&format!("  已缓存图标数据长度: {} 字节\n", 
                    app_info.icon.as_ref().unwrap().len()));
            }
            
            result.push_str("\n");
        }
        
        Ok(result)
    })
    .await
    .map_err(|e| format!("debug_app_icon join error: {}", e))?
}

/// 从文件路径提取图标（用于动态提取不在应用列表中的应用图标）
/// 如果成功提取到图标，会自动将应用添加到应用列表中
#[tauri::command]
pub async fn extract_icon_from_path(file_path: String, app: tauri::AppHandle) -> Result<Option<String>, String> {
    use std::path::Path;
    
    // #region agent log
    use std::fs::OpenOptions;
    use std::io::Write;
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(r"d:\project\re-fast\.cursor\debug.log") {
        let _ = writeln!(file, r#"{{"id":"log_extract_icon_path_1","timestamp":{},"location":"commands.rs:1118","message":"extract_icon_from_path entry","data":{{"file_path":"{}"}},"sessionId":"debug-session","runId":"run1","hypothesisId":"A"}}"#, 
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(), file_path);
    }
    // #endregion
    
    let app_clone = app.clone();
    let file_path_clone = file_path.clone();
    
    // 在后台线程执行耗时操作，避免阻塞 UI
    let icon_result = async_runtime::spawn_blocking(move || {
        // 先检查缓存中是否已经标记为提取失败或已有有效图标
        let cache = get_app_cache();
        let cache_guard = lock_app_cache_safe(&cache);
        if let Some(ref apps_arc) = *cache_guard {
            if let Some(app) = apps_arc.iter().find(|a| a.path == file_path) {
                // 如果已标记为提取失败，直接返回 None，避免重复提取
                if app_search::windows::is_icon_extraction_failed(&app.icon) {
                    eprintln!("[extract_icon_from_path] 缓存中已标记为提取失败，跳过: path={}", file_path);
                    return Ok::<Option<String>, String>(None);
                }
                // 如果缓存中已有有效图标，直接返回，避免重复提取
                if let Some(ref icon) = app.icon {
                    if !app_search::windows::needs_icon_extraction(&app.icon) {
                        eprintln!("[extract_icon_from_path] 缓存中已有图标，直接返回: path={}", file_path);
                        return Ok::<Option<String>, String>(Some(icon.clone()));
                    }
                }
            }
        }
        drop(cache_guard); // 释放锁，避免在后续操作中持有锁
        
        let path = Path::new(&file_path);
        let path_lower = file_path.to_lowercase();
        
        // #region agent log
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(r"d:\project\re-fast\.cursor\debug.log") {
            let _ = writeln!(file, r#"{{"id":"log_extract_icon_path_2","timestamp":{},"location":"commands.rs:1128","message":"determining icon extraction method","data":{{"file_path":"{}","is_uwp":{}}},"sessionId":"debug-session","runId":"run1","hypothesisId":"A"}}"#, 
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(), 
                file_path, path_lower.starts_with("shell:appsfolder\\"));
        }
        // #endregion
        
        let icon = if path_lower.starts_with("shell:appsfolder\\") {
            // UWP app - extract icon using special method
            // #region agent log
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(r"d:\project\re-fast\.cursor\debug.log") {
                let _ = writeln!(file, r#"{{"id":"log_extract_icon_path_3","timestamp":{},"location":"commands.rs:1133","message":"calling extract_uwp_app_icon_base64","data":{{"file_path":"{}"}},"sessionId":"debug-session","runId":"run1","hypothesisId":"A"}}"#, 
                    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(), file_path);
            }
            // #endregion
            let icon_result = app_search::windows::extract_uwp_app_icon_base64(&file_path);
            // #region agent log
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(r"d:\project\re-fast\.cursor\debug.log") {
                let icon_success = icon_result.is_some();
                let icon_len = icon_result.as_ref().map(|s| s.len()).unwrap_or(0);
                let _ = writeln!(file, r#"{{"id":"log_extract_icon_path_4","timestamp":{},"location":"commands.rs:1138","message":"extract_uwp_app_icon_base64 result","data":{{"file_path":"{}","success":{},"icon_len":{}}},"sessionId":"debug-session","runId":"run1","hypothesisId":"A"}}"#, 
                    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(), 
                    file_path, icon_success, icon_len);
            }
            // #endregion
            icon_result
        } else {
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_lowercase());
            
            if ext == Some("lnk".to_string()) {
                app_search::windows::extract_lnk_icon_base64(path)
            } else if ext == Some("exe".to_string()) {
                app_search::windows::extract_icon_base64(path)
            } else if ext == Some("msc".to_string()) {
                // .msc 文件（Microsoft Management Console）使用 Shell API 提取图标
                app_search::windows::extract_icon_png_via_shell(path, 32)
            } else if ext == Some("url".to_string()) {
                // .url 文件（Internet Shortcut）使用专门的解析和提取方法
                app_search::windows::extract_url_icon_base64(path)
            } else {
                None
            }
        };
        
        Ok::<Option<String>, String>(icon)
    })
    .await
    .map_err(|e| format!("extract_icon_from_path join error: {}", e))??;
    
    // 无论成功还是失败，都将应用添加到缓存中（成功时添加图标，失败时标记为失败）
    let app_clone_for_add = app_clone.clone();
    let file_path_for_add = file_path_clone.clone();
    let icon_result_clone = icon_result.clone();
    
    // 在后台线程执行添加操作
    async_runtime::spawn_blocking(move || {
        let cache = get_app_cache();
        let mut cache_guard = lock_app_cache_safe(&cache);
        
        // 确保缓存已初始化
        if cache_guard.is_none() {
            let app_data_dir = match get_app_data_dir(&app_clone_for_add) {
                Ok(dir) => dir,
                Err(e) => {
                    eprintln!("[添加应用到列表] 获取应用数据目录失败: {}", e);
                    return;
                }
            };
            if let Ok(disk_cache) = app_search::windows::load_cache(&app_data_dir) {
                if !disk_cache.is_empty() {
                    *cache_guard = Some(Arc::new(disk_cache));
                }
            }
        }
        
        let mut apps: Vec<app_search::AppInfo> = if let Some(ref apps_arc) = *cache_guard {
            (**apps_arc).clone()
        } else {
            Vec::new()
        };
        
        // 检查应用是否已存在（通过路径比较）
        let existing_index = apps.iter().position(|a| a.path == file_path_for_add);
        
        let mut updated = false;
        let mut icon_to_save: Option<String> = None;
        
        if let Some(index) = existing_index {
            // 应用已存在，更新图标或失败标记
            if let Some(icon_data) = &icon_result_clone {
                apps[index].icon = Some(icon_data.clone());
                icon_to_save = Some(icon_data.clone());
                eprintln!("[添加应用到列表] 更新已存在应用的图标: path={}", file_path_for_add);
            } else {
                // 提取失败，标记为失败
                apps[index].icon = Some(app_search::windows::ICON_EXTRACTION_FAILED_MARKER.to_string());
                eprintln!("[添加应用到列表] 标记已存在应用为提取失败: path={}", file_path_for_add);
            }
            updated = true;
        } else {
            // 应用不存在，创建新的 AppInfo
            let path = Path::new(&file_path_for_add);
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_lowercase());
            
            // 获取应用名称
            let name = if ext == Some("lnk".to_string()) {
                // 对于 .lnk 文件，尝试解析快捷方式获取名称
                match app_search::windows::parse_lnk_file(path) {
                    Ok(lnk_info) => lnk_info.name,
                    Err(_) => path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("Unknown")
                        .to_string(),
                }
            } else {
                // 对于 .exe 文件，使用文件名（不含扩展名）
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Unknown")
                    .to_string()
            };
            
            // 计算拼音（如果需要）
            let contains_chinese = |text: &str| -> bool {
                text.chars().any(|c| {
                    matches!(c as u32,
                        0x4E00..=0x9FFF |  // CJK Unified Ideographs
                        0x3400..=0x4DBF |  // CJK Extension A
                        0x20000..=0x2A6DF | // CJK Extension B
                        0x2A700..=0x2B73F | // CJK Extension C
                        0x2B740..=0x2B81F | // CJK Extension D
                        0xF900..=0xFAFF |  // CJK Compatibility Ideographs
                        0x2F800..=0x2FA1F   // CJK Compatibility Ideographs Supplement
                    )
                })
            };
            
            let to_pinyin = |text: &str| -> String {
                use pinyin::ToPinyin;
                text.to_pinyin()
                    .filter_map(|p| p.map(|p| p.plain()))
                    .collect::<Vec<_>>()
                    .join("")
            };
            
            let to_pinyin_initials = |text: &str| -> String {
                use pinyin::ToPinyin;
                text.to_pinyin()
                    .filter_map(|p| p.map(|p| p.plain().chars().next()))
                    .flatten()
                    .collect::<String>()
            };
            
            let (name_pinyin, name_pinyin_initials) = if contains_chinese(&name) {
                (
                    Some(to_pinyin(&name).to_lowercase()),
                    Some(to_pinyin_initials(&name).to_lowercase()),
                )
            } else {
                (None, None)
            };
            
            // 创建新的 AppInfo（成功时添加图标，失败时标记为失败）
            let icon_value = if let Some(icon_data) = &icon_result_clone {
                icon_to_save = Some(icon_data.clone());
                Some(icon_data.clone())
            } else {
                Some(app_search::windows::ICON_EXTRACTION_FAILED_MARKER.to_string())
            };
            
            let new_app = app_search::AppInfo {
                name,
                path: file_path_for_add.clone(),
                icon: icon_value,
                description: None,
                name_pinyin,
                name_pinyin_initials,
            };
            
            apps.push(new_app);
            eprintln!("[添加应用到列表] 添加新应用: path={}, icon_extracted={}", file_path_for_add, icon_result_clone.is_some());
            updated = true;
        }
        
        if updated {
            // 更新缓存
            *cache_guard = Some(Arc::new(apps.clone()));
            
            // 保存到磁盘
            if let Ok(app_data_dir) = get_app_data_dir(&app_clone_for_add) {
                if let Err(e) = app_search::windows::save_cache(&app_data_dir, &apps) {
                    eprintln!("[添加应用到列表] 保存缓存失败: {}", e);
                }
            }
            
            // 如果成功提取到图标，发送事件通知前端图标已更新
            if let Some(icon_data) = icon_to_save {
                let icon_updates = vec![(file_path_for_add.clone(), icon_data)];
                if let Err(e) = app_clone_for_add.emit("app-icons-updated", icon_updates) {
                    eprintln!("[添加应用到列表] 发送事件失败: {}", e);
                }
            }
        }
    });
    
    Ok(icon_result)
}

/// 测试所有图标提取方法，返回每种方法的结果
/// 对于 .exe 和 .lnk 文件，使用与应用索引列表完全相同的提取逻辑
#[tauri::command]
pub async fn test_all_icon_extraction_methods(file_path: String) -> Result<Vec<(String, Option<String>)>, String> {
    use std::path::Path;
    
    let results = async_runtime::spawn_blocking(move || {
        let path = Path::new(&file_path);
        
        if !path.exists() {
            return Err(format!("文件不存在: {}", file_path));
        }
        
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase());
        
        // 使用与应用索引列表完全相同的提取逻辑
        if ext == Some("lnk".to_string()) {
            // 对于 .lnk 文件，先显示实际使用的提取方法（与应用索引列表一致）
            let mut results = Vec::new();
            
            // 实际使用的方法（与应用索引列表完全一致）
            let actual_result = app_search::windows::extract_lnk_icon_base64(path);
            results.push(("实际使用的方法 (extract_lnk_icon_base64)".to_string(), actual_result));
            
            // 然后显示所有测试方法（用于调试）
            let test_results = app_search::windows::test_all_icon_extraction_methods(path);
            results.extend(test_results);
            
            Ok(results)
        } else if ext == Some("exe".to_string()) {
            // 对于 .exe 文件，使用与应用索引列表完全相同的提取逻辑
            let mut results = Vec::new();

            // 实际使用的方法（与应用索引列表完全一致）
            // 这是应用索引列表使用的唯一方法
            let actual_result = app_search::windows::extract_icon_base64(path);
            results.push(("实际使用的方法 (extract_icon_base64)".to_string(), actual_result));

            Ok(results)
        } else if ext == Some("msc".to_string()) {
            // 对于 .msc 文件，使用 Shell API 提取图标
            let mut results = Vec::new();

            // 实际使用的方法
            let actual_result = app_search::windows::extract_icon_png_via_shell(path, 32);
            results.push(("实际使用的方法 (extract_icon_png_via_shell)".to_string(), actual_result));

            Ok(results)
        } else {
            Err(format!("不支持的文件类型: {:?}", ext))
        }
    })
    .await
    .map_err(|e| format!("test_all_icon_extraction_methods join error: {}", e))??;
    
    Ok(results)
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

    // Write to open_history instead of file_history
    eprintln!("[commands::add_file_to_history] 被调用: {}", path);
    open_history::add_item(path, &app_data_dir)?;
    eprintln!("[commands::add_file_to_history] 完成");

    Ok(())
}

#[tauri::command]
pub async fn search_file_history(
    query: String,
    app: tauri::AppHandle,
) -> Result<Vec<file_history::FileHistoryItem>, String> {
    // #region agent log
    use std::fs::OpenOptions;
    use std::io::Write;
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(r"d:\project\re-fast\.cursor\debug.log") {
        let _ = writeln!(file, r#"{{"location":"commands.rs:1155","message":"search_file_history API入口","data":{{"query":"{}"}},"timestamp":{},"sessionId":"debug-session","runId":"run1","hypothesisId":"D"}}"#, query, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
    }
    // #endregion
    
    // 性能优化：在后台线程执行，避免阻塞 Everything 搜索
    let app_data_dir = get_app_data_dir(&app)?;
    let query_clone = query.clone();

    // #region agent log
    let spawn_start = std::time::Instant::now();
    // #endregion
    let result = tokio::task::spawn_blocking(move || {
        // #region agent log
        let blocking_start = std::time::Instant::now();
        // #endregion
        // Search in open_history and convert to FileHistoryItem format
        let search_result = open_history::search_history(&query_clone, &app_data_dir)
            .map(|items| {
                items.into_iter().map(|item| {
                    // Use stored name if available, otherwise extract from key
                    let name = item.name.clone().unwrap_or_else(|| {
                        if item.key.starts_with("http://") || item.key.starts_with("https://") {
                            // URL: extract domain
                            if let Some(domain_start) = item.key.find("://") {
                                let after_protocol = &item.key[domain_start + 3..];
                                if let Some(slash_pos) = after_protocol.find('/') {
                                    after_protocol[..slash_pos].to_string()
                                } else {
                                    after_protocol.to_string()
                                }
                            } else {
                                item.key.clone()
                            }
                        } else {
                            // File path: extract filename
                            std::path::Path::new(&item.key)
                                .file_name()
                                .and_then(|n| n.to_str())
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| item.key.clone())
                        }
                    });

                    file_history::FileHistoryItem {
                        path: item.key.clone(),
                        name,
                        last_used: item.last_opened,
                        use_count: item.use_count,
                        is_folder: item.is_folder,
                        source: Some("open_history".to_string()),
                    }
                }).collect::<Vec<file_history::FileHistoryItem>>()
            });
        // #region agent log
        let blocking_duration = blocking_start.elapsed();
        let results_count = match &search_result {
            Ok(ref vec) => vec.len(),
            Err(_) => 0,
        };
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(r"d:\project\re-fast\.cursor\debug.log") {
            let _ = writeln!(file, r#"{{"location":"commands.rs:1164","message":"open_history::search_history 返回","data":{{"duration_ms":{},"results_count":{}}},"timestamp":{},"sessionId":"debug-session","runId":"run1","hypothesisId":"D"}}"#, blocking_duration.as_millis(), results_count, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
        }
        // #endregion
        search_result
    })
    .await
    .map_err(|e| format!("搜索文件历史任务失败: {}", e))??;
    
    // #region agent log
    let spawn_duration = spawn_start.elapsed();
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(r"d:\project\re-fast\.cursor\debug.log") {
        let _ = writeln!(file, r#"{{"location":"commands.rs:1167","message":"search_file_history API返回","data":{{"spawn_duration_ms":{},"await_duration_ms":{}}},"timestamp":{},"sessionId":"debug-session","runId":"run1","hypothesisId":"D"}}"#, spawn_duration.as_millis(), spawn_duration.as_millis(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
    }
    // #endregion
    
    Ok(result)
}


#[tauri::command]
pub fn get_all_file_history(
    app: tauri::AppHandle,
) -> Result<Vec<file_history::FileHistoryItem>, String> {
    let start_time = std::time::Instant::now();

    let app_data_dir = match get_app_data_dir(&app) {
        Ok(dir) => {
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

    // Read from open_history instead of file_history
    let open_history_items = match open_history::get_all_history_items(&app_data_dir) {
        Ok(items) => items,
        Err(e) => {
            println!(
                "[后端] get_all_file_history: ERROR loading open_history: {}",
                e
            );
            return Err(e);
        }
    };

    // Convert OpenHistoryItem to FileHistoryItem
    let mut result: Vec<file_history::FileHistoryItem> = open_history_items
        .values()
        .map(|item| {
            // Use stored name if available, otherwise extract from key
            let name = item.name.clone().unwrap_or_else(|| {
                // Extract name from key (similar to add_item logic)
                if item.key.starts_with("http://") || item.key.starts_with("https://") {
                    // URL: extract domain
                    if let Some(domain_start) = item.key.find("://") {
                        let after_protocol = &item.key[domain_start + 3..];
                        if let Some(slash_pos) = after_protocol.find('/') {
                            after_protocol[..slash_pos].to_string()
                        } else {
                            after_protocol.to_string()
                        }
                    } else {
                        item.key.clone()
                    }
                } else {
                    // File path: extract filename
                    std::path::Path::new(&item.key)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| item.key.clone())
                }
            });

            file_history::FileHistoryItem {
                path: item.key.clone(),
                name,
                last_used: item.last_opened,
                use_count: item.use_count,
                is_folder: item.is_folder,
                source: Some("open_history".to_string()),
            }
        })
        .collect();

    // Sort by last_used (most recent first)
    result.sort_by(|a, b| b.last_used.cmp(&a.last_used));

    Ok(result)
}

#[tauri::command]
pub fn delete_file_history(path: String, app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    // Delete from open_history instead of file_history
    open_history::delete_open_history(path, &app_data_dir)
}

#[tauri::command]
pub fn update_file_history_name(
    path: String,
    new_name: String,
    app: tauri::AppHandle,
) -> Result<file_history::FileHistoryItem, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let item = open_history::update_item_name(path.clone(), new_name, &app_data_dir)?;
    
    // Convert to FileHistoryItem format
    Ok(file_history::FileHistoryItem {
        path: item.key.clone(),
        name: item.name.unwrap_or_else(|| item.key.clone()),
        last_used: item.last_opened,
        use_count: item.use_count,
        is_folder: item.is_folder,
        source: Some("open_history".to_string()),
    })
}

#[tauri::command]
pub fn update_open_history_remark(
    key: String,
    remark: Option<String>,
    app: tauri::AppHandle,
) -> Result<open_history::OpenHistoryItem, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    open_history::update_item_remark(key, remark, &app_data_dir)
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

// ===== Word Record commands =====

#[tauri::command]
pub fn get_all_word_records(app: tauri::AppHandle) -> Result<Vec<word_records::WordRecord>, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    word_records::get_all_word_records(&app_data_dir)
}

#[tauri::command]
pub fn add_word_record(
    word: String,
    translation: String,
    context: Option<String>,
    phonetic: Option<String>,
    example_sentence: Option<String>,
    tags: Vec<String>,
    app: tauri::AppHandle,
) -> Result<word_records::WordRecord, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    word_records::add_word_record(
        word,
        translation,
        context,
        phonetic,
        example_sentence,
        tags,
        &app_data_dir,
    )
}

#[tauri::command]
pub fn update_word_record(
    id: String,
    word: Option<String>,
    translation: Option<String>,
    context: Option<String>,
    phonetic: Option<String>,
    example_sentence: Option<String>,
    tags: Option<Vec<String>>,
    ai_explanation: Option<String>,
    mastery_level: Option<i32>,
    is_favorite: Option<bool>,
    is_mastered: Option<bool>,
    app: tauri::AppHandle,
) -> Result<word_records::WordRecord, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    word_records::update_word_record(
        id,
        word,
        translation,
        context,
        phonetic,
        example_sentence,
        tags,
        ai_explanation,
        mastery_level,
        is_favorite,
        is_mastered,
        &app_data_dir,
    )
}

#[tauri::command]
pub fn delete_word_record(id: String, app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    word_records::delete_word_record(id, &app_data_dir)
}

#[tauri::command]
pub fn search_word_records(query: String, app: tauri::AppHandle) -> Result<Vec<word_records::WordRecord>, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    word_records::search_word_records(&query, &app_data_dir)
}

#[derive(Debug, Clone, Deserialize)]
pub struct EverythingSearchOptions {
    pub extensions: Option<Vec<String>>,
    #[serde(rename = "excludeExtensions")]
    pub exclude_extensions: Option<Vec<String>>,
    #[serde(rename = "onlyFiles")]
    pub only_files: Option<bool>,
    #[serde(rename = "onlyFolders")]
    pub only_folders: Option<bool>,
    #[serde(rename = "maxResults")]
    pub max_results: Option<usize>,
    #[serde(rename = "matchFolderNameOnly")]
    pub match_folder_name_only: Option<bool>,
    #[serde(rename = "chunkSize")]
    pub chunk_size: Option<usize>,
}

fn build_everything_query(base: &str, options: &Option<EverythingSearchOptions>) -> (String, usize) {
    let mut parts: Vec<String> = Vec::new();
    let mut base_query = base.trim().to_string();
    let mut use_regex = false;

    let mut max_results = 50usize;

    // 检测用户是否已经使用了 Everything 原生语法
    // Everything 支持的语法前缀：regex:, path:, parent:, file:, folder:, ext:, !ext:, case:
    // 注意：需要在修改 base_query 之前检测，以保留原始查询中的语法
    let original_query = base_query.clone();
    let has_everything_syntax = original_query
        .split_whitespace()
        .any(|word| {
            word.starts_with("regex:")
                || word.starts_with("path:")
                || word.starts_with("parent:")
                || word.starts_with("file:")
                || word.starts_with("folder:")
                || word.starts_with("ext:")
                || word.starts_with("!ext:")
                || word.starts_with("case:")
        });
    
    // 检测是否包含扩展名过滤（在原始查询中检测）
    let has_ext_filter = original_query
        .split_whitespace()
        .any(|word| word.starts_with("ext:") || word.starts_with("!ext:"));

    if let Some(opts) = options {
        // 如果启用"仅匹配文件夹名"，需要特殊处理
        // 但如果用户已经使用了 Everything 语法，则跳过特殊处理，直接使用用户输入的查询
        let match_folder_name_only = opts.match_folder_name_only.unwrap_or(false);
        
        if match_folder_name_only && !base_query.is_empty() && !has_everything_syntax {
            // 只匹配文件夹名，使用简单的 folder: 语法
            // Everything 会自动匹配文件夹名
            // 强制只搜索文件夹
            parts.push("folder:".to_string());
        } else {
            // 正常处理
            // 如果用户已经使用了 file: 或 folder:，则不再添加
            if !has_everything_syntax {
                if opts.only_files.unwrap_or(false) {
                    parts.push("file:".to_string());
                } else if opts.only_folders.unwrap_or(false) {
                    parts.push("folder:".to_string());
                }
            }
        }
        
        if !base_query.is_empty() {
            parts.push(base_query);
        }

        // 如果用户已经使用了 ext: 或 !ext:，则不再添加扩展名过滤
        // 注意：has_ext_filter 已经在函数开头从原始查询中检测过了
        if !has_ext_filter {
            if let Some(exts) = &opts.extensions {
                let cleaned: Vec<String> = exts
                    .iter()
                    .filter_map(|e| {
                        let trimmed = e.trim().trim_start_matches('.').to_lowercase();
                        if trimmed.is_empty() {
                            None
                        } else {
                            Some(trimmed)
                        }
                    })
                    .collect();
                if !cleaned.is_empty() {
                    parts.push(format!("ext:{}", cleaned.join(";")));
                }
            }

            if let Some(ex_exts) = &opts.exclude_extensions {
                let cleaned: Vec<String> = ex_exts
                    .iter()
                    .filter_map(|e| {
                        let trimmed = e.trim().trim_start_matches('.').to_lowercase();
                        if trimmed.is_empty() {
                            None
                        } else {
                            Some(trimmed)
                        }
                    })
                    .collect();
                if !cleaned.is_empty() {
                    parts.push(format!("!ext:{}", cleaned.join(";")));
                }
            }
        }

        if let Some(mr) = opts.max_results {
            if mr > 0 {
                max_results = mr;
            }
        }
    }
    // 当没有传递 options（如启动器中的简化调用）时，也应保留用户输入的基础查询，
    // 否则会导致 combined_query 为空，后端直接返回 0 结果
    else {
        if !base_query.is_empty() {
            parts.push(base_query.clone());
        }
    }

    let combined_query = parts.join(" ").trim().to_string();
    (combined_query, max_results)
}

#[tauri::command]
pub async fn search_everything(
    query: String,
    options: Option<EverythingSearchOptions>,
    app: tauri::AppHandle,
) -> Result<everything_search::EverythingSearchResponse, String> {
    #[cfg(target_os = "windows")]
    {
        let (combined_query, max_results) = build_everything_query(&query, &options);
        let chunk_size = options
            .as_ref()
            .and_then(|opts| opts.chunk_size)
            .unwrap_or(5000)
            .max(1);

        // 前置兜底：若最终查询字符串为空，直接返回空结果，避免前端误触发“查询字符串不能为空”错误
        // 典型场景：仅设置过滤器但未输入关键词，或异步竞态导致空串落到后端
        if combined_query.trim().is_empty() {
            eprintln!(
                "[RUST] search_everything: combined query is empty, return empty result (raw='{}')",
                query
            );
            return Ok(everything_search::EverythingSearchResponse {
                results: vec![],
                total_count: 0,
            });
        }

        // 为新搜索准备取消标志，同时通知旧搜索退出
        let cancel_flag = {
            let mut manager = SEARCH_TASK_MANAGER
                .lock()
                .map_err(|e| format!("锁定搜索管理器失败: {}", e))?;

            // 检查是否是相同 query 的重复搜索
            if let Some(ref current_query) = manager.current_query {
                if current_query == &combined_query {
                    // query 相同，说明是重复搜索，返回错误
                    eprintln!("[RUST] Duplicate search detected for query: {}, skipping", combined_query);
                    return Err(format!("搜索 '{}' 正在进行中，跳过重复调用", combined_query));
                }
            }

            // 只有当 query 不同时，才取消旧搜索
            // 这样可以避免新搜索被误取消
            if let Some(old_flag) = &manager.cancel_flag {
                // 只有当 query 不同时才取消
                if manager.current_query.as_ref() != Some(&combined_query) {
                    eprintln!("[RUST] Cancelling previous search (query: {:?}) for new search (query: {})", 
                        manager.current_query, combined_query);
                    old_flag.store(true, Ordering::Relaxed);
                } else {
                    eprintln!("[RUST] Same query detected, not cancelling previous search: {}", combined_query);
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
            manager.current_query = Some(combined_query.clone());
            manager.cancel_flag = Some(new_flag.clone());
            
            // 再次验证新标志的值，确保在更新过程中没有被修改
            let flag_value_after_update = new_flag.load(Ordering::Relaxed);
            eprintln!("[RUST] Created new search flag for query: {} (old query: {:?}, flag value: {})", 
                combined_query, old_query, flag_value_after_update);
            
            // 如果标志值不是 false，说明有问题
            if flag_value_after_update {
                eprintln!("[RUST] CRITICAL ERROR: New flag is true after update! This indicates a serious bug!");
            }
            
            new_flag
        };

        // 获取窗口用于发送事件（向 launcher 与 everything-search-window 都尝试发送）
        let launcher_window = app.get_webview_window("launcher");
        let everything_window = app.get_webview_window("everything-search-window");

        // 在后台线程执行搜索，避免阻塞
        let query_clone = combined_query.clone();
        let max_results_clone = max_results;

        // 获取异步运行时句柄，用于在阻塞线程中发送事件
        let rt_handle = tokio::runtime::Handle::current();
        
        tokio::task::spawn_blocking(move || {
            // 创建批次回调，用于实时发送进度与增量结果
            let on_batch = move |batch_results: &[everything_search::EverythingResult], total_count: u32, current_count: u32| {
                // 在异步运行时中发送事件
                let launcher = launcher_window.clone();
                let everything_win = everything_window.clone();
                let batch_results = batch_results.to_vec();
                let handle = rt_handle.clone();
                
                // 使用运行时句柄在阻塞线程中发送异步事件
                handle.spawn(async move {
                    let event_data = serde_json::json!({
                        "results": batch_results,
                        "total_count": total_count,
                        "current_count": current_count,
                    });

                    if let Some(win) = launcher {
                        if let Err(e) = win.emit("everything-search-batch", &event_data) {
                            eprintln!("[DEBUG] Failed to emit search batch event to launcher: {}", e);
                        }
                    }

                    if let Some(win) = everything_win {
                        if let Err(e) = win.emit("everything-search-batch", &event_data) {
                            eprintln!("[DEBUG] Failed to emit search batch event to search window: {}", e);
                        }
                    }
                });
            };

            let result = everything_search::windows::search_files(
                &query_clone,
                max_results_clone,
                chunk_size,
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

            // 返回完整结果，供前端展示
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

/// 取消当前的 Everything 搜索任务（在前端清空查询时调用）
#[tauri::command]
pub fn cancel_everything_search() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut manager = SEARCH_TASK_MANAGER
            .lock()
            .map_err(|e| format!("锁定搜索管理器失败: {}", e))?;

        if let Some(flag) = &manager.cancel_flag {
            flag.store(true, Ordering::Relaxed);
        }

        // 清理当前查询，允许后续相同 query 被重新触发
        manager.current_query = None;
        manager.cancel_flag = None;

        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Everything search is only available on Windows".to_string())
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct EverythingSearchSessionOptions {
    pub extensions: Option<Vec<String>>,
    #[serde(rename = "maxResults")]
    pub max_results: Option<usize>,
    #[serde(rename = "sortKey")]
    pub sort_key: Option<String>, // "size" | "type" | "name"
    #[serde(rename = "sortOrder")]
    pub sort_order: Option<String>, // "asc" | "desc"
    #[serde(rename = "matchFolderNameOnly")]
    pub match_folder_name_only: Option<bool>,
    #[serde(rename = "chunkSize")]
    pub chunk_size: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EverythingSearchSessionResponse {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "totalCount")]
    pub total_count: u32,
    pub truncated: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EverythingSearchRangeResponse {
    pub offset: usize,
    pub items: Vec<everything_search::EverythingResult>,
    #[serde(rename = "totalCount")]
    pub total_count: Option<u32>,
}

/// 开启 Everything 搜索会话
#[tauri::command]
pub async fn start_everything_search_session(
    search_query: String,
    options: Option<EverythingSearchSessionOptions>,
    app: tauri::AppHandle,
) -> Result<EverythingSearchSessionResponse, String> {
    #[cfg(target_os = "windows")]
    {
        use std::time::SystemTime;
        
        // 构建查询参数
        let opts = options.as_ref();
        let ext_filter = opts.and_then(|o| o.extensions.as_ref());
        let max_results = opts
            .and_then(|o| o.max_results)
            .unwrap_or(50)
            .min(2000000); // 硬上限
        let match_folder_name_only = opts
            .and_then(|o| o.match_folder_name_only)
            .unwrap_or(false);

        // 构建查询字符串（复用现有逻辑）
        // 获取 chunk_size，如果未指定则使用默认值 5000
        let chunk_size = opts
            .and_then(|o| o.chunk_size)
            .unwrap_or(5000);
        
        let search_opts = EverythingSearchOptions {
            extensions: ext_filter.cloned(),
            exclude_extensions: None,
            only_files: None,
            only_folders: if match_folder_name_only { Some(true) } else { None },
            max_results: Some(max_results),
            match_folder_name_only: Some(match_folder_name_only),
            chunk_size: Some(chunk_size),
        };
        
        let (combined_query, _) = build_everything_query(&search_query, &Some(search_opts));
        
        // 在移动之前克隆 combined_query，用于后续生成会话 ID
        let combined_query_for_session = combined_query.clone();

        // 获取窗口用于发送批次事件
        let everything_window = app.get_webview_window("everything-search-window");

        // 获取异步运行时句柄，用于在阻塞线程中发送事件
        let rt_handle = tokio::runtime::Handle::current();

        // 执行搜索
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let result = {
            // 创建批次回调，用于实时发送结果（用于进度显示）
            let on_batch = move |batch_results: &[everything_search::EverythingResult], total_count: u32, current_count: u32| {
                // 在异步运行时中发送事件
                let everything_win = everything_window.clone();
                let batch_results = batch_results.to_vec();
                let handle = rt_handle.clone();
                
                // 使用运行时句柄在阻塞线程中发送异步事件
                handle.spawn(async move {
                    let event_data = serde_json::json!({
                        "results": batch_results,
                        "total_count": total_count,
                        "current_count": current_count,
                    });

                    if let Some(win) = everything_win {
                        if let Err(e) = win.emit("everything-search-batch", &event_data) {
                            eprintln!("[DEBUG] Failed to emit search batch event to search window: {}", e);
                        }
                    }
                });
            };

            tokio::task::spawn_blocking(move || {
                everything_search::windows::search_files(
                    &combined_query,
                    max_results,
                    5000,
                    Some(&cancel_flag),
                    Some(on_batch),
                )
            })
            .await
            .map_err(|e| format!("搜索任务失败: {}", e))?
        };

        let search_response = result.map_err(|e| e.to_string())?;

        // 对结果进行排序（如果需要）
        let mut results = search_response.results;
        if let Some(sort_key) = opts.and_then(|o| o.sort_key.as_ref()) {
            // 使用字符串字面量而不是临时值
            let default_sort_order = "desc";
            let sort_order_str = opts
                .and_then(|o| o.sort_order.as_deref())
                .unwrap_or(default_sort_order);
            let ascending = sort_order_str == "asc";

            match sort_key.as_str() {
                "size" => {
                    results.sort_by(|a, b| {
                        let a_size = a.size.unwrap_or(0);
                        let b_size = b.size.unwrap_or(0);
                        if ascending {
                            a_size.cmp(&b_size)
                        } else {
                            b_size.cmp(&a_size)
                        }
                    });
                }
                "type" => {
                    results.sort_by(|a, b| {
                        let a_ext = std::path::Path::new(&a.path)
                            .extension()
                            .and_then(|s| s.to_str())
                            .unwrap_or("");
                        let b_ext = std::path::Path::new(&b.path)
                            .extension()
                            .and_then(|s| s.to_str())
                            .unwrap_or("");
                        if ascending {
                            a_ext.cmp(b_ext)
                        } else {
                            b_ext.cmp(a_ext)
                        }
                    });
                }
                "name" => {
                    results.sort_by(|a, b| {
                        if ascending {
                            a.name.cmp(&b.name)
                        } else {
                            b.name.cmp(&a.name)
                        }
                    });
                }
                _ => {}
            }
        }

        // 生成会话 ID（使用时间戳 + 随机数）
        let mut hasher = DefaultHasher::new();
        SystemTime::now().hash(&mut hasher);
        combined_query_for_session.hash(&mut hasher);
        let session_id = format!("session_{}", hasher.finish());

        // 在移动 results 之前保存长度
        let results_len = results.len();
        let truncated = results_len >= max_results;
        
        // 性能优化：如果结果数量超过 max_results，只保留前 max_results 条
        // 这样可以减少内存占用和后续分页查询的时间
        if results_len > max_results {
            results.truncate(max_results);
            eprintln!(
                "[RUST] start_everything_search_session: 结果数量 {} 超过限制 {}，已截断",
                results_len, max_results
            );
        }

        // 存储会话
        let session = SearchSession {
            query: combined_query_for_session,
            results,
            total_count: search_response.total_count,
            created_at: std::time::Instant::now(),
        };

        {
            let mut manager = SEARCH_SESSION_MANAGER
                .lock()
                .map_err(|e| format!("锁定会话管理器失败: {}", e))?;
            manager.sessions.insert(session_id.clone(), session);
        }

        Ok(EverythingSearchSessionResponse {
            session_id,
            total_count: search_response.total_count,
            truncated: Some(truncated),
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Everything search is only available on Windows".to_string())
    }
}

/// 获取搜索会话的指定范围结果
#[tauri::command]
pub fn get_everything_search_range(
    session_id: String,
    offset: usize,
    limit: usize,
    _options: Option<EverythingSearchSessionOptions>, // 保留参数以兼容前端，但排序已在创建会话时完成
) -> Result<EverythingSearchRangeResponse, String> {
    let manager = SEARCH_SESSION_MANAGER
        .lock()
        .map_err(|e| format!("锁定会话管理器失败: {}", e))?;

    let session = manager
        .sessions
        .get(&session_id)
        .ok_or_else(|| "会话不存在或已过期".to_string())?;

    let total_count = session.results.len();
    let end = (offset + limit).min(total_count);
    
    // 性能优化：使用 clone_from_slice 而不是 to_vec，减少内存分配
    // 但需要确保切片有效
    let items = if offset < total_count {
        session.results[offset..end].to_vec()
    } else {
        Vec::new()
    };
    

    Ok(EverythingSearchRangeResponse {
        offset,
        items,
        total_count: Some(session.total_count),
    })
}

/// 关闭搜索会话
#[tauri::command]
pub fn close_everything_search_session(session_id: String) -> Result<(), String> {
    let mut manager = SEARCH_SESSION_MANAGER
        .lock()
        .map_err(|e| format!("锁定会话管理器失败: {}", e))?;

    manager.sessions.remove(&session_id);
    Ok(())
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
pub fn purge_file_history(days: Option<u64>, app: tauri::AppHandle) -> Result<usize, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let days = days.unwrap_or(30).max(1);
    open_history::purge_history_older_than(days, &app_data_dir)
}

#[tauri::command]
pub fn delete_file_history_by_range(
    start_ts: Option<u64>,
    end_ts: Option<u64>,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    open_history::delete_by_range(start_ts, end_ts, &app_data_dir)
}

#[derive(Serialize)]
pub struct FilePreviewMetadata {
    pub duration_ms: Option<u64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Serialize)]
pub struct FilePreview {
    pub kind: String,
    pub size: Option<u64>,
    pub modified: Option<String>,
    pub extension: Option<String>,
    pub mime: Option<String>,
    pub content: Option<String>,
    #[serde(rename = "imageDataUrl")]
    pub image_data_url: Option<String>,
    pub truncated: bool,
    pub metadata: Option<FilePreviewMetadata>,
    pub error: Option<String>,
}

fn guess_mime_from_extension(ext: Option<&str>) -> Option<&'static str> {
    match ext {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("bmp") => Some("image/bmp"),
        Some("webp") => Some("image/webp"),
        Some("svg") => Some("image/svg+xml"),
        Some("mp3") => Some("audio/mpeg"),
        Some("wav") => Some("audio/wav"),
        Some("flac") => Some("audio/flac"),
        Some("mp4") => Some("video/mp4"),
        Some("mov") => Some("video/quicktime"),
        Some("mkv") => Some("video/x-matroska"),
        Some("webm") => Some("video/webm"),
        Some("avi") => Some("video/x-msvideo"),
        Some("ogg") => Some("application/ogg"),
        Some("aac") => Some("audio/aac"),
        Some("txt") => Some("text/plain"),
        Some("md") => Some("text/markdown"),
        Some("json") => Some("application/json"),
        Some("yaml") | Some("yml") => Some("text/yaml"),
        Some("html") | Some("htm") => Some("text/html"),
        Some("css") => Some("text/css"),
        Some("js") => Some("application/javascript"),
        Some("ts") | Some("tsx") => Some("text/typescript"),
        Some("rs") => Some("text/plain"),
        _ => None,
    }
}

fn is_image_extension(ext: &str) -> bool {
    matches!(
        ext,
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "svg" | "ico"
    )
}

fn is_media_extension(ext: &str) -> bool {
    matches!(
        ext,
        "mp3" | "wav" | "flac" | "aac" | "ogg" | "mp4" | "mov" | "mkv" | "avi" | "webm"
    )
}

fn is_text_extension(ext: &str) -> bool {
    matches!(
        ext,
        "txt"
            | "md"
            | "json"
            | "jsonc"
            | "yaml"
            | "yml"
            | "toml"
            | "ini"
            | "xml"
            | "html"
            | "htm"
            | "css"
            | "scss"
            | "less"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "c"
            | "cpp"
            | "h"
            | "hpp"
            | "rs"
            | "go"
            | "py"
            | "rb"
            | "java"
            | "kt"
            | "swift"
            | "php"
            | "sql"
            | "csv"
            | "log"
    )
}

fn is_probably_binary(buffer: &[u8]) -> bool {
    buffer.iter().take(2048).any(|&b| b == 0)
}

#[tauri::command]
pub fn get_file_preview(path: String) -> Result<FilePreview, String> {
    let path_ref = Path::new(&path);
    let metadata =
        fs::metadata(path_ref).map_err(|e| format!("无法读取文件信息: {}", e.to_string()))?;

    let modified: Option<String> = metadata.modified().ok().map(|time| {
        let datetime: DateTime<Utc> = time.into();
        datetime.to_rfc3339()
    });

    let extension = path_ref
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|s| s.to_lowercase());

    let mime = guess_mime_from_extension(extension.as_deref()).map(|s| s.to_string());
    let size = if metadata.is_file() {
        Some(metadata.len())
    } else {
        None
    };

    if metadata.is_dir() {
        return Ok(FilePreview {
            kind: "folder".to_string(),
            size,
            modified,
            extension,
            mime,
            content: None,
            image_data_url: None,
            truncated: false,
            metadata: None,
            error: None,
        });
    }

    if let Some(ext_ref) = extension.as_deref() {
        if is_image_extension(ext_ref) {
            let max_preview_bytes: u64 = 200 * 1024;
            let mut file =
                fs::File::open(path_ref).map_err(|e| format!("无法打开文件: {}", e.to_string()))?;
            let mut buffer: Vec<u8> = Vec::new();
            let read_bytes = file
                .by_ref()
                .take(max_preview_bytes)
                .read_to_end(&mut buffer)
                .map_err(|e| format!("读取文件失败: {}", e.to_string()))?;
            let truncated = size.map_or(false, |s| s > read_bytes as u64);

            let data_url = format!(
                "data:{};base64,{}",
                mime.clone()
                    .unwrap_or_else(|| "application/octet-stream".to_string()),
                general_purpose::STANDARD.encode(&buffer)
            );

            return Ok(FilePreview {
                kind: "image".to_string(),
                size,
                modified,
                extension,
                mime,
                content: None,
                image_data_url: Some(data_url),
                truncated,
                metadata: None,
                error: None,
            });
        }
    }

    let max_preview_bytes: u64 = 32 * 1024;
    let mut file = fs::File::open(path_ref)
        .map_err(|e| format!("无法打开文件: {}", e.to_string()))?;
    let mut buffer: Vec<u8> = Vec::new();
    let read_bytes = file
        .by_ref()
        .take(max_preview_bytes)
        .read_to_end(&mut buffer)
        .map_err(|e| format!("读取文件失败: {}", e.to_string()))?;
    let truncated = size.map_or(false, |s| s > read_bytes as u64);

    let is_text = extension
        .as_deref()
        .map(is_text_extension)
        .unwrap_or(false)
        || !is_probably_binary(&buffer);

    if is_text {
        let content = String::from_utf8_lossy(&buffer).to_string();
        return Ok(FilePreview {
            kind: "text".to_string(),
            size,
            modified,
            extension,
            mime,
            content: Some(content),
            image_data_url: None,
            truncated,
            metadata: None,
            error: None,
        });
    }

    if let Some(ext_ref) = extension.as_deref() {
        if is_media_extension(ext_ref) {
            return Ok(FilePreview {
                kind: "media".to_string(),
                size,
                modified,
                extension,
                mime,
                content: None,
                image_data_url: None,
                truncated,
                metadata: Some(FilePreviewMetadata {
                    duration_ms: None,
                    width: None,
                    height: None,
                }),
                error: None,
            });
        }
    }

    Ok(FilePreview {
        kind: "binary".to_string(),
        size,
        modified,
        extension,
        mime,
        content: None,
        image_data_url: None,
        truncated,
        metadata: None,
        error: None,
    })
}

#[derive(Serialize)]
pub struct IndexEverythingStatus {
    pub available: bool,
    pub error: Option<String>,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Serialize)]
pub struct IndexApplicationsStatus {
    pub total: usize,
    pub cache_file: Option<String>,
    pub cache_mtime: Option<u64>,
}

#[derive(Serialize)]
pub struct IndexFileHistoryStatus {
    pub total: usize,
    pub path: Option<String>,
    pub mtime: Option<u64>,
}

#[derive(Serialize)]
pub struct IndexStatus {
    pub everything: IndexEverythingStatus,
    pub applications: IndexApplicationsStatus,
    pub file_history: IndexFileHistoryStatus,
}

#[derive(Serialize)]
pub struct DatabaseBackupInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: Option<u64>,
}

#[derive(Serialize)]
pub struct DatabaseBackupList {
    pub dir: String,
    pub items: Vec<DatabaseBackupInfo>,
}

fn ensure_backup_path(path: &str, app_data_dir: &Path) -> Result<std::path::PathBuf, String> {
    let backup_dir = app_data_dir.join("backups");
    let backup_dir_canon = backup_dir
        .canonicalize()
        .unwrap_or_else(|_| backup_dir.clone());

    let target = std::path::PathBuf::from(path)
        .canonicalize()
        .map_err(|e| format!("Invalid backup path: {}", e))?;

    if !target.starts_with(&backup_dir_canon) {
        return Err("Backup path is outside backup directory".to_string());
    }

    Ok(target)
}

/// 备份数据库到 app_data_dir/backups/re-fast-backup_yyyyMMdd_HHmmss.db
/// 异步执行，避免大文件复制时阻塞主线程
#[tauri::command]
pub async fn backup_database(app: tauri::AppHandle) -> Result<String, String> {
    async_runtime::spawn_blocking(move || {
        let app_data_dir = get_app_data_dir(&app)?;
        let db_path = db::get_db_path(&app_data_dir);
        if !db_path.exists() {
            return Err("Database file not found".to_string());
        }

        let backup_dir = app_data_dir.join("backups");
        fs::create_dir_all(&backup_dir)
            .map_err(|e| format!("Failed to create backup directory: {}", e))?;

        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
        let backup_name = format!("re-fast-backup_{}.db", timestamp);
        let backup_path = backup_dir.join(backup_name);

        // 文件复制操作可能很慢（特别是大数据库），使用 spawn_blocking 避免阻塞
        fs::copy(&db_path, &backup_path)
            .map_err(|e| format!("Failed to copy database: {}", e))?;

        Ok(backup_path
            .to_string_lossy()
            .to_string())
    })
    .await
    .map_err(|e| format!("backup_database join error: {}", e))?
}

/// 删除指定的备份文件（异步，避免阻塞主线程）
#[tauri::command]
pub async fn delete_backup(app: tauri::AppHandle, path: String) -> Result<(), String> {
    async_runtime::spawn_blocking(move || {
        let app_data_dir = get_app_data_dir(&app)?;
        let target = ensure_backup_path(&path, &app_data_dir)?;

        if !target.is_file() {
            return Err("Backup file not found".to_string());
        }

        fs::remove_file(&target).map_err(|e| format!("Failed to delete backup: {}", e))
    })
    .await
    .map_err(|e| format!("delete_backup join error: {}", e))?
}

/// 用指定的备份覆盖当前数据库（异步，避免阻塞主线程）
#[tauri::command]
pub async fn restore_backup(app: tauri::AppHandle, path: String) -> Result<String, String> {
    async_runtime::spawn_blocking(move || {
        let app_data_dir = get_app_data_dir(&app)?;
        let target = ensure_backup_path(&path, &app_data_dir)?;

        if !target.is_file() {
            return Err("Backup file not found".to_string());
        }

        let db_path = db::get_db_path(&app_data_dir);
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create database directory: {}", e))?;
        }

        // 文件复制操作可能很慢，使用 spawn_blocking 避免阻塞
        fs::copy(&target, &db_path)
            .map_err(|e| format!("Failed to restore database: {}", e))?;

        Ok(db_path
            .to_string_lossy()
            .to_string())
    })
    .await
    .map_err(|e| format!("restore_backup join error: {}", e))?
}

/// 获取数据库备份版本列表（异步，避免阻塞主线程）
#[tauri::command]
pub async fn list_backups(app: tauri::AppHandle) -> Result<DatabaseBackupList, String> {
    async_runtime::spawn_blocking(move || {
        let app_data_dir = get_app_data_dir(&app)?;
        let backup_dir = app_data_dir.join("backups");

        if !backup_dir.exists() {
            return Ok(DatabaseBackupList {
                dir: backup_dir.to_string_lossy().to_string(),
                items: vec![],
            });
        }

        let mut items = Vec::new();
        // 遍历目录可能很慢，使用 spawn_blocking 避免阻塞
        for entry in fs::read_dir(&backup_dir)
            .map_err(|e| format!("Failed to read backup directory: {}", e))?
        {
            let entry = entry.map_err(|e| format!("Failed to read backup entry: {}", e))?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            // 仅保留 .db 备份文件
            if let Some(ext) = path.extension() {
                if ext.to_string_lossy().to_lowercase() != "db" {
                    continue;
                }
            }

            let metadata = entry
                .metadata()
                .map_err(|e| format!("Failed to read backup metadata: {}", e))?;
            let modified = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs());

            items.push(DatabaseBackupInfo {
                name: entry.file_name().to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                size: metadata.len(),
                modified,
            });
        }

        // 按修改时间降序排序
        items.sort_by(|a, b| b.modified.unwrap_or(0).cmp(&a.modified.unwrap_or(0)));

        Ok(DatabaseBackupList {
            dir: backup_dir.to_string_lossy().to_string(),
            items,
        })
    })
    .await
    .map_err(|e| format!("list_backups join error: {}", e))?
}

/// 聚合索引状态，便于前端一次性获取
#[tauri::command]
pub async fn get_index_status(app: tauri::AppHandle) -> Result<IndexStatus, String> {
    #[cfg(target_os = "windows")]
    {
        // 使用 spawn_blocking 避免阻塞主线程
        async_runtime::spawn_blocking(move || {
            let start_time = std::time::Instant::now();
            crate::log!("IndexStatus", "========== 开始获取索引状态 ==========");
            
            let app_data_dir = get_app_data_dir(&app)?;
            crate::log!("IndexStatus", "✓ 获取 app_data_dir 成功: {:?} (耗时: {}ms)", app_data_dir, start_time.elapsed().as_millis());

            // Everything 状态
            let everything_start = std::time::Instant::now();
            crate::log!("IndexStatus", "→ 开始检查 Everything 状态...");
            let (available, error) = everything_search::windows::check_everything_status();
            let version = everything_search::windows::get_everything_version();
            let path = everything_search::windows::get_everything_path()
                .map(|p| p.to_string_lossy().to_string());
            crate::log!("IndexStatus", "✓ Everything 状态检查完成 (可用: {}, 耗时: {}ms)", available, everything_start.elapsed().as_millis());

            // 应用索引状态：缓存数量与文件时间
            let apps_start = std::time::Instant::now();
            crate::log!("IndexStatus", "→ 开始检查应用索引状态...");
            let cache_file_path = app_search::windows::get_cache_file_path(&app_data_dir);
            let cache_mtime = fs::metadata(&cache_file_path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs());
            let cache_file = cache_file_path.to_str().map(|s| s.to_string());
            crate::log!("IndexStatus", "  - 缓存文件元数据读取完成 (耗时: {}ms)", apps_start.elapsed().as_millis());

            let cache = get_app_cache();
            let cache_lock_start = std::time::Instant::now();
            crate::log!("IndexStatus", "  - 开始获取应用缓存锁（使用 try_lock 避免阻塞）...");
            
            // 使用 try_lock 避免阻塞，如果获取不到锁说明其他线程正在使用
            let apps_total = match cache.try_lock() {
                Ok(cache_guard) => {
                    crate::log!("IndexStatus", "  - 应用缓存锁获取成功 (耗时: {}ms)", cache_lock_start.elapsed().as_millis());
                    let count = cache_guard.as_ref().map_or(0, |v| v.len());
                    
                    // 如果缓存为空，尝试从磁盘加载
                    if count == 0 {
                        drop(cache_guard); // 先释放锁
                        crate::log!("IndexStatus", "  - 缓存为空，尝试从磁盘加载...");
                        let load_start = std::time::Instant::now();
                        if let Ok(disk_cache) = app_search::windows::load_cache(&app_data_dir) {
                            if !disk_cache.is_empty() {
                                let disk_count = disk_cache.len();
                                crate::log!("IndexStatus", "  - 从磁盘加载缓存成功，应用数: {} (耗时: {}ms)", disk_count, load_start.elapsed().as_millis());
                                disk_count
                            } else {
                                crate::log!("IndexStatus", "  - 磁盘缓存为空 (耗时: {}ms)", load_start.elapsed().as_millis());
                                0
                            }
                        } else {
                            crate::log!("IndexStatus", "  - 从磁盘加载缓存失败 (耗时: {}ms)", load_start.elapsed().as_millis());
                            0
                        }
                    } else {
                        count
                    }
                }
                Err(_) => {
                    // 获取锁失败，说明其他线程正在使用（可能正在扫描应用）
                    crate::log!("IndexStatus", "  - 应用缓存锁被占用（可能正在扫描应用），从磁盘读取缓存数量 (耗时: {}ms)", cache_lock_start.elapsed().as_millis());
                    let load_start = std::time::Instant::now();
                    if let Ok(disk_cache) = app_search::windows::load_cache(&app_data_dir) {
                        let count = disk_cache.len();
                        crate::log!("IndexStatus", "  - 从磁盘读取缓存成功，应用数: {} (耗时: {}ms)", count, load_start.elapsed().as_millis());
                        count
                    } else {
                        crate::log!("IndexStatus", "  - 从磁盘读取缓存失败 (耗时: {}ms)", load_start.elapsed().as_millis());
                        0
                    }
                }
            };
            crate::log!("IndexStatus", "✓ 应用索引状态检查完成 (应用数: {}, 总耗时: {}ms)", apps_total, apps_start.elapsed().as_millis());

            // 文件历史索引状态：改为 SQLite 文件
            let history_start = std::time::Instant::now();
            crate::log!("IndexStatus", "→ 开始检查文件历史索引状态...");
            let history_db_path = db::get_db_path(&app_data_dir);
            let history_mtime = fs::metadata(&history_db_path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs());
            crate::log!("IndexStatus", "  - 数据库文件元数据读取完成 (耗时: {}ms)", history_start.elapsed().as_millis());
            
            // 使用带超时的历史记录计数，避免数据库锁死
            crate::log!("IndexStatus", "  - 开始查询历史记录数量（带 5 秒超时保护）...");
            let count_start = std::time::Instant::now();
            let history_total = match open_history::get_history_count(&app_data_dir) {
                Ok(count) => {
                    crate::log!("IndexStatus", "  - 历史记录数量查询成功: {} 条 (耗时: {}ms)", count, count_start.elapsed().as_millis());
                    count
                }
                Err(e) => {
                    crate::log!("IndexStatus", "  - ⚠ 历史记录数量查询失败: {} (耗时: {}ms)", e, count_start.elapsed().as_millis());
                    0
                }
            };
            let history_path_str = history_db_path.to_str().map(|s| s.to_string());
            crate::log!("IndexStatus", "✓ 文件历史索引状态检查完成 (记录数: {}, 总耗时: {}ms)", history_total, history_start.elapsed().as_millis());

            crate::log!("IndexStatus", "========== 索引状态获取完成（总耗时: {}ms）==========", start_time.elapsed().as_millis());
            
            Ok(IndexStatus {
                everything: IndexEverythingStatus {
                    available,
                    error,
                    version,
                    path,
                },
                applications: IndexApplicationsStatus {
                    total: apps_total,
                    cache_file,
                    cache_mtime,
                },
                file_history: IndexFileHistoryStatus {
                    total: history_total,
                    path: history_path_str,
                    mtime: history_mtime,
                },
            })
        })
        .await
        .map_err(|e| format!("get_index_status join error: {}", e))?
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("get_index_status is only supported on Windows".to_string())
    }
}

/// 数据库健康检查命令
/// 返回数据库是否可访问、是否有锁定、以及基本统计信息
#[derive(Serialize)]
pub struct DatabaseHealthStatus {
    pub accessible: bool,
    pub error_message: Option<String>,
    pub db_path: Option<String>,
    pub db_size_bytes: Option<u64>,
    pub file_history_count: Option<usize>,
    pub shortcuts_count: Option<usize>,
    pub memos_count: Option<usize>,
}

#[tauri::command]
pub async fn check_database_health(app: tauri::AppHandle) -> Result<DatabaseHealthStatus, String> {
    async_runtime::spawn_blocking(move || {
        let app_data_dir = match get_app_data_dir(&app) {
            Ok(dir) => dir,
            Err(e) => {
                return Ok(DatabaseHealthStatus {
                    accessible: false,
                    error_message: Some(format!("无法获取应用数据目录: {}", e)),
                    db_path: None,
                    db_size_bytes: None,
                    file_history_count: None,
                    shortcuts_count: None,
                    memos_count: None,
                });
            }
        };

        let db_path = db::get_db_path(&app_data_dir);
        let db_path_str = db_path.to_string_lossy().to_string();
        
        // 检查数据库文件大小
        let db_size = fs::metadata(&db_path).ok().map(|m| m.len());

        // 尝试连接数据库（带超时保护）
        use std::sync::mpsc;
        use std::thread;
        use std::time::Duration;

        let (tx, rx) = mpsc::channel();
        let app_data_dir_clone = app_data_dir.clone();
        
        thread::spawn(move || {
            let result = (|| -> Result<(usize, usize, usize), String> {
                let conn = db::get_connection(&app_data_dir_clone)?;
                
                // 查询各表记录数
                // 注意：已迁移到 open_history 表，这里查询 open_history 而不是 file_history
                let file_history_count: i64 = conn
                    .query_row("SELECT COUNT(*) FROM open_history", [], |row| row.get(0))
                    .map_err(|e| format!("查询 open_history 失败: {}", e))?;
                
                let shortcuts_count: i64 = conn
                    .query_row("SELECT COUNT(*) FROM shortcuts", [], |row| row.get(0))
                    .map_err(|e| format!("查询 shortcuts 失败: {}", e))?;
                
                let memos_count: i64 = conn
                    .query_row("SELECT COUNT(*) FROM memos", [], |row| row.get(0))
                    .map_err(|e| format!("查询 memos 失败: {}", e))?;
                
                Ok((file_history_count as usize, shortcuts_count as usize, memos_count as usize))
            })();
            let _ = tx.send(result);
        });

        // 等待结果，5 秒超时
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok((fh_count, sc_count, memo_count))) => {
                Ok(DatabaseHealthStatus {
                    accessible: true,
                    error_message: None,
                    db_path: Some(db_path_str),
                    db_size_bytes: db_size,
                    file_history_count: Some(fh_count),
                    shortcuts_count: Some(sc_count),
                    memos_count: Some(memo_count),
                })
            }
            Ok(Err(e)) => {
                Ok(DatabaseHealthStatus {
                    accessible: false,
                    error_message: Some(format!("数据库访问错误: {}", e)),
                    db_path: Some(db_path_str),
                    db_size_bytes: db_size,
                    file_history_count: None,
                    shortcuts_count: None,
                    memos_count: None,
                })
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Ok(DatabaseHealthStatus {
                    accessible: false,
                    error_message: Some("数据库访问超时 (可能被锁定或损坏)".to_string()),
                    db_path: Some(db_path_str),
                    db_size_bytes: db_size,
                    file_history_count: None,
                    shortcuts_count: None,
                    memos_count: None,
                })
            }
            Err(_) => {
                Ok(DatabaseHealthStatus {
                    accessible: false,
                    error_message: Some("数据库检查线程异常".to_string()),
                    db_path: Some(db_path_str),
                    db_size_bytes: db_size,
                    file_history_count: None,
                    shortcuts_count: None,
                    memos_count: None,
                })
            }
        }
    })
    .await
    .map_err(|e| format!("check_database_health join error: {}", e))?
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
        // Get temp directory
        let temp_dir = std::env::temp_dir();
        let installer_path = temp_dir.join("Everything-Setup.exe");

        // Determine download URL based on system architecture
        // For now, use 64-bit version (most common)
        let download_url = "https://www.voidtools.com/Everything-1.4.1.1024.x64-Setup.exe";

        // 使用通用下载函数，但需要自定义进度报告（发送到 launcher 窗口）
        // 由于 everything-download-progress 事件格式不同（只发送百分比），暂时不使用通用函数
        // 可以后续统一进度事件格式
        use std::io::Write;
        use std::time::Instant;
        
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|e| format!("创建HTTP客户端失败: {}", e))?;
        
        let response = client
            .get(download_url)
            .send()
            .await
            .map_err(|e| format!("下载请求失败: {}", e))?;
        
        let total_size = response
            .content_length()
            .ok_or_else(|| "无法获取文件大小".to_string())?;

        let mut file = std::fs::File::create(&installer_path)
            .map_err(|e| format!("创建文件失败: {}", e))?;

        let mut downloaded: u64 = 0;
        let mut stream = response.bytes_stream();
        let mut last_update_time = Instant::now();

        while let Some(item) = stream.next().await {
            let chunk = item.map_err(|e| format!("读取数据块失败: {}", e))?;
            file.write_all(&chunk).map_err(|e| format!("写入文件失败: {}", e))?;

            downloaded += chunk.len() as u64;

            // 每 100ms 更新一次进度
            if last_update_time.elapsed().as_millis() > 100 {
                let progress = (downloaded as f64 / total_size as f64 * 100.0) as u32;
                if let Some(window) = app.get_webview_window("launcher") {
                    let _ = window.emit("everything-download-progress", progress);
                }
                last_update_time = Instant::now();
            }
        }
        
        // 刷新文件缓冲区
        file.flush().map_err(|e| format!("刷新文件缓冲区失败: {}", e))?;
        
        // 验证文件是否存在
        if !installer_path.exists() {
            return Err(format!("下载的文件不存在: {:?}", installer_path));
        }

        Ok(installer_path.to_string_lossy().to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Everything is only available on Windows".to_string())
    }
}

#[tauri::command]
pub fn check_path_exists(path: String, app: tauri::AppHandle) -> Result<Option<file_history::FileHistoryItem>, String> {
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    let app_data_dir = get_app_data_dir(&app)?;

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

    // Try to get use_count from open_history
    let use_count = if let Some(item) = open_history::check_path_exists(&normalized_path_str, &app_data_dir)? {
        item.use_count
    } else {
        0
    };

    Ok(Some(file_history::FileHistoryItem {
        path: normalized_path_str,
        name,
        last_used: timestamp,
        use_count,
        is_folder: Some(is_folder),
        source: Some("open_history".to_string()),
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
pub fn save_clipboard_image(image_data: Vec<u8>, extension: String) -> Result<String, String> {
    use std::fs;
    use std::io::Write;
    
    // 获取临时目录
    let temp_dir = std::env::temp_dir();
    
    // 生成唯一的文件名
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let filename = format!("pasted_image_{}.{}", timestamp, extension);
    let file_path = temp_dir.join(&filename);
    
    // 写入文件
    let mut file = fs::File::create(&file_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;
    
    file.write_all(&image_data)
        .map_err(|e| format!("Failed to write image data: {}", e))?;
    
    // 返回文件路径
    file_path.to_str()
        .ok_or_else(|| "Failed to convert path to string".to_string())
        .map(|s| s.to_string())
}

#[tauri::command]
pub fn write_debug_log(message: String) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::io::Write;
    let result = OpenOptions::new()
        .create(true)
        .append(true)
        .open(r"d:\project\re-fast\.cursor\debug.log")
        .and_then(|mut f| {
            writeln!(f, r#"{{"timestamp":{},"location":"frontend","message":"{}","sessionId":"debug-session","runId":"run1"}}"#, 
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(),
                message.replace('"', r#"\""#).replace('\n', "\\n").replace('\r', "\\r")
            )
        });
    if let Err(e) = result {
        eprintln!("[DEBUG] Failed to write debug log: {}", e);
    }
    Ok(())
}

#[tauri::command]
pub fn paste_text_to_cursor(_text: String) -> Result<(), String> {
    // 注意：text 参数现在不再使用，因为剪贴板已经通过 navigator.clipboard.writeText 在前端设置好了
    // 这个函数现在只负责模拟 Ctrl+V 按键
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
        };

        const VK_CONTROL: u16 = 0x11; // Ctrl key
        const VK_V: u16 = 0x56; // V key

        // 剪贴板已经通过 navigator.clipboard.writeText 在前端设置好了
        // 这里只需要模拟 Ctrl+V 按键即可
        
        // 等待一小段时间确保剪贴板操作完成
        std::thread::sleep(std::time::Duration::from_millis(300));

        unsafe {

            // 模拟 Ctrl+V 按键
            // 按下 Ctrl
            let mut input_ctrl_down = INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_CONTROL,
                        wScan: 0,
                        dwFlags: 0,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            };

            let ctrl_down_result = SendInput(1, &mut input_ctrl_down, std::mem::size_of::<INPUT>() as i32);
            if ctrl_down_result == 0 {
                return Err("Failed to send Ctrl key down".to_string());
            }

            // 按下 V
            let mut input_v_down = INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_V,
                        wScan: 0,
                        dwFlags: 0,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            };

            let v_down_result = SendInput(1, &mut input_v_down, std::mem::size_of::<INPUT>() as i32);
            if v_down_result == 0 {
                // 释放 Ctrl 键
                let mut input_ctrl_up = INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_CONTROL,
                            wScan: 0,
                            dwFlags: KEYEVENTF_KEYUP,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                };
                SendInput(1, &mut input_ctrl_up, std::mem::size_of::<INPUT>() as i32);
                return Err("Failed to send V key down".to_string());
            }

            // 短暂延迟，确保 V 键按下事件被正确处理
            std::thread::sleep(std::time::Duration::from_millis(50));

            // 释放 V
            let mut input_v_up = INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_V,
                        wScan: 0,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            };

            let v_up_result = SendInput(1, &mut input_v_up, std::mem::size_of::<INPUT>() as i32);
            if v_up_result == 0 {
                // 释放 Ctrl 键
                let mut input_ctrl_up = INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_CONTROL,
                            wScan: 0,
                            dwFlags: KEYEVENTF_KEYUP,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                };
                SendInput(1, &mut input_ctrl_up, std::mem::size_of::<INPUT>() as i32);
                return Err("Failed to send V key up".to_string());
            }

            // 释放 Ctrl
            let mut input_ctrl_up = INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_CONTROL,
                        wScan: 0,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            };

            let ctrl_up_result = SendInput(1, &mut input_ctrl_up, std::mem::size_of::<INPUT>() as i32);
            if ctrl_up_result == 0 {
                return Err("Failed to send Ctrl key up".to_string());
            }

            Ok(())
        }
    }

    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        use std::process::Command;
        // macOS 使用 pbcopy 复制到剪贴板，然后使用 osascript 模拟粘贴
        Command::new("pbcopy")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start pbcopy: {}", e))?
            .stdin
            .ok_or_else(|| "Failed to get pbcopy stdin".to_string())?
            .write_all(text.as_bytes())
            .map_err(|e| format!("Failed to write to pbcopy: {}", e))?;

        // 使用 osascript 模拟 Cmd+V
        std::thread::sleep(std::time::Duration::from_millis(50));
        Command::new("osascript")
            .arg("-e")
            .arg("tell application \"System Events\" to keystroke \"v\" using command down")
            .output()
            .map_err(|e| format!("Failed to simulate paste: {}", e))?;

        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        use std::io::Write;
        use std::process::Command;
        // Linux 使用 xclip 复制到剪贴板，然后使用 xdotool 模拟粘贴
        Command::new("xclip")
            .arg("-selection")
            .arg("clipboard")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start xclip: {}", e))?
            .stdin
            .ok_or_else(|| "Failed to get xclip stdin".to_string())?
            .write_all(text.as_bytes())
            .map_err(|e| format!("Failed to write to xclip: {}", e))?;

        // 使用 xdotool 模拟 Ctrl+V
        std::thread::sleep(std::time::Duration::from_millis(50));
        Command::new("xdotool")
            .arg("key")
            .arg("ctrl+v")
            .output()
            .map_err(|e| format!("Failed to simulate paste: {}", e))?;

        Ok(())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("Paste to cursor is not supported on this platform".to_string())
    }
}

#[tauri::command]
pub fn get_downloads_folder() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;
        use windows_sys::Win32::UI::Shell::*;
        
        const CSIDL_PROFILE: i32 = 0x0028;
        
        unsafe {
            let mut path: Vec<u16> = vec![0; 260];
            let result = SHGetSpecialFolderPathW(0, path.as_mut_ptr(), CSIDL_PROFILE, 0);
            if result != 0 {
                let len = path.iter().position(|&x| x == 0).unwrap_or(path.len());
                path.truncate(len);
                let os_string = OsString::from_wide(&path);
                let profile_path = os_string.to_string_lossy().to_string();
                let downloads = std::path::Path::new(&profile_path).join("Downloads");
                if downloads.exists() {
                    return Ok(downloads.to_string_lossy().to_string());
                }
            }
        }
        Err("Failed to get downloads folder".to_string())
    }
    
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            let downloads = std::path::Path::new(&home).join("Downloads");
            if downloads.exists() {
                return Ok(downloads.to_string_lossy().to_string());
            }
        }
        Err("Failed to get downloads folder".to_string())
    }
    
    #[cfg(target_os = "linux")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            let downloads = std::path::Path::new(&home).join("Downloads");
            if downloads.exists() {
                return Ok(downloads.to_string_lossy().to_string());
            }
        }
        Err("Failed to get downloads folder".to_string())
    }
    
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("Downloads folder is not supported on this platform".to_string())
    }
}

#[tauri::command]
pub fn copy_file_to_downloads(source_path: String) -> Result<String, String> {
    use std::fs;
    use std::path::Path;
    
    let source = Path::new(&source_path);
    if !source.exists() {
        return Err("Source file does not exist".to_string());
    }
    
    // 获取下载目录
    let downloads_path = get_downloads_folder()?;
    let downloads = Path::new(&downloads_path);
    
    // 获取源文件名
    let filename = source.file_name()
        .ok_or_else(|| "Failed to get filename".to_string())?;
    
    let dest_path = downloads.join(filename);
    
    // 如果目标文件已存在，添加序号
    let mut final_dest = dest_path.clone();
    let mut counter = 1;
    while final_dest.exists() {
        let stem = source.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("image");
        let ext = source.extension()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        let new_filename = if ext.is_empty() {
            format!("{} ({})", stem, counter)
        } else {
            format!("{} ({}).{}", stem, counter, ext)
        };
        final_dest = downloads.join(&new_filename);
        counter += 1;
    }
    
    // 复制文件
    fs::copy(&source, &final_dest)
        .map_err(|e| format!("Failed to copy file: {}", e))?;
    
    final_dest.to_str()
        .ok_or_else(|| "Failed to convert path to string".to_string())
        .map(|s| s.to_string())
}

#[tauri::command]
pub fn launch_file(path: String, app: tauri::AppHandle) -> Result<(), String> {
    // 注意：历史记录更新已由统一更新逻辑处理（handleLaunch 开头），这里不再更新
    // Launch the file (keep using file_history::launch_file as it's just a utility function)
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
        // Check if the path is a shell: protocol path (e.g., shell:AppsFolder\...)
        let path_str_lower = trimmed.to_lowercase();
        if path_str_lower.starts_with("shell:appsfolder") {
            // UWP apps don't have a traditional file system location
            // They are packaged apps from the Microsoft Store
            return Err("UWP 应用没有传统意义上的所在文件夹，因为它们是打包在 Microsoft Store 中的应用。".to_string());
        }
        
        if path_str_lower.starts_with("shell:") {
            // For other shell: protocol paths (like shell:RecycleBinFolder), 
            // we can open them directly, but AppsFolder is special
            // These paths cannot be parsed as regular file paths
            Command::new("explorer")
                .arg(trimmed)
                .spawn()
                .map_err(|e| format!("Failed to open shell path: {}", e))?;
            return Ok(());
        }
        
        // Check if the path is in the Recycle Bin
        let is_recycle_bin = path_str_lower.contains("$recycle.bin");
        
        if is_recycle_bin {
            // For Recycle Bin files, open the Recycle Bin folder directly
            // Use shell:RecycleBinFolder to open the Recycle Bin
            Command::new("explorer")
                .arg("shell:RecycleBinFolder")
                .spawn()
                .map_err(|e| format!("Failed to open Recycle Bin: {}", e))?;
            return Ok(());
        }

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
        // Remove trailing backslash if present (explorer doesn't need it)
        parent_str = parent_str.trim_end_matches('\\').to_string();

        // Normalize the original file path for use with /select
        let mut file_path_str = trimmed.to_string();
        file_path_str = file_path_str.replace("/", "\\");
        
        // Check if the path is a directory
        let is_directory = absolute_path.exists() && absolute_path.is_dir();
        
        // Check if the path looks like a file (has an extension or is not a directory)
        let is_likely_file = absolute_path.extension().is_some() 
            || (!absolute_path.exists() && !trimmed.ends_with("\\") && !trimmed.ends_with("/"));

        // If it's a directory, open it directly
        if is_directory {
            // Get the canonicalized directory path
            let dir_path = absolute_path
                .canonicalize()
                .map_err(|e| format!("Failed to canonicalize directory path: {}", e))?
                .to_string_lossy()
                .replace("/", "\\");
            
            // Remove \\?\ prefix if present
            let mut normalized_dir = dir_path;
            if normalized_dir.starts_with("\\\\?\\") {
                normalized_dir = normalized_dir[4..].to_string();
            }
            
            // Remove trailing backslash if present
            normalized_dir = normalized_dir.trim_end_matches('\\').to_string();
            
            // Open the directory directly
            Command::new("explorer")
                .arg(&normalized_dir)
                .spawn()
                .map_err(|e| format!("Failed to open directory: {}", e))?;
        }
        // If it's a file (exists and is file) or looks like a file path, use /select
        // This ensures we open the correct folder even if the file doesn't exist
        else if (absolute_path.exists() && absolute_path.is_file()) || is_likely_file {
            // Get the absolute path for the file to select
            let path_to_select = if absolute_path.exists() {
                // If path exists, use canonicalized path
                absolute_path
                    .canonicalize()
                    .map_err(|e| format!("Failed to canonicalize path: {}", e))?
                    .to_string_lossy()
                    .replace("/", "\\")
            } else {
                // If path doesn't exist, construct absolute path from components
                let abs_path = if path_buf.is_absolute() {
                    path_buf.clone()
                } else {
                    std::env::current_dir()
                        .map_err(|e| format!("Failed to get current directory: {}", e))?
                        .join(&path_buf)
                };
                abs_path.to_string_lossy().replace("/", "\\")
            };
            
            // Remove \\?\ prefix if present (explorer doesn't handle it well with /select)
            let mut normalized_path = path_to_select;
            if normalized_path.starts_with("\\\\?\\") {
                normalized_path = normalized_path[4..].to_string();
            }
            
            // Remove trailing backslash if present
            normalized_path = normalized_path.trim_end_matches('\\').to_string();
            
            // Validate path doesn't contain invalid characters for Windows
            // Windows invalid characters: < > " | ? * and control characters
            // Note: ':' is only valid after drive letter (e.g., C:), so we check for it separately
            let invalid_chars = ['<', '>', '"', '|', '?', '*'];
            if normalized_path.chars().any(|c| invalid_chars.contains(&c)) {
                return Err(format!("Path contains invalid characters: {}", normalized_path));
            }
            
            // Check for invalid colon usage (colon is only valid after drive letter)
            // Windows allows colon only at position 1 after a drive letter (e.g., C:)
            // Remove valid drive letter prefix (e.g., "C:") and check if any colons remain
            let path_after_drive = if normalized_path.len() >= 2 
                && normalized_path.chars().nth(0).map_or(false, |c| c.is_ascii_alphabetic())
                && normalized_path.chars().nth(1) == Some(':') {
                &normalized_path[2..]
            } else {
                &normalized_path[..]
            };
            
            // If there are any colons remaining after removing drive letter, it's invalid
            if path_after_drive.contains(':') {
                return Err(format!("Path contains invalid characters: {}", normalized_path));
            }
            
            // 使用独立参数形式，避免不同 shell 对逗号/引号解析差异：
            // explorer /select, "C:\path with spaces\file.txt"
            let args = ["/select,", &normalized_path];
            Command::new("explorer")
                .args(&args)
                .spawn()
                .map_err(|e| format!("Failed to execute explorer command: {}", e))?;
        } else {
            // It's neither a directory nor a file (can't determine), just open the parent folder
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
        show_and_focus_window(&window)?;
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
    // 尝试新的窗口标签 "recording-window"，如果不存在则尝试旧标签 "main"（向后兼容）
    let window = app.get_webview_window("recording-window")
        .or_else(|| app.get_webview_window("main"));
    
    if let Some(window) = window {
        show_and_focus_window(&window)?;
    } else {
        return Err("Recording window not found".to_string());
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
pub fn delete_open_history(key: String, app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    open_history::delete_open_history(key, &app_data_dir)
}

#[tauri::command]
pub fn get_open_history_item(key: String, app: tauri::AppHandle) -> Result<Option<open_history::OpenHistoryItem>, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    open_history::check_path_exists(&key, &app_data_dir)
}

#[tauri::command]
pub fn record_plugin_usage(
    plugin_id: String,
    name: Option<String>,
    app: tauri::AppHandle,
) -> Result<plugin_usage::PluginUsage, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    plugin_usage::record_plugin_open(plugin_id, name, &app_data_dir)
}

#[tauri::command]
pub fn get_plugin_usage(app: tauri::AppHandle) -> Result<Vec<plugin_usage::PluginUsage>, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    plugin_usage::list_plugin_usage(&app_data_dir)
}

#[tauri::command]
pub async fn show_memo_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    // 尝试获取现有窗口
    if let Some(window) = app.get_webview_window("memo-window") {
        show_and_focus_window(&window)?;
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
        
        // 确保新创建的窗口显示并聚焦
        show_and_focus_window(&window)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn show_plugin_list_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    // 尝试获取现有窗口
    if let Some(window) = app.get_webview_window("plugin-list-window") {
        show_and_focus_window(&window)?;
    } else {
        // 动态创建窗口
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "plugin-list-window",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("应用中心")
        .inner_size(1000.0, 700.0)
        .resizable(true)
        .min_inner_size(700.0, 500.0)
        .center()
        .build()
        .map_err(|e| format!("创建应用中心窗口失败: {}", e))?;
        
        // 确保新创建的窗口显示并聚焦
        show_and_focus_window(&window)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn show_json_formatter_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    // 尝试获取现有窗口
    if let Some(window) = app.get_webview_window("json-formatter-window") {
        show_and_focus_window(&window)?;
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
        
        // 确保新创建的窗口显示并聚焦
        show_and_focus_window(&window)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn show_markdown_editor_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    use crate::file_watcher;

    // 尝试获取现有窗口
    if let Some(window) = app.get_webview_window("markdown-editor-window") {
        show_and_focus_window(&window)?;
    } else {
        // 动态创建窗口
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "markdown-editor-window",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("Markdown 编辑器")
        .inner_size(1000.0, 700.0)
        .resizable(true)
        .min_inner_size(800.0, 600.0)
        .center()
        .build()
        .map_err(|e| format!("创建 Markdown 编辑器窗口失败: {}", e))?;
        
        // 确保新创建的窗口显示并聚焦
        show_and_focus_window(&window)?;
        
        // 监听窗口关闭事件，清理文件监听
        let app_clone = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // 停止该窗口的所有文件监听
                let _ = file_watcher::unwatch_window("markdown-editor-window".to_string());
            }
        });
    }

    Ok(())
}

#[tauri::command]
pub async fn show_translation_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    // 尝试获取现有窗口
    if let Some(window) = app.get_webview_window("translation-window") {
        show_and_focus_window(&window)?;
    } else {
        // 动态创建窗口
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "translation-window",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("单词助手")
        .inner_size(900.0, 700.0)
        .resizable(true)
        .min_inner_size(600.0, 500.0)
        .center()
        .build()
        .map_err(|e| format!("创建翻译窗口失败: {}", e))?;
        
        // 确保新创建的窗口显示并聚焦
        show_and_focus_window(&window)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn show_hex_converter_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    // 尝试获取现有窗口
    if let Some(window) = app.get_webview_window("hex-converter-window") {
        show_and_focus_window(&window)?;
    } else {
        // 动态创建窗口
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "hex-converter-window",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("ASCII 十六进制转换器")
        .inner_size(900.0, 750.0)
        .resizable(true)
        .min_inner_size(700.0, 600.0)
        .center()
        .build()
        .map_err(|e| format!("创建 ASCII 十六进制转换器窗口失败: {}", e))?;
        
        // 确保新创建的窗口显示并聚焦
        show_and_focus_window(&window)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn show_file_toolbox_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    // 尝试获取现有窗口
    if let Some(window) = app.get_webview_window("file-toolbox-window") {
        show_and_focus_window(&window)?;
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
        
        // 确保新创建的窗口显示并聚焦
        show_and_focus_window(&window)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn show_calculator_pad_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    // 尝试获取现有窗口
    if let Some(window) = app.get_webview_window("calculator-pad-window") {
        show_and_focus_window(&window)?;
    } else {
        // 动态创建窗口
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "calculator-pad-window",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("计算稿纸")
        .inner_size(800.0, 700.0)
        .resizable(true)
        .min_inner_size(600.0, 500.0)
        .center()
        .build()
        .map_err(|e| format!("创建计算稿纸窗口失败: {}", e))?;
        
        // 确保新创建的窗口显示并聚焦
        show_and_focus_window(&window)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn show_everything_search_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    // 尝试获取现有窗口
    if let Some(window) = app.get_webview_window("everything-search-window") {
        show_and_focus_window(&window)?;
    } else {
        // 动态创建窗口
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "everything-search-window",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("Everything 文件搜索")
        .inner_size(900.0, 700.0)
        .resizable(true)
        .min_inner_size(600.0, 500.0)
        .center()
        .build()
        .map_err(|e| format!("创建 Everything 搜索窗口失败: {}", e))?;
        
        // 确保新创建的窗口显示并聚焦
        show_and_focus_window(&window)?;
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

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    use std::fs;
    let file_path = PathBuf::from(path);
    if !file_path.exists() {
        return Err("文件不存在".to_string());
    }
    
    // 先尝试读取文件元数据，检查文件大小
    let metadata = fs::metadata(&file_path)
        .map_err(|e| format!("获取文件信息失败: {}", e))?;
    let file_size = metadata.len();
    
    // 如果文件大小为0，直接返回空字符串
    if file_size == 0 {
        return Ok(String::new());
    }
    
    // 尝试读取文件内容
    // 首先尝试 UTF-8
    match fs::read_to_string(&file_path) {
        Ok(content) => Ok(content),
        Err(e) => {
            // 如果 UTF-8 读取失败，尝试读取原始字节并检测编码
            let bytes = fs::read(&file_path)
                .map_err(|e2| format!("读取文件失败: {} (原始错误: {})", e2, e))?;
            
            // 检查是否是 UTF-16 LE/BE
            if bytes.len() >= 2 {
                // 检查 BOM
                if bytes[0] == 0xFF && bytes[1] == 0xFE {
                    // UTF-16 LE with BOM
                    return Err("文件编码为 UTF-16 LE，请转换为 UTF-8".to_string());
                } else if bytes[0] == 0xFE && bytes[1] == 0xFF {
                    // UTF-16 BE with BOM
                    return Err("文件编码为 UTF-16 BE，请转换为 UTF-8".to_string());
                }
            }
            
            // 尝试使用 UTF-8 lossy 转换
            let content = String::from_utf8_lossy(&bytes).to_string();
            if content.is_empty() && !bytes.is_empty() {
                return Err(format!("文件无法解析为文本（可能是二进制文件或编码不支持）: {}", e));
            }
            Ok(content)
        }
    }
}

#[tauri::command]
pub async fn watch_markdown_file(
    app: tauri::AppHandle,
    window_label: String,
    file_path: String,
) -> Result<(), String> {
    use crate::file_watcher;
    file_watcher::watch_file(app, window_label, file_path)
}

#[tauri::command]
pub fn unwatch_markdown_file(
    window_label: String,
    file_path: String,
) -> Result<(), String> {
    use crate::file_watcher;
    file_watcher::unwatch_file(window_label, file_path)
}

#[tauri::command]
pub fn get_markdown_recent_files(app: tauri::AppHandle) -> Result<Vec<crate::markdown_recent_files::RecentFile>, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    crate::markdown_recent_files::get_all_recent_files(&app_data_dir)
}

#[tauri::command]
pub fn add_markdown_recent_file(app: tauri::AppHandle, file_path: String) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    crate::markdown_recent_files::add_recent_file(&app_data_dir, file_path)
}

#[tauri::command]
pub fn add_markdown_recent_file_with_content(
    app: tauri::AppHandle,
    file_path: String,
    content: Option<String>,
) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    crate::markdown_recent_files::add_recent_file_with_content(&app_data_dir, file_path, content)
}

#[tauri::command]
pub fn remove_markdown_recent_file(app: tauri::AppHandle, file_path: String) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    crate::markdown_recent_files::remove_recent_file(&app_data_dir, file_path)
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

// ===== Everything Filters commands =====

#[tauri::command]
pub fn get_everything_custom_filters(app: tauri::AppHandle) -> Result<Vec<everything_filters::CustomFilter>, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    everything_filters::load_custom_filters(&app_data_dir)
}

#[tauri::command]
pub fn save_everything_custom_filters(
    app: tauri::AppHandle,
    filters: Vec<everything_filters::CustomFilter>,
) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    everything_filters::save_custom_filters(&app_data_dir, &filters)
}

#[tauri::command]
pub fn get_hotkey_config(app: tauri::AppHandle) -> Result<Option<settings::HotkeyConfig>, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let settings = settings::load_settings(&app_data_dir)?;
    Ok(settings.hotkey)
}

#[tauri::command]
pub fn save_hotkey_config(
    app: tauri::AppHandle,
    config: settings::HotkeyConfig,
) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let mut settings = settings::load_settings(&app_data_dir)?;
    settings.hotkey = Some(config.clone());
    settings::save_settings(&app_data_dir, &settings)?;
    
    // 更新已注册的快捷键
    #[cfg(target_os = "windows")]
    {
        match crate::hotkey_handler::windows::update_hotkey(config) {
            Ok(_) => {
                eprintln!("Hotkey updated successfully");
            }
            Err(e) => {
                eprintln!("Failed to update hotkey: {}", e);
                // 返回错误，让前端知道更新失败
                // 但设置已经保存了，下次启动时会使用新设置
                return Err(format!("快捷键设置已保存，但立即生效失败: {}. 请重启应用以使新快捷键生效。", e));
            }
        }
    }
    
    Ok(())
}

#[tauri::command]
pub async fn show_hotkey_settings(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    println!("[后端] show_hotkey_settings: START");

    // 1. 尝试获取现有窗口
    if let Some(window) = app.get_webview_window("hotkey-settings") {
        println!("[后端] show_hotkey_settings: 窗口已存在，执行显示操作");
        show_and_focus_window(&window)?;
    } else {
        println!("[后端] show_hotkey_settings: 窗口不存在，开始动态创建");

        // 2. 动态创建窗口
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "hotkey-settings",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("快捷键设置")
        .inner_size(600.0, 500.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| format!("创建快捷键设置窗口失败: {}", e))?;

        println!("[后端] show_hotkey_settings: 窗口创建成功");
    }

    println!("[后端] show_hotkey_settings: END");
    Ok(())
}

#[tauri::command]
pub fn get_plugin_hotkeys(app: tauri::AppHandle) -> Result<std::collections::HashMap<String, settings::HotkeyConfig>, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let mut settings = settings::load_settings(&app_data_dir)?;
    
    // 自动清理已被注释/禁用的插件的快捷键（如 color_picker）
    let removed_plugins = vec!["color_picker"];
    let mut cleaned = false;
    for plugin_id in removed_plugins {
        if settings.plugin_hotkeys.remove(plugin_id).is_some() {
            cleaned = true;
        }
    }
    
    // 如果清理了快捷键，保存设置
    if cleaned {
        settings::save_settings(&app_data_dir, &settings)?;
        
        // 同步更新快捷键注册
        #[cfg(target_os = "windows")]
        {
            let _ = crate::hotkey_handler::windows::update_plugin_hotkeys(settings.plugin_hotkeys.clone());
        }
    }
    
    Ok(settings.plugin_hotkeys)
}

#[tauri::command]
pub fn save_plugin_hotkeys(
    app: tauri::AppHandle,
    plugin_hotkeys: std::collections::HashMap<String, settings::HotkeyConfig>,
) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let mut settings = settings::load_settings(&app_data_dir)?;
    settings.plugin_hotkeys = plugin_hotkeys.clone();
    settings::save_settings(&app_data_dir, &settings)?;
    
    // 更新后端快捷键注册
    #[cfg(target_os = "windows")]
    {
        if let Err(e) = crate::hotkey_handler::windows::update_plugin_hotkeys(plugin_hotkeys.clone()) {
            eprintln!("Failed to update plugin hotkeys: {}", e);
        }
        
        // 通知前端更新插件快捷键（通过事件）
        if let Err(e) = app.emit("plugin-hotkeys-updated", plugin_hotkeys) {
            eprintln!("Failed to emit plugin-hotkeys-updated event: {}", e);
        }
    }
    
    Ok(())
}

#[tauri::command]
pub fn save_plugin_hotkey(
    app: tauri::AppHandle,
    plugin_id: String,
    config: Option<settings::HotkeyConfig>,
) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let mut settings = settings::load_settings(&app_data_dir)?;
    
    // 如果设置了快捷键，检查冲突
    if let Some(ref new_hotkey) = config {
        // 检查与其他插件快捷键的冲突
        for (other_plugin_id, other_hotkey) in settings.plugin_hotkeys.iter() {
            if other_plugin_id != &plugin_id {
                // 检查快捷键是否相同
                let mut new_mods = new_hotkey.modifiers.clone();
                new_mods.sort();
                let mut other_mods = other_hotkey.modifiers.clone();
                other_mods.sort();
                
                if new_mods == other_mods && new_hotkey.key == other_hotkey.key {
                    return Err(format!(
                        "快捷键冲突：与插件 \"{}\" 的快捷键相同，请修改后再保存",
                        other_plugin_id
                    ));
                }
            }
        }
        
        // 检查与应用中心快捷键的冲突
        if let Some(ref app_center_hotkey) = settings.app_center_hotkey {
            let mut new_mods = new_hotkey.modifiers.clone();
            new_mods.sort();
            let mut center_mods = app_center_hotkey.modifiers.clone();
            center_mods.sort();
            
            if new_mods == center_mods && new_hotkey.key == app_center_hotkey.key {
                return Err("快捷键冲突：与应用中心快捷键相同，请修改后再保存".to_string());
            }
        }
        
        // 检查与启动器快捷键的冲突
        if let Some(ref launcher_hotkey) = settings.hotkey {
            let mut new_mods = new_hotkey.modifiers.clone();
            new_mods.sort();
            let mut launcher_mods = launcher_hotkey.modifiers.clone();
            launcher_mods.sort();
            
            if new_mods == launcher_mods && new_hotkey.key == launcher_hotkey.key {
                return Err("快捷键冲突：与启动器快捷键相同，请修改后再保存".to_string());
            }
        }
        
        // 检查与应用快捷键的冲突
        for (app_path, app_hotkey) in settings.app_hotkeys.iter() {
            let mut new_mods = new_hotkey.modifiers.clone();
            new_mods.sort();
            let mut app_mods = app_hotkey.modifiers.clone();
            app_mods.sort();
            
            if new_mods == app_mods && new_hotkey.key == app_hotkey.key {
                let app_name = app_path.split('/').last()
                    .or_else(|| app_path.split('\\').last())
                    .unwrap_or(app_path);
                return Err(format!(
                    "快捷键冲突：与应用 \"{}\" 的快捷键相同，请修改后再保存",
                    app_name
                ));
            }
        }
    }
    
    // 先克隆 config 用于后端注册
    let config_clone = config.clone();
    
    if let Some(hotkey) = config {
        settings.plugin_hotkeys.insert(plugin_id.clone(), hotkey);
    } else {
        settings.plugin_hotkeys.remove(&plugin_id);
    }
    
    settings::save_settings(&app_data_dir, &settings)?;
    
    // 更新后端快捷键注册
    #[cfg(target_os = "windows")]
    {
        if let Some(hotkey) = config_clone {
            // 注册新的快捷键
            if let Err(e) = crate::hotkey_handler::windows::register_plugin_hotkey(plugin_id.clone(), hotkey) {
                eprintln!("Failed to register plugin hotkey: {}", e);
            }
        } else {
            // 取消注册
            if let Err(e) = crate::hotkey_handler::windows::unregister_plugin_hotkey(&plugin_id) {
                eprintln!("Failed to unregister plugin hotkey: {}", e);
            }
        }
        
        // 通知前端更新插件快捷键
        if let Err(e) = app.emit("plugin-hotkeys-updated", settings.plugin_hotkeys.clone()) {
            eprintln!("Failed to emit plugin-hotkeys-updated event: {}", e);
        }
    }
    
    Ok(())
}

#[tauri::command]
pub fn get_app_hotkeys(app: tauri::AppHandle) -> Result<std::collections::HashMap<String, settings::HotkeyConfig>, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let settings = settings::load_settings(&app_data_dir)?;
    Ok(settings.app_hotkeys)
}

#[tauri::command]
pub fn save_app_hotkey(
    app: tauri::AppHandle,
    app_path: String,
    config: Option<settings::HotkeyConfig>,
) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let mut settings = settings::load_settings(&app_data_dir)?;
    
    // 先克隆 config 用于后端注册
    let config_clone = config.clone();
    
    if let Some(hotkey) = config {
        settings.app_hotkeys.insert(app_path.clone(), hotkey);
    } else {
        settings.app_hotkeys.remove(&app_path);
    }
    
    settings::save_settings(&app_data_dir, &settings)?;
    
    // 更新后端快捷键注册
    #[cfg(target_os = "windows")]
    {
        // 使用 "app:" 前缀来区分应用快捷键
        let hotkey_id = format!("app:{}", app_path);
        if let Some(hotkey) = config_clone {
            // 注册新的快捷键
            if let Err(e) = crate::hotkey_handler::windows::register_plugin_hotkey(hotkey_id.clone(), hotkey) {
                eprintln!("Failed to register app hotkey: {}", e);
            }
        } else {
            // 取消注册
            if let Err(e) = crate::hotkey_handler::windows::unregister_plugin_hotkey(&hotkey_id) {
                eprintln!("Failed to unregister app hotkey: {}", e);
            }
        }
        
        // 通知前端更新应用快捷键
        if let Err(e) = app.emit("app-hotkeys-updated", settings.app_hotkeys.clone()) {
            eprintln!("Failed to emit app-hotkeys-updated event: {}", e);
        }
    }
    
    Ok(())
}

#[tauri::command]
pub fn get_app_center_hotkey(app: tauri::AppHandle) -> Result<Option<settings::HotkeyConfig>, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let settings = settings::load_settings(&app_data_dir)?;
    Ok(settings.app_center_hotkey)
}

#[tauri::command]
pub fn save_app_center_hotkey(
    app: tauri::AppHandle,
    config: Option<settings::HotkeyConfig>,
) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let mut settings = settings::load_settings(&app_data_dir)?;
    
    // 先克隆 config 用于后端注册
    let config_clone = config.clone();
    
    settings.app_center_hotkey = config.clone();
    settings::save_settings(&app_data_dir, &settings)?;
    
    // 更新后端快捷键注册
    #[cfg(target_os = "windows")]
    {
        // 使用 "app_center" 作为快捷键ID
        let hotkey_id = "app_center".to_string();
        if let Some(hotkey) = config_clone {
            // 注册新的快捷键
            if let Err(e) = crate::hotkey_handler::windows::register_plugin_hotkey(hotkey_id.clone(), hotkey) {
                eprintln!("Failed to register app center hotkey: {}", e);
            }
        } else {
            // 取消注册
            if let Err(e) = crate::hotkey_handler::windows::unregister_plugin_hotkey(&hotkey_id) {
                eprintln!("Failed to unregister app center hotkey: {}", e);
            }
        }
        
        // 通知前端更新应用中心快捷键
        if let Err(e) = app.emit("app-center-hotkey-updated", config) {
            eprintln!("Failed to emit app-center-hotkey-updated event: {}", e);
        }
    }
    
    Ok(())
}

#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    // 清理快捷键钩子
    #[cfg(target_os = "windows")]
    {
        crate::hotkey_handler::windows::cleanup_hotkeys();
    }
    // 清理锁文件，以便重启后新实例可以正常启动
    use std::fs;
    use std::env;
    use std::path::PathBuf;
    
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = env::var("APPDATA") {
            let lock_file_path = PathBuf::from(appdata).join("ReFast").join("re-fast.lock");
            let _ = fs::remove_file(&lock_file_path);
        }
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        let lock_file_path = env::temp_dir().join("re-fast.lock");
        let _ = fs::remove_file(&lock_file_path);
    }
    
    app.restart();
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

/// 获取应用版本号
#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// GitHub Release 信息
#[derive(Debug, Serialize, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: String,
    body: String,
    html_url: String,
    published_at: String,
    assets: Vec<GitHubAsset>,
}

/// GitHub Asset 信息
#[derive(Debug, Serialize, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

/// 更新检查结果
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateCheckResult {
    pub has_update: bool,
    pub current_version: String,
    pub latest_version: String,
    pub release_url: String,
    pub release_name: String,
    pub release_notes: String,
    pub download_url: Option<String>,
    pub published_at: String,
}

/// 比较版本号（语义化版本比较）
/// 返回：如果 version1 > version2 返回 1，version1 < version2 返回 -1，相等返回 0
fn compare_versions(version1: &str, version2: &str) -> i32 {
    // 移除 'v' 前缀（如果有）
    let v1 = version1.trim_start_matches('v');
    let v2 = version2.trim_start_matches('v');
    
    let parts1: Vec<&str> = v1.split('.').collect();
    let parts2: Vec<&str> = v2.split('.').collect();
    
    let max_len = parts1.len().max(parts2.len());
    
    for i in 0..max_len {
        let num1 = parts1.get(i).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
        let num2 = parts2.get(i).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
        
        if num1 > num2 {
            return 1;
        } else if num1 < num2 {
            return -1;
        }
    }
    
    0
}

/// 检查更新
#[tauri::command]
pub async fn check_update() -> Result<UpdateCheckResult, String> {
    let current_version = env!("CARGO_PKG_VERSION");
    
    // GitHub API URL
    let api_url = "https://api.github.com/repos/Xieweikang123/ReFast/releases/latest";
    
    // 创建 HTTP 客户端，设置 User-Agent（GitHub API 要求）
    let client = reqwest::Client::builder()
        .user_agent("ReFast-Updater/1.0")
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
    
    // 发送请求
    let response = client
        .get(api_url)
        .send()
        .await
        .map_err(|e| format!("请求 GitHub API 失败: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!(
            "GitHub API 返回错误: {}",
            response.status()
        ));
    }
    
    // 解析 JSON
    let release: GitHubRelease = response
        .json()
        .await
        .map_err(|e| format!("解析 GitHub API 响应失败: {}", e))?;
    
    // 提取版本号（移除 'v' 前缀）
    let latest_version = release.tag_name.trim_start_matches('v').to_string();
    
    // 比较版本
    let version_comparison = compare_versions(&latest_version, current_version);
    let has_update = version_comparison > 0;
    
    // 查找 Windows MSI 安装包
    let download_url = release
        .assets
        .iter()
        .find(|asset| asset.name.ends_with(".msi"))
        .map(|asset| asset.browser_download_url.clone());
    
    Ok(UpdateCheckResult {
        has_update,
        current_version: current_version.to_string(),
        latest_version,
        release_url: release.html_url,
        release_name: release.name,
        release_notes: release.body,
        download_url,
        published_at: release.published_at,
    })
}

/// 下载进度信息
#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
    pub percentage: f64,
    pub speed: String, // 下载速度（如 "2.5 MB/s"）
}

/// 通用下载函数
/// 
/// # 参数
/// - `app_handle`: Tauri 应用句柄
/// - `download_url`: 下载链接
/// - `save_path`: 保存路径
/// - `progress_event`: 进度事件名称（可选）
/// - `user_agent`: User-Agent（可选，默认为 "ReFast-Downloader/1.0"）
async fn download_file(
    app_handle: &tauri::AppHandle,
    download_url: &str,
    save_path: &std::path::Path,
    progress_event: Option<&str>,
    user_agent: Option<&str>,
) -> Result<(), String> {
    use std::io::Write;
    use std::time::Instant;
    
    // 创建 HTTP 客户端
    let client = reqwest::Client::builder()
        .user_agent(user_agent.unwrap_or("ReFast-Downloader/1.0"))
        .timeout(Duration::from_secs(300)) // 5分钟超时
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
    
    // 发送请求
    let response = client
        .get(download_url)
        .send()
        .await
        .map_err(|e| format!("请求下载链接失败: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("下载失败: HTTP {}", response.status()));
    }
    
    // 获取文件总大小
    let total_size = response
        .content_length()
        .ok_or_else(|| "无法获取文件大小".to_string())?;
    
    // 创建文件
    let mut file = std::fs::File::create(save_path)
        .map_err(|e| format!("创建文件失败: {}", e))?;
    
    // 下载文件并报告进度
    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();
    let start_time = Instant::now();
    let mut last_update_time = Instant::now();
    
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载数据失败: {}", e))?;
        file.write_all(&chunk)
            .map_err(|e| format!("写入文件失败: {}", e))?;
        
        downloaded += chunk.len() as u64;
        
        // 每 100ms 更新一次进度
        if let Some(event_name) = progress_event {
            if last_update_time.elapsed().as_millis() > 100 {
                let elapsed_secs = start_time.elapsed().as_secs_f64();
                let speed_bytes_per_sec = if elapsed_secs > 0.0 {
                    downloaded as f64 / elapsed_secs
                } else {
                    0.0
                };
                
                let speed_str = if speed_bytes_per_sec > 1024.0 * 1024.0 {
                    format!("{:.2} MB/s", speed_bytes_per_sec / (1024.0 * 1024.0))
                } else if speed_bytes_per_sec > 1024.0 {
                    format!("{:.2} KB/s", speed_bytes_per_sec / 1024.0)
                } else {
                    format!("{:.0} B/s", speed_bytes_per_sec)
                };
                
                let percentage = (downloaded as f64 / total_size as f64) * 100.0;
                
                let progress = DownloadProgress {
                    downloaded,
                    total: total_size,
                    percentage,
                    speed: speed_str,
                };
                
                // 发送进度事件
                let _ = app_handle.emit(event_name, progress);
                last_update_time = Instant::now();
            }
        }
    }
    
    // 发送完成事件（100%）
    if let Some(event_name) = progress_event {
        let progress = DownloadProgress {
            downloaded: total_size,
            total: total_size,
            percentage: 100.0,
            speed: "完成".to_string(),
        };
        let _ = app_handle.emit(event_name, progress);
    }
    
    // 刷新文件缓冲区
    file.flush().map_err(|e| format!("刷新文件缓冲区失败: {}", e))?;
    
    Ok(())
}

/// 下载更新文件
#[tauri::command]
pub async fn download_update(
    app_handle: tauri::AppHandle,
    download_url: String,
) -> Result<String, String> {
    // 获取临时目录
    let temp_dir = std::env::temp_dir();
    let file_name = download_url
        .split('/')
        .last()
        .unwrap_or("ReFast-update.msi");
    let file_path = temp_dir.join(file_name);
    
    // 使用通用下载函数
    download_file(
        &app_handle,
        &download_url,
        &file_path,
        Some("download-progress"),
        Some("ReFast-Updater/1.0"),
    ).await?;
    
    // 返回文件路径
    Ok(file_path.to_string_lossy().to_string())
}

/// 安装更新（启动安装程序）- 不自动退出应用
#[tauri::command]
pub fn install_update(
    installer_path: String,
) -> Result<(), String> {
    use std::path::Path;
    use std::process::Command;
    
    let path = Path::new(&installer_path);
    
    // 检查文件是否存在
    if !path.exists() {
        return Err("安装程序文件不存在".to_string());
    }
    
    // 根据操作系统启动安装程序
    #[cfg(target_os = "windows")]
    {
        // Windows: 启动 MSI/EXE 安装程序
        Command::new("cmd")
            .args(&["/C", "start", "", &installer_path])
            .spawn()
            .map_err(|e| format!("启动安装程序失败: {}", e))?;
    }
    
    #[cfg(target_os = "macos")]
    {
        // macOS: 打开 DMG 或执行安装脚本
        Command::new("open")
            .arg(&installer_path)
            .spawn()
            .map_err(|e| format!("启动安装程序失败: {}", e))?;
    }
    
    #[cfg(target_os = "linux")]
    {
        // Linux: 根据文件类型执行不同的安装命令
        if installer_path.ends_with(".AppImage") {
            Command::new("chmod")
                .args(&["+x", &installer_path])
                .output()
                .map_err(|e| format!("设置执行权限失败: {}", e))?;
            
            Command::new(&installer_path)
                .spawn()
                .map_err(|e| format!("启动安装程序失败: {}", e))?;
        } else if installer_path.ends_with(".deb") {
            Command::new("xdg-open")
                .arg(&installer_path)
                .spawn()
                .map_err(|e| format!("启动安装程序失败: {}", e))?;
        } else {
            Command::new("xdg-open")
                .arg(&installer_path)
                .spawn()
                .map_err(|e| format!("启动安装程序失败: {}", e))?;
        }
    }
    
    Ok(())
}

/// 退出应用（用于安装更新后）
#[tauri::command]
pub fn quit_app(app_handle: tauri::AppHandle) -> Result<(), String> {
    // 清理快捷键钩子
    #[cfg(target_os = "windows")]
    {
        crate::hotkey_handler::windows::cleanup_hotkeys();
    }
    app_handle.exit(0);
    Ok(())
}

// ========================================
// Clipboard Commands
// ========================================

#[tauri::command]
pub async fn get_all_clipboard_items(app_handle: tauri::AppHandle) -> Result<Vec<crate::clipboard::ClipboardItem>, String> {
    let app_data_dir = get_app_data_dir(&app_handle)?;
    crate::clipboard::get_all_clipboard_items(&app_data_dir)
}

#[tauri::command]
pub async fn add_clipboard_item(
    content: String,
    content_type: String,
    app_handle: tauri::AppHandle,
) -> Result<crate::clipboard::ClipboardItem, String> {
    let app_data_dir = get_app_data_dir(&app_handle)?;
    crate::clipboard::add_clipboard_item(content, content_type, &app_data_dir)
}

#[tauri::command]
pub async fn update_clipboard_item(
    id: String,
    content: String,
    app_handle: tauri::AppHandle,
) -> Result<crate::clipboard::ClipboardItem, String> {
    let app_data_dir = get_app_data_dir(&app_handle)?;
    crate::clipboard::update_clipboard_item(id, content, &app_data_dir)
}

#[tauri::command]
pub async fn toggle_favorite_clipboard_item(
    id: String,
    app_handle: tauri::AppHandle,
) -> Result<crate::clipboard::ClipboardItem, String> {
    let app_data_dir = get_app_data_dir(&app_handle)?;
    crate::clipboard::toggle_favorite_clipboard_item(id, &app_data_dir)
}

#[tauri::command]
pub async fn delete_clipboard_item(
    id: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app_handle)?;
    crate::clipboard::delete_clipboard_item(id, &app_data_dir)
}

#[tauri::command]
pub async fn clear_clipboard_history(app_handle: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app_handle)?;
    crate::clipboard::clear_clipboard_history(&app_data_dir)
}

#[tauri::command]
pub async fn search_clipboard_items(
    query: String,
    app_handle: tauri::AppHandle,
) -> Result<Vec<crate::clipboard::ClipboardItem>, String> {
    let app_data_dir = get_app_data_dir(&app_handle)?;
    crate::clipboard::search_clipboard_items(&query, &app_data_dir)
}

#[tauri::command]
pub async fn show_clipboard_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("clipboard") {
        show_and_focus_window(&window)?;
        Ok(())
    } else {
        use tauri::{WebviewUrl, WebviewWindowBuilder};
        WebviewWindowBuilder::new(
            &app_handle,
            "clipboard",
            WebviewUrl::App("index.html#/clipboard".into()),
        )
        .title("剪切板历史")
        .inner_size(900.0, 700.0)
        .center()
        .build()
        .map_err(|e| format!("Failed to create clipboard window: {}", e))?;
        Ok(())
    }
}

#[tauri::command]
pub async fn get_clipboard_image_data(image_path: String) -> Result<Vec<u8>, String> {
    use std::fs;
    fs::read(&image_path).map_err(|e| format!("Failed to read image file: {}", e))
}

#[tauri::command]
pub async fn copy_image_to_clipboard(image_path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::fs;
        use windows_sys::Win32::System::DataExchange::{
            SetClipboardData, OpenClipboard, EmptyClipboard, CloseClipboard,
        };
        use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
        use windows_sys::Win32::Foundation::HWND;
        use windows_sys::Win32::Graphics::Gdi::BITMAPINFOHEADER;

        // 读取图片文件
        let image_data = fs::read(&image_path)
            .map_err(|e| format!("Failed to read image: {}", e))?;

        // 解码 PNG
        let decoder = png::Decoder::new(&image_data[..]);
        let mut reader = decoder.read_info()
            .map_err(|e| format!("Failed to decode PNG: {}", e))?;
        let mut buf = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf)
            .map_err(|e| format!("Failed to read PNG frame: {}", e))?;

        let width = info.width as i32;
        let height = info.height as i32;
        let bit_count = 32u16; // RGBA

        unsafe {
            if OpenClipboard(0 as HWND) == 0 {
                return Err("Failed to open clipboard".to_string());
            }

            EmptyClipboard();

            // 计算 DIB 大小
            let header_size = std::mem::size_of::<BITMAPINFOHEADER>();
            let row_size = ((width * bit_count as i32 + 31) / 32 * 4) as usize;
            let image_size = row_size * height as usize;
            let total_size = header_size + image_size;

            // 分配全局内存
            let h_mem = GlobalAlloc(GMEM_MOVEABLE, total_size);
            if h_mem.is_null() {
                CloseClipboard();
                return Err("Failed to allocate memory".to_string());
            }

            let p_mem = GlobalLock(h_mem);
            if p_mem.is_null() {
                CloseClipboard();
                return Err("Failed to lock memory".to_string());
            }

            // 填充 BITMAPINFOHEADER
            let bmi = p_mem as *mut BITMAPINFOHEADER;
            (*bmi).biSize = header_size as u32;
            (*bmi).biWidth = width;
            (*bmi).biHeight = height;
            (*bmi).biPlanes = 1;
            (*bmi).biBitCount = bit_count;
            (*bmi).biCompression = 0; // BI_RGB
            (*bmi).biSizeImage = 0;
            (*bmi).biXPelsPerMeter = 0;
            (*bmi).biYPelsPerMeter = 0;
            (*bmi).biClrUsed = 0;
            (*bmi).biClrImportant = 0;

            // 填充图片数据（转换 RGBA 到 BGRA，并上下翻转）
            let image_data_ptr = (p_mem as *mut u8).add(header_size);
            for y in 0..height {
                for x in 0..width {
                    let src_offset = ((height - 1 - y) * width + x) as usize * 4;
                    let dst_offset = (y * width + x) as usize * 4;
                    if src_offset + 3 < buf.len() {
                        *image_data_ptr.add(dst_offset) = buf[src_offset + 2]; // B
                        *image_data_ptr.add(dst_offset + 1) = buf[src_offset + 1]; // G
                        *image_data_ptr.add(dst_offset + 2) = buf[src_offset]; // R
                        *image_data_ptr.add(dst_offset + 3) = buf[src_offset + 3]; // A
                    }
                }
            }

            GlobalUnlock(h_mem);

            // 设置到剪切板 (CF_DIB = 8)
            if SetClipboardData(8, h_mem as isize) == 0 {
                CloseClipboard();
                return Err("Failed to set clipboard data".to_string());
            }

            CloseClipboard();
            Ok(())
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Not implemented for this platform".to_string())
    }
}