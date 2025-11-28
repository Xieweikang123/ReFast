use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

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

pub fn load_history(app_data_dir: &Path) -> Result<(), String> {
    let history_file = get_history_file_path(app_data_dir);
    
    if !history_file.exists() {
        return Ok(()); // No history file, start fresh
    }

    let content = fs::read_to_string(&history_file)
        .map_err(|e| format!("Failed to read history file: {}", e))?;

    let history: HashMap<String, FileHistoryItem> = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse history file: {}", e))?;

    let mut state = FILE_HISTORY.lock().map_err(|e| e.to_string())?;
    *state = history;

    Ok(())
}

pub fn save_history(app_data_dir: &Path) -> Result<(), String> {
    // Create directory if it doesn't exist
    if !app_data_dir.exists() {
        fs::create_dir_all(app_data_dir)
            .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    }

    let history_file = get_history_file_path(app_data_dir);
    
    let state = FILE_HISTORY.lock().map_err(|e| e.to_string())?;
    let history_json = serde_json::to_string_pretty(&*state)
        .map_err(|e| format!("Failed to serialize history: {}", e))?;

    fs::write(&history_file, history_json)
        .map_err(|e| format!("Failed to write history file: {}", e))?;

    Ok(())
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

pub fn search_file_history(query: &str) -> Vec<FileHistoryItem> {
    let state = FILE_HISTORY.lock().unwrap();
    
    if query.is_empty() {
        // Return all items sorted by last_used (most recent first)
        let mut items: Vec<FileHistoryItem> = state.values().cloned().collect();
        items.sort_by(|a, b| b.last_used.cmp(&a.last_used));
        return items;
    }

    let query_lower = query.to_lowercase();
    let mut results: Vec<(FileHistoryItem, i32)> = state
        .values()
        .filter_map(|item| {
            let name_lower = item.name.to_lowercase();
            let path_lower = item.path.to_lowercase();

            let mut score = 0;

            // Exact match gets highest score
            if name_lower == query_lower {
                score += 1000;
            } else if name_lower.starts_with(&query_lower) {
                score += 500;
            } else if name_lower.contains(&query_lower) {
                score += 100;
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
