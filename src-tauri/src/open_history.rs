use crate::db;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OpenHistoryItem {
    pub key: String,        // path or id that uniquely identifies the item
    pub last_opened: u64,   // Unix timestamp
    pub name: Option<String>, // Display name (extracted from path/URL)
    pub use_count: u64,     // Number of times this item was used
    pub is_folder: Option<bool>, // Whether this is a folder (for file paths)
}

static OPEN_HISTORY: LazyLock<Arc<Mutex<HashMap<String, OpenHistoryItem>>>> =
    LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

pub fn get_history_file_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("open_history.json")
}

pub fn lock_history() -> Result<std::sync::MutexGuard<'static, HashMap<String, OpenHistoryItem>>, String> {
    OPEN_HISTORY
        .lock()
        .map_err(|e| format!("Failed to lock open history: {}", e))
}

// Migrate database schema to add new columns if they don't exist
fn migrate_schema(conn: &mut rusqlite::Connection) -> Result<(), String> {
    // Check if new columns exist by trying to select them
    let has_name = conn
        .prepare("SELECT name FROM open_history LIMIT 1")
        .is_ok();
    
    if !has_name {
        // Add new columns
        conn.execute("ALTER TABLE open_history ADD COLUMN name TEXT", [])
            .map_err(|e| format!("Failed to add name column: {}", e))?;
        conn.execute("ALTER TABLE open_history ADD COLUMN use_count INTEGER DEFAULT 1", [])
            .map_err(|e| format!("Failed to add use_count column: {}", e))?;
        conn.execute("ALTER TABLE open_history ADD COLUMN is_folder INTEGER", [])
            .map_err(|e| format!("Failed to add is_folder column: {}", e))?;
    }
    Ok(())
}

// Load history into an already-locked state (no additional locking)
pub fn load_history_into(
    state: &mut HashMap<String, OpenHistoryItem>,
    app_data_dir: &Path,
) -> Result<(), String> {
    let mut conn = db::get_connection(app_data_dir)?;
    maybe_migrate_from_json(&mut conn, app_data_dir)?;
    migrate_schema(&mut conn)?;

    // Try to select with new columns, fallback to old schema if columns don't exist
    let mut stmt = match conn.prepare("SELECT key, last_opened, name, use_count, is_folder FROM open_history") {
        Ok(stmt) => stmt,
        Err(_) => {
            // Fallback to old schema
            let mut stmt = conn
                .prepare("SELECT key, last_opened FROM open_history")
                .map_err(|e| format!("Failed to prepare open_history query: {}", e))?;
            
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        OpenHistoryItem {
                            key: row.get(0)?,
                            last_opened: row.get::<_, i64>(1)? as u64,
                            name: None,
                            use_count: 1,
                            is_folder: None,
                        },
                    ))
                })
                .map_err(|e| format!("Failed to iterate open_history rows: {}", e))?;

            state.clear();
            for row in rows {
                let (k, v) = row.map_err(|e| format!("Failed to read open_history row: {}", e))?;
                state.insert(k, v);
            }
            return Ok(());
        }
    };

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                OpenHistoryItem {
                    key: row.get(0)?,
                    last_opened: row.get::<_, i64>(1)? as u64,
                    name: row.get::<_, Option<String>>(2)?,
                    use_count: row.get::<_, i64>(3).unwrap_or(1) as u64,
                    is_folder: row.get::<_, Option<bool>>(4)?,
                },
            ))
        })
        .map_err(|e| format!("Failed to iterate open_history rows: {}", e))?;

    state.clear();
    for row in rows {
        let (k, v) = row.map_err(|e| format!("Failed to read open_history row: {}", e))?;
        state.insert(k, v);
    }

    Ok(())
}

// Legacy function for backward compatibility - but now uses lock_history internally
pub fn load_history(app_data_dir: &Path) -> Result<(), String> {
    let mut state = lock_history()?;
    load_history_into(&mut state, app_data_dir)
}

// Save history from a provided state (no locking)
fn save_history_internal(
    state: &HashMap<String, OpenHistoryItem>,
    app_data_dir: &Path,
) -> Result<(), String> {
    let mut conn = db::get_connection(app_data_dir)?;
    migrate_schema(&mut conn)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start open_history transaction: {}", e))?;

    tx.execute("DELETE FROM open_history", [])
        .map_err(|e| format!("Failed to clear open_history table: {}", e))?;

    for item in state.values() {
        tx.execute(
            "INSERT INTO open_history (key, last_opened, name, use_count, is_folder) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                item.key,
                item.last_opened as i64,
                item.name,
                item.use_count as i64,
                item.is_folder
            ],
        )
        .map_err(|e| format!("Failed to insert open_history row: {}", e))?;
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit open_history: {}", e))?;

    Ok(())
}

// Legacy function for backward compatibility
pub fn save_history(app_data_dir: &Path) -> Result<(), String> {
    let state = lock_history()?;
    save_history_internal(&state, app_data_dir)
}

// Add a file path or URL to open_history (similar to file_history::add_file_path)
pub fn add_item(path: String, app_data_dir: &Path) -> Result<(), String> {
    // Normalize path: trim whitespace and remove trailing backslashes/slashes
    let trimmed = path.trim();
    
    // Check if this is a URL (http:// or https://)
    let is_url = trimmed.starts_with("http://") || trimmed.starts_with("https://");
    
    let (normalized_path_str, is_folder, name) = if is_url {
        // Handle URL
        let url = trimmed.to_string();
        
        // Extract domain name as the display name
        let name = if let Some(domain_start) = url.find("://") {
            let after_protocol = &url[domain_start + 3..];
            if let Some(slash_pos) = after_protocol.find('/') {
                after_protocol[..slash_pos].to_string()
            } else {
                after_protocol.to_string()
            }
        } else {
            url.clone()
        };
        
        (url, false, Some(name))
    } else {
        // Handle file system path
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

        // Check if path is a directory
        let is_folder = normalized_path.is_dir();

        // Get name (file name or directory name)
        let name = normalized_path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| normalized_path.to_string_lossy().to_string());
        
        (normalized_path_str, is_folder, Some(name))
    };

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to get timestamp: {}", e))?
        .as_secs();

    let mut state = lock_history()?;

    if state.is_empty() {
        load_history_into(&mut state, app_data_dir)?;
    }

    // Update or create history item
    if let Some(item) = state.get_mut(&normalized_path_str) {
        let old_count = item.use_count;
        item.last_opened = timestamp;
        item.use_count += 1;
        eprintln!("[open_history::add_item] 路径已存在: {}, use_count: {} -> {}", normalized_path_str, old_count, item.use_count);
        item.is_folder = Some(is_folder); // Update is_folder in case it changed
        if name.is_some() {
            item.name = name; // Update name if provided
        }
    } else {
        eprintln!("[open_history::add_item] 创建新项: {}, use_count: 1", normalized_path_str);
        state.insert(
            normalized_path_str.clone(),
            OpenHistoryItem {
                key: normalized_path_str,
                last_opened: timestamp,
                name,
                use_count: 1,
                is_folder: Some(is_folder),
            },
        );
    }

    drop(state);

    // Save to disk
    save_history(app_data_dir)?;

    Ok(())
}

pub fn record_open(key: String, app_data_dir: &Path) -> Result<(), String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to get timestamp: {}", e))?
        .as_secs();

    let mut state = lock_history()?;
    if state.is_empty() {
        load_history_into(&mut state, app_data_dir).ok();
    }
    
    // Update or create item
    if let Some(item) = state.get_mut(&key) {
        item.last_opened = timestamp;
        item.use_count += 1;
    } else {
        state.insert(key.clone(), OpenHistoryItem {
            key: key.clone(),
            last_opened: timestamp,
            name: None,
            use_count: 1,
            is_folder: None,
        });
    }
    drop(state);

    // Save to disk
    save_history(app_data_dir)?;

    Ok(())
}

pub fn get_last_opened(key: &str) -> Option<u64> {
    let state = lock_history().ok()?;
    state.get(key).map(|item| item.last_opened)
}

pub fn get_all_history(app_data_dir: &Path) -> Result<HashMap<String, u64>, String> {
    let mut state = lock_history()?;
    load_history_into(&mut state, app_data_dir).ok(); // Ignore errors if file doesn't exist
    Ok(state.iter().map(|(k, v)| (k.clone(), v.last_opened)).collect())
}

// Get all history items with full information
pub fn get_all_history_items(app_data_dir: &Path) -> Result<HashMap<String, OpenHistoryItem>, String> {
    let mut state = lock_history()?;
    load_history_into(&mut state, app_data_dir).ok(); // Ignore errors if file doesn't exist
    Ok(state.clone())
}

pub fn delete_open_history(key: String, app_data_dir: &Path) -> Result<(), String> {
    let mut state = lock_history()?;
    load_history_into(&mut state, app_data_dir)?;

    state
        .remove(&key)
        .ok_or_else(|| format!("Open history item not found: {}", key))?;

    // Clone the state for saving (we need to release the lock first)
    let state_clone = state.clone();
    drop(state); // Release lock before calling save_history_internal

    // Save to disk (save_history_internal doesn't lock)
    save_history_internal(&state_clone, app_data_dir)?;

    Ok(())
}

fn maybe_migrate_from_json(
    conn: &mut rusqlite::Connection,
    app_data_dir: &Path,
) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM open_history", [], |row| row.get(0))
        .map_err(|e| format!("Failed to count open_history rows: {}", e))?;

    if count == 0 {
        let json_path = get_history_file_path(app_data_dir);
        if json_path.exists() {
            if let Ok(content) = fs::read_to_string(&json_path) {
                // Try to parse as new format first
                if let Ok(history) = serde_json::from_str::<HashMap<String, OpenHistoryItem>>(&content) {
                    let _ = save_history_internal(&history, app_data_dir);
                } else if let Ok(history) = serde_json::from_str::<HashMap<String, u64>>(&content) {
                    // Fallback to old format
                    let migrated: HashMap<String, OpenHistoryItem> = history
                        .iter()
                        .map(|(k, v)| {
                            (k.clone(), OpenHistoryItem {
                                key: k.clone(),
                                last_opened: *v,
                                name: None,
                                use_count: 1,
                                is_folder: None,
                            })
                        })
                        .collect();
                    let _ = save_history_internal(&migrated, app_data_dir);
                }
            }
        }
    }

    Ok(())
}

// Convert Chinese characters to pinyin (full pinyin)
#[cfg(target_os = "windows")]
fn to_pinyin(text: &str) -> String {
    #[cfg(target_os = "windows")]
    use pinyin::ToPinyin;
    text.to_pinyin()
        .filter_map(|p| p.map(|p| p.plain()))
        .collect::<Vec<_>>()
        .join("")
}

// Convert Chinese characters to pinyin initials (first letter of each pinyin)
#[cfg(target_os = "windows")]
fn to_pinyin_initials(text: &str) -> String {
    #[cfg(target_os = "windows")]
    use pinyin::ToPinyin;
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

// Search within already-locked history (no additional locking)
pub fn search_in_history(
    state: &HashMap<String, OpenHistoryItem>,
    query: &str,
) -> Vec<OpenHistoryItem> {
    if query.is_empty() {
        // Return all items sorted by last_opened (most recent first)
        let mut items: Vec<OpenHistoryItem> = state.values().cloned().collect();
        items.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
        return items;
    }

    let query_lower = query.to_lowercase();
    #[cfg(target_os = "windows")]
    let query_is_pinyin = !contains_chinese(&query_lower);

    let mut results: Vec<(OpenHistoryItem, i32)> = state
        .values()
        .filter_map(|item| {
            let name = item.name.as_ref().map(|n| n.to_lowercase()).unwrap_or_default();
            let key_lower = item.key.to_lowercase();

            let mut score = 0;

            // Direct text match (highest priority)
            if !name.is_empty() {
                if name == query_lower {
                    score += 1000;
                } else if name.starts_with(&query_lower) {
                    score += 500;
                } else if name.contains(&query_lower) {
                    score += 100;
                }
            }

            // Pinyin matching (if query is pinyin, Windows only)
            #[cfg(target_os = "windows")]
            if query_is_pinyin && !name.is_empty() {
                let name_pinyin = to_pinyin(&name).to_lowercase();
                let name_pinyin_initials = to_pinyin_initials(&name).to_lowercase();

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
            if key_lower.contains(&query_lower) {
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

// Search helper that ensures data is loaded from SQLite
pub fn search_history(
    query: &str,
    app_data_dir: &Path,
) -> Result<Vec<OpenHistoryItem>, String> {
    let mut state = lock_history()?;
    if state.is_empty() {
        load_history_into(&mut state, app_data_dir)?;
    }
    let results = search_in_history(&state, query);
    Ok(results)
}

// Update item name
pub fn update_item_name(
    key: String,
    new_name: String,
    app_data_dir: &Path,
) -> Result<OpenHistoryItem, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to get timestamp: {}", e))?
        .as_secs();

    let mut state = lock_history()?;
    load_history_into(&mut state, app_data_dir)?;

    let item = state
        .get_mut(&key)
        .ok_or_else(|| format!("Open history item not found: {}", key))?;

    item.name = Some(new_name);
    item.last_opened = timestamp;

    let item_clone = item.clone();
    let state_clone = state.clone();
    drop(state);

    save_history_internal(&state_clone, app_data_dir)?;

    Ok(item_clone)
}

// Delete by time range (inclusive), returns number of deleted items
pub fn delete_by_range(
    start_ts: Option<u64>,
    end_ts: Option<u64>,
    app_data_dir: &Path,
) -> Result<usize, String> {
    let mut state = lock_history()?;
    load_history_into(&mut state, app_data_dir)?;

    let before = state.len();
    state.retain(|_, item| {
        let ts = item.last_opened;
        if let Some(s) = start_ts {
            if ts < s {
                return true; // Keep, before range
            }
        }
        if let Some(e) = end_ts {
            if ts > e {
                return true; // Keep, after range
            }
        }
        // In range, delete
        false
    });
    let removed = before.saturating_sub(state.len());

    let state_clone = state.clone();
    drop(state);
    save_history_internal(&state_clone, app_data_dir)?;
    Ok(removed)
}

// Purge history older than specified days, returns number of deleted items
pub fn purge_history_older_than(days: u64, app_data_dir: &Path) -> Result<usize, String> {
    let mut state = lock_history()?;
    load_history_into(&mut state, app_data_dir)?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to get timestamp: {}", e))?
        .as_secs();
    let cutoff = now.saturating_sub(days.saturating_mul(86_400));

    let before = state.len();
    state.retain(|_, item| item.last_opened >= cutoff);
    let removed = before.saturating_sub(state.len());

    let state_clone = state.clone();
    drop(state);
    save_history_internal(&state_clone, app_data_dir)?;
    Ok(removed)
}

// Get history count (with timeout protection)
pub fn get_history_count(app_data_dir: &Path) -> Result<usize, String> {
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;
    
    let (tx, rx) = mpsc::channel();
    let app_data_dir_owned = app_data_dir.to_path_buf();
    
    thread::spawn(move || {
        let result = (|| -> Result<usize, String> {
            let db_path = db::get_db_path(&app_data_dir_owned);
            let conn = if db_path.exists() {
                db::get_readonly_connection(&app_data_dir_owned).or_else(|_| {
                    db::get_connection(&app_data_dir_owned)
                })?
            } else {
                db::get_connection(&app_data_dir_owned)?
            };
            
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM open_history", [], |row| row.get(0))
                .map_err(|e| format!("Failed to count open history: {}", e))?;
            Ok(count as usize)
        })();
        let _ = tx.send(result);
    });
    
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err("Database query timeout (possible lock or slow query)".to_string())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("Database query thread disconnected".to_string())
        }
    }
}

// Check if path exists in history
pub fn check_path_exists(key: &str, app_data_dir: &Path) -> Result<Option<OpenHistoryItem>, String> {
    let mut state = lock_history()?;
    load_history_into(&mut state, app_data_dir).ok();
    
    Ok(state.get(key).cloned())
}

