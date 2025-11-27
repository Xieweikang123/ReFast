use crate::hooks;
use crate::recording::{RecordingMeta, RecordingState};
use crate::replay::ReplayState;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tauri::Manager;

static RECORDING_STATE: LazyLock<Arc<Mutex<RecordingState>>> = LazyLock::new(|| Arc::new(Mutex::new(RecordingState::new())));

static REPLAY_STATE: LazyLock<Arc<Mutex<ReplayState>>> = LazyLock::new(|| Arc::new(Mutex::new(ReplayState::new())));

fn get_app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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
pub fn start_recording() -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        return Err("Recording is only supported on Windows".to_string());
    }

    let state = RECORDING_STATE.clone();
    let mut state_guard = state.lock().map_err(|e| e.to_string())?;
    
    if state_guard.is_recording {
        return Err("Already recording".to_string());
    }

    state_guard.start();
    drop(state_guard);
    
    // Install Windows hooks with shared state
    hooks::windows::install_hooks(state)?;
    
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
        let filename = path.strip_prefix("recordings/")
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
    fs::remove_file(&file_path)
        .map_err(|e| format!("Failed to delete recording file: {}", e))?;
    
    Ok(())
}

fn extract_recording_meta(file_path: &Path, recordings_dir: &Path) -> Result<RecordingMeta, String> {
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
    
    let event_count = json["events"]
        .as_array()
        .map(|arr| arr.len())
        .unwrap_or(0);
    
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
        let filename = path.strip_prefix("recordings/")
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
        const MIN_MOUSE_MOVE_INTERVAL_MS: u64 = 10; // Minimum 10ms between mouse moves
        
        loop {
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
                // Skip mouse move events that are too frequent
                if matches!(event.event_type, crate::recording::EventType::MouseMove) {
                    let current_time = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    
                    if current_time.saturating_sub(last_mouse_move_time) < MIN_MOUSE_MOVE_INTERVAL_MS {
                        // Skip this mouse move event to prevent system overload
                        last_time = event.time_offset_ms;
                        continue;
                    }
                    last_mouse_move_time = current_time;
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
pub fn get_playback_progress() -> Result<f32, String> {
    let state = REPLAY_STATE.lock().map_err(|e| e.to_string())?;
    Ok(state.get_progress())
}

