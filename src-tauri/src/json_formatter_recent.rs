use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentJsonEntry {
    pub id: String,
    pub preview: String,
    pub content: String,
    pub last_opened: u64,
}

static RECENT_ENTRIES: LazyLock<Arc<Mutex<HashMap<String, RecentJsonEntry>>>> =
    LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

const MAX_RECENT_ENTRIES: usize = 10;
const MAX_CONTENT_BYTES: usize = 512 * 1024;

pub fn get_recent_entries_file_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("json_formatter_recent.json")
}

fn lock_recent_entries() -> Result<std::sync::MutexGuard<'static, HashMap<String, RecentJsonEntry>>, String> {
    RECENT_ENTRIES
        .lock()
        .map_err(|e| format!("Failed to lock json formatter recent entries: {}", e))
}

fn content_id(content: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    content.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    format!("{}...", text.chars().take(max_chars).collect::<String>())
}

fn build_preview(content: &str) -> String {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return "(空)".to_string();
    }

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        let compact = serde_json::to_string(&value).unwrap_or_else(|_| trimmed.to_string());
        truncate_chars(&compact, 80)
    } else {
        truncate_chars(trimmed, 80)
    }
}

pub fn load_recent_entries(app_data_dir: &Path) -> Result<(), String> {
    let file_path = get_recent_entries_file_path(app_data_dir);

    let mut state = lock_recent_entries()?;
    state.clear();

    if file_path.exists() {
        let content = fs::read_to_string(&file_path)
            .map_err(|e| format!("Failed to read json formatter recent file: {}", e))?;

        let entries: Vec<RecentJsonEntry> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse json formatter recent file: {}", e))?;

        for entry in entries {
            state.insert(entry.id.clone(), entry);
        }
    }

    Ok(())
}

fn save_recent_entries(app_data_dir: &Path) -> Result<(), String> {
    let file_path = get_recent_entries_file_path(app_data_dir);

    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    }

    let state = lock_recent_entries()?;
    let mut entries: Vec<RecentJsonEntry> = state.values().cloned().collect();
    entries.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
    entries.truncate(MAX_RECENT_ENTRIES);

    let content = serde_json::to_string_pretty(&entries)
        .map_err(|e| format!("Failed to serialize json formatter recent entries: {}", e))?;

    fs::write(&file_path, content)
        .map_err(|e| format!("Failed to write json formatter recent file: {}", e))?;

    Ok(())
}

pub fn get_all_recent_entries(app_data_dir: &Path) -> Result<Vec<RecentJsonEntry>, String> {
    let mut state = lock_recent_entries()?;

    if state.is_empty() {
        drop(state);
        load_recent_entries(app_data_dir)?;
        state = lock_recent_entries()?;
    }

    let mut entries: Vec<RecentJsonEntry> = state.values().cloned().collect();
    entries.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
    entries.truncate(MAX_RECENT_ENTRIES);

    Ok(entries)
}

pub fn add_recent_entry(app_data_dir: &Path, content: String) -> Result<(), String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    if trimmed.len() > MAX_CONTENT_BYTES {
        return Err(format!(
            "JSON 内容过大（超过 {}KB），无法加入最近记录",
            MAX_CONTENT_BYTES / 1024
        ));
    }

    let mut state = lock_recent_entries()?;

    if state.is_empty() {
        drop(state);
        load_recent_entries(app_data_dir)?;
        state = lock_recent_entries()?;
    }

    let id = content_id(trimmed);
    let preview = build_preview(trimmed);
    let entry = RecentJsonEntry {
        id: id.clone(),
        preview,
        content: trimmed.to_string(),
        last_opened: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };

    state.insert(id, entry);

    if state.len() > MAX_RECENT_ENTRIES {
        let mut entries: Vec<(String, RecentJsonEntry)> = state.drain().collect();
        entries.sort_by(|a, b| b.1.last_opened.cmp(&a.1.last_opened));
        entries.truncate(MAX_RECENT_ENTRIES);
        for (id, entry) in entries {
            state.insert(id, entry);
        }
    }

    drop(state);
    save_recent_entries(app_data_dir)
}

pub fn remove_recent_entry(app_data_dir: &Path, id: String) -> Result<(), String> {
    let mut state = lock_recent_entries()?;

    if state.is_empty() {
        drop(state);
        load_recent_entries(app_data_dir)?;
        state = lock_recent_entries()?;
    }

    state.remove(&id);

    drop(state);
    save_recent_entries(app_data_dir)
}
