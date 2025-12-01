use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(target_os = "windows")]
use pinyin::{ToPinyin};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FileHistoryItem {
    pub path: String,
    pub name: String,
    pub last_used: u64, // Unix timestamp
    pub use_count: u64,
}

static FILE_HISTORY: LazyLock<Arc<Mutex<HashMap<String, FileHistoryItem>>>> =
    LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

pub fn get_history_file_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("file_history.json")
}

// Load history into an already-locked state (no additional locking)
pub fn load_history_into(state: &mut HashMap<String, FileHistoryItem>, app_data_dir: &Path) -> Result<(), String> {
    let history_file = get_history_file_path(app_data_dir);
    println!("[后端] file_history.load_history_into: Loading from {:?}", history_file);
    
    if !history_file.exists() {
        println!("[后端] file_history.load_history_into: History file does not exist, starting fresh");
        return Ok(()); // No history file, start fresh
    }

    println!("[后端] file_history.load_history_into: Reading file...");
    let content = match fs::read_to_string(&history_file) {
        Ok(c) => {
            println!("[后端] file_history.load_history_into: File read successfully, {} bytes", c.len());
            c
        }
        Err(e) => {
            println!("[后端] file_history.load_history_into: ERROR reading file: {}", e);
            return Err(format!("Failed to read history file: {}", e));
        }
    };

    println!("[后端] file_history.load_history_into: Parsing JSON...");
    let history = match serde_json::from_str::<HashMap<String, FileHistoryItem>>(&content) {
        Ok(h) => {
            println!("[后端] file_history.load_history_into: JSON parsed successfully, {} items", h.len());
            h
        }
        Err(e) => {
            println!("[后端] file_history.load_history_into: ERROR parsing JSON: {}", e);
            return Err(format!("Failed to parse history file: {}", e));
        }
    };

    *state = history;
    println!("[后端] file_history.load_history_into: History loaded into state successfully");

    Ok(())
}

// Legacy function for backward compatibility - but now uses lock_history internally
pub fn load_history(app_data_dir: &Path) -> Result<(), String> {
    let mut state = lock_history()?;
    load_history_into(&mut state, app_data_dir)
}

// Save history from a provided state (no locking)
fn save_history_internal(state: &HashMap<String, FileHistoryItem>, app_data_dir: &Path) -> Result<(), String> {
    // Create directory if it doesn't exist
    if !app_data_dir.exists() {
        fs::create_dir_all(app_data_dir)
            .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    }

    let history_file = get_history_file_path(app_data_dir);
    
    let history_json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Failed to serialize history: {}", e))?;

    fs::write(&history_file, history_json)
        .map_err(|e| format!("Failed to write history file: {}", e))?;

    Ok(())
}

// Legacy function for backward compatibility
pub fn save_history(app_data_dir: &Path) -> Result<(), String> {
    let state = lock_history()?;
    save_history_internal(&state, app_data_dir)
}

pub fn add_file_path(path: String, app_data_dir: &Path) -> Result<(), String> {
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
        return Err(format!("Path not found: {}", normalized_path_str));
    }

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

    let mut state = FILE_HISTORY.lock().map_err(|e| e.to_string())?;

    // Update or create history item
    if let Some(item) = state.get_mut(&normalized_path_str) {
        item.last_used = timestamp;
        item.use_count += 1;
    } else {
        state.insert(
            normalized_path_str.clone(),
            FileHistoryItem {
                path: normalized_path_str,
                name,
                last_used: timestamp,
                use_count: 1,
            },
        );
    }

    drop(state);
    
    // Save to disk
    save_history(app_data_dir)?;

    Ok(())
}

// Convert Chinese characters to pinyin (full pinyin)
#[cfg(target_os = "windows")]
fn to_pinyin(text: &str) -> String {
    text.to_pinyin()
        .filter_map(|p| p.map(|p| p.plain()))
        .collect::<Vec<_>>()
        .join("")
}

// Convert Chinese characters to pinyin initials (first letter of each pinyin)
#[cfg(target_os = "windows")]
fn to_pinyin_initials(text: &str) -> String {
    text.to_pinyin()
        .filter_map(|p| p.map(|p| p.plain().chars().next()))
        .flatten()
        .collect::<String>()
}

// Check if text contains Chinese characters
#[cfg(target_os = "windows")]
fn contains_chinese(text: &str) -> bool {
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
}

// Get a lock guard - caller must ensure no nested locking
pub fn lock_history() -> Result<std::sync::MutexGuard<'static, HashMap<String, FileHistoryItem>>, String> {
    println!("[后端] file_history.lock_history: Attempting to acquire lock...");
    match FILE_HISTORY.lock() {
        Ok(guard) => {
            println!("[后端] file_history.lock_history: Lock acquired successfully");
            Ok(guard)
        }
        Err(e) => {
            println!("[后端] file_history.lock_history: ERROR acquiring lock: {}", e);
            Err(e.to_string())
        }
    }
}

// Search within already-locked history (no additional locking)
pub fn search_in_history(state: &HashMap<String, FileHistoryItem>, query: &str) -> Vec<FileHistoryItem> {
    if query.is_empty() {
        // Return all items sorted by last_used (most recent first)
        let mut items: Vec<FileHistoryItem> = state.values().cloned().collect();
        items.sort_by(|a, b| b.last_used.cmp(&a.last_used));
        return items;
    }

    let query_lower = query.to_lowercase();
    #[cfg(target_os = "windows")]
    let query_is_pinyin = !contains_chinese(&query_lower);
    
    let mut results: Vec<(FileHistoryItem, i32)> = state
        .values()
        .filter_map(|item| {
            let name_lower = item.name.to_lowercase();
            let path_lower = item.path.to_lowercase();

            let mut score = 0;

            // Direct text match (highest priority)
            if name_lower == query_lower {
                score += 1000;
            } else if name_lower.starts_with(&query_lower) {
                score += 500;
            } else if name_lower.contains(&query_lower) {
                score += 100;
            }

            // Pinyin matching (if query is pinyin, Windows only)
            #[cfg(target_os = "windows")]
            if query_is_pinyin {
                let name_pinyin = to_pinyin(&item.name).to_lowercase();
                let name_pinyin_initials = to_pinyin_initials(&item.name).to_lowercase();
                
                // Full pinyin match
                if name_pinyin == query_lower {
                    score += 800;
                } else if name_pinyin.starts_with(&query_lower) {
                    score += 400;
                } else if name_pinyin.contains(&query_lower) {
                    score += 150;
                }
                
                // Pinyin initials match
                if name_pinyin_initials == query_lower {
                    score += 600;
                } else if name_pinyin_initials.starts_with(&query_lower) {
                    score += 300;
                } else if name_pinyin_initials.contains(&query_lower) {
                    score += 120;
                }
            }

            // Path match gets lower score
            if path_lower.contains(&query_lower) {
                score += 10;
            }

            if score > 0 {
                // Boost score by use_count and recency
                score += (item.use_count as i32).min(100); // Max 100 bonus points
                Some((item.clone(), score))
            } else {
                None
            }
        })
        .collect();

    // Sort by score (descending)
    results.sort_by(|a, b| b.1.cmp(&a.1));

    results.into_iter().map(|(item, _)| item).collect()
}

// Legacy function for backward compatibility - but now uses lock_history internally
pub fn search_file_history(query: &str) -> Vec<FileHistoryItem> {
    let state = lock_history().unwrap();
    search_in_history(&state, query)
}

pub fn delete_file_history(path: String, app_data_dir: &Path) -> Result<(), String> {
    // Lock once, do all operations
    let mut state = lock_history()?;
    
    state.remove(&path)
        .ok_or_else(|| format!("File history item not found: {}", path))?;
    
    // Clone the state for saving (we need to release the lock first)
    let state_clone = state.clone();
    drop(state); // Release lock before calling save_history_internal
    
    // Save to disk (save_history_internal doesn't lock)
    save_history_internal(&state_clone, app_data_dir)?;
    
    Ok(())
}

pub fn update_file_history_name(path: String, new_name: String, app_data_dir: &Path) -> Result<FileHistoryItem, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to get timestamp: {}", e))?
        .as_secs();
    
    // Lock once, do all operations
    let mut state = lock_history()?;
    
    let item = state.get_mut(&path)
        .ok_or_else(|| format!("File history item not found: {}", path))?;
    
    item.name = new_name;
    item.last_used = timestamp;
    
    let item_clone = item.clone();
    let state_clone = state.clone();
    drop(state); // Release lock before calling save
    
    save_history_internal(&state_clone, app_data_dir)?;
    
    Ok(item_clone)
}

pub fn launch_file(path: &str) -> Result<(), String> {
    use std::process::Command;

    // Normalize path: trim whitespace and remove trailing backslashes/slashes
    let trimmed = path.trim();
    let trimmed = trimmed.trim_end_matches(|c| c == '\\' || c == '/');
    
    let path_buf = PathBuf::from(trimmed);
    
    if !path_buf.exists() {
        return Err(format!("Path not found: {}", trimmed));
    }

    #[cfg(target_os = "windows")]
    {
        // On Windows, use `start` command to open files/folders with their default application
        // Use the normalized path (without trailing backslash)
        let path_str = trimmed.replace("/", "\\");
        Command::new("cmd")
            .args(&["/C", "start", "", &path_str])
            .spawn()
            .map_err(|e| format!("Failed to launch path: {}", e))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        // On Unix-like systems, use xdg-open
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to launch file: {}", e))?;
    }

    Ok(())
}
