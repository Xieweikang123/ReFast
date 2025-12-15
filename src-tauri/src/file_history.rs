use crate::db;
#[cfg(target_os = "windows")]
use pinyin::ToPinyin;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FileHistoryItem {
    pub path: String,
    pub name: String,
    pub last_used: u64, // Unix timestamp
    pub use_count: u64,
    #[serde(default)]
    pub is_folder: Option<bool>, // 是否为文件夹
}

// 临时使用 RwLock，读操作不需要锁，写操作才需要锁（测试性能影响）
static FILE_HISTORY: LazyLock<Arc<RwLock<HashMap<String, FileHistoryItem>>>> =
    LazyLock::new(|| Arc::new(RwLock::new(HashMap::new())));

pub fn get_history_file_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("file_history.json")
}

// Load history into an already-locked state (no additional locking)
pub fn load_history_into(
    state: &mut HashMap<String, FileHistoryItem>,
    app_data_dir: &Path,
) -> Result<(), String> {
    // 性能优化：搜索操作优先使用只读连接，减少文件锁竞争
    // 只读连接不能执行迁移，所以先检查数据库是否存在
    let db_path = db::get_db_path(app_data_dir);
    let conn = if db_path.exists() {
        // 数据库已存在，使用只读连接（减少锁竞争）
        match db::get_readonly_connection(app_data_dir) {
            Ok(conn) => conn,
            Err(_) => {
                // 如果只读连接失败，回退到读写连接
                let conn = db::get_connection(app_data_dir)?;
                maybe_migrate_from_json(&conn, app_data_dir)?;
                conn
            }
        }
    } else {
        // 数据库不存在，使用读写连接（需要创建和迁移）
        let conn = db::get_connection(app_data_dir)?;
        maybe_migrate_from_json(&conn, app_data_dir)?;
        conn
    };

    let mut stmt = conn
        .prepare(
            "SELECT path, name, last_used, use_count, is_folder FROM file_history ORDER BY last_used DESC",
        )
        .map_err(|e| format!("Failed to prepare file_history query: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                FileHistoryItem {
                    path: row.get(0)?,
                    name: row.get(1)?,
                    last_used: row.get::<_, i64>(2)? as u64,
                    use_count: row.get::<_, i64>(3)? as u64,
                    is_folder: row.get::<_, Option<bool>>(4)?,
                },
            ))
        })
        .map_err(|e| format!("Failed to iterate file_history rows: {}", e))?;

    state.clear();
    for row in rows {
        let (key, item) = row.map_err(|e| format!("Failed to read file_history row: {}", e))?;
        state.insert(key, item);
    }

    Ok(())
}

// Legacy function for backward compatibility - but now uses lock_history internally
// 性能优化：应用启动时预加载缓存，避免首次搜索时访问 SQLite
pub fn load_history(app_data_dir: &Path) -> Result<(), String> {
    println!("[file_history] load_history: 开始预加载缓存...");
    // 先检查缓存是否已加载
    {
        let state = lock_history()?;
        if !state.is_empty() {
            // 缓存已加载，无需重复加载
            println!("[file_history] load_history: ✓ 缓存已加载（{} 条），无需重复加载", state.len());
            return Ok(());
        }
        println!("[file_history] load_history: 缓存为空，需要加载");
    }
    // 缓存为空，加载数据
    let mut state = lock_history_write()?;
    // 双重检查：可能其他线程已经加载了
    if state.is_empty() {
        println!("[file_history] load_history: 开始从 SQLite 加载...");
        load_history_into(&mut state, app_data_dir)?;
        println!("[file_history] load_history: ✓ 预加载完成，缓存大小: {}", state.len());
    } else {
        println!("[file_history] load_history: ✓ 其他线程已加载，缓存大小: {}", state.len());
    }
    Ok(())
}

// Save history from a provided state (no locking)
fn save_history_internal(
    state: &HashMap<String, FileHistoryItem>,
    app_data_dir: &Path,
) -> Result<(), String> {
    let mut conn = db::get_connection(app_data_dir)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start file_history transaction: {}", e))?;

    tx.execute("DELETE FROM file_history", [])
        .map_err(|e| format!("Failed to clear file_history table: {}", e))?;

    for item in state.values() {
        tx.execute(
            "INSERT INTO file_history (path, name, last_used, use_count, is_folder)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                item.path,
                item.name,
                item.last_used as i64,
                item.use_count as i64,
                item.is_folder
            ],
        )
        .map_err(|e| format!("Failed to insert file_history row: {}", e))?;
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit file_history: {}", e))?;
    Ok(())
}

// Legacy function for backward compatibility
pub fn save_history(app_data_dir: &Path) -> Result<(), String> {
    let state = lock_history()?;
    save_history_internal(&state, app_data_dir)
}

/// 获取历史记录条数（必要时从磁盘加载一次）
pub fn get_history_count(app_data_dir: &Path) -> Result<usize, String> {
    let conn = db::get_connection(app_data_dir)?;
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM file_history", [], |row| row.get(0))
        .map_err(|e| format!("Failed to count file history: {}", e))?;
    Ok(count as usize)
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

    let mut state = lock_history_write()?;

    if state.is_empty() {
        load_history_into(&mut state, app_data_dir)?;
    }

    // Update or create history item
    if let Some(item) = state.get_mut(&normalized_path_str) {
        item.last_used = timestamp;
        item.use_count += 1;
        item.is_folder = Some(is_folder); // Update is_folder in case it changed
    } else {
        state.insert(
            normalized_path_str.clone(),
            FileHistoryItem {
                path: normalized_path_str,
                name,
                last_used: timestamp,
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
// 临时改为使用读锁（RwLock），读操作不需要阻塞，提升性能
pub fn lock_history(
) -> Result<std::sync::RwLockReadGuard<'static, HashMap<String, FileHistoryItem>>, String> {
    // 使用读锁，不会阻塞其他读操作
    match FILE_HISTORY.read() {
        Ok(guard) => {
            println!("[file_history] lock_history: 获取读锁成功，缓存大小: {}", guard.len());
            Ok(guard)
        }
        Err(e) => {
            println!("[file_history] lock_history: 获取读锁失败: {}", e);
            Err(format!("Failed to acquire read lock: {}", e))
        }
    }
}

// 获取写锁的辅助函数（需要公开，供其他模块使用）
pub fn lock_history_write(
) -> Result<std::sync::RwLockWriteGuard<'static, HashMap<String, FileHistoryItem>>, String> {
    match FILE_HISTORY.write() {
        Ok(guard) => {
            Ok(guard)
        }
        Err(e) => {
            println!("[file_history] lock_history_write: ✗ 获取写锁失败: {}", e);
            Err(format!("Failed to acquire write lock: {}", e))
        }
    }
}

// Search within already-locked history (no additional locking)
pub fn search_in_history(
    state: &HashMap<String, FileHistoryItem>,
    query: &str,
) -> Vec<FileHistoryItem> {
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

// Search helper that ensures data is loaded from SQLite.
// 性能优化：优先使用内存缓存，避免每次搜索都访问 SQLite
pub fn search_file_history(
    query: &str,
    app_data_dir: &Path,
) -> Result<Vec<FileHistoryItem>, String> {
    println!("[file_history] search_file_history: 开始搜索，查询: '{}'", query);
    
    // #region agent log
    use std::fs::OpenOptions;
    use std::io::Write;
    let func_start = std::time::Instant::now();
    // #endregion
    
    // 性能优化：先尝试读锁（不需要阻塞），如果数据已加载直接搜索
    {
        // #region agent log
        let read_lock_start = std::time::Instant::now();
        // #endregion
        println!("[file_history] search_file_history: 尝试获取读锁检查缓存...");
        let state = lock_history()?;
        // #region agent log
        let read_lock_duration = read_lock_start.elapsed();
        let cache_size = state.len();
        // #endregion
        if !state.is_empty() {
            // 缓存已加载，直接使用缓存搜索（不访问 SQLite）
            println!("[file_history] search_file_history: ✓ 缓存已加载（{} 条），直接使用缓存搜索，不访问 SQLite", state.len());
            // #region agent log
            let search_start = std::time::Instant::now();
            // #endregion
            let results = search_in_history(&state, query);
            // #region agent log
            let search_duration = search_start.elapsed();
            let total_duration = func_start.elapsed();
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(r"d:\project\re-fast\.cursor\debug.log") {
                let _ = writeln!(file, r#"{{"location":"file_history.rs:401","message":"使用缓存搜索","data":{{"read_lock_wait_ms":{},"search_duration_ms":{},"total_duration_ms":{},"cache_size":{},"results_count":{}}},"timestamp":{},"sessionId":"debug-session","runId":"run1","hypothesisId":"D"}}"#, read_lock_duration.as_millis(), search_duration.as_millis(), total_duration.as_millis(), cache_size, results.len(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
            }
            // #endregion
            println!("[file_history] search_file_history: ✓ 缓存搜索完成，返回 {} 条结果", results.len());
            return Ok(results);
        }
        println!("[file_history] search_file_history: ✗ 缓存为空，需要从 SQLite 加载");
        // #region agent log
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(r"d:\project\re-fast\.cursor\debug.log") {
            let _ = writeln!(file, r#"{{"location":"file_history.rs:405","message":"缓存为空，需要加载","data":{{"read_lock_wait_ms":{}}},"timestamp":{},"sessionId":"debug-session","runId":"run1","hypothesisId":"D"}}"#, read_lock_duration.as_millis(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
        }
        // #endregion
    }
    
    // 缓存为空，需要加载（使用写锁，只加载一次）
    // 注意：这里会访问 SQLite，但只会在第一次搜索或缓存被清空时执行
    {
        // #region agent log
        let write_lock_start = std::time::Instant::now();
        // #endregion
        println!("[file_history] search_file_history: 获取写锁准备加载数据...");
        let mut state = lock_history_write()?;
        // #region agent log
        let write_lock_wait = write_lock_start.elapsed();
        // #endregion
        // 双重检查：可能其他线程已经加载了
        if state.is_empty() {
            println!("[file_history] search_file_history: 缓存确实为空，开始从 SQLite 加载...");
            // #region agent log
            let sqlite_load_start = std::time::Instant::now();
            // #endregion
            // 只在缓存为空时加载，避免重复加载
            load_history_into(&mut state, app_data_dir)?;
            // #region agent log
            let sqlite_load_duration = sqlite_load_start.elapsed();
            // #endregion
            println!("[file_history] search_file_history: ✓ SQLite 加载完成，缓存大小: {}", state.len());
            // #region agent log
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(r"d:\project\re-fast\.cursor\debug.log") {
                let _ = writeln!(file, r#"{{"location":"file_history.rs:417","message":"从SQLite加载数据","data":{{"write_lock_wait_ms":{},"sqlite_load_ms":{},"cache_size":{}}},"timestamp":{},"sessionId":"debug-session","runId":"run1","hypothesisId":"D"}}"#, write_lock_wait.as_millis(), sqlite_load_duration.as_millis(), state.len(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
            }
            // #endregion
        } else {
            println!("[file_history] search_file_history: ✓ 其他线程已加载，缓存大小: {}", state.len());
            // #region agent log
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(r"d:\project\re-fast\.cursor\debug.log") {
                let _ = writeln!(file, r#"{{"location":"file_history.rs:420","message":"其他线程已加载","data":{{"write_lock_wait_ms":{},"cache_size":{}}},"timestamp":{},"sessionId":"debug-session","runId":"run1","hypothesisId":"D"}}"#, write_lock_wait.as_millis(), state.len(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
            }
            // #endregion
        }
        // 释放写锁
    }
    
    // 使用读锁进行搜索（缓存已加载，不访问 SQLite）
    println!("[file_history] search_file_history: 使用读锁进行搜索...");
    // #region agent log
    let final_read_lock_start = std::time::Instant::now();
    // #endregion
    let state = lock_history()?;
    // #region agent log
    let final_read_lock_wait = final_read_lock_start.elapsed();
    let search_start = std::time::Instant::now();
    // #endregion
    let results = search_in_history(&state, query);
    // #region agent log
    let search_duration = search_start.elapsed();
    let total_duration = func_start.elapsed();
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(r"d:\project\re-fast\.cursor\debug.log") {
        let _ = writeln!(file, r#"{{"location":"file_history.rs:428","message":"加载后搜索","data":{{"final_read_lock_wait_ms":{},"search_duration_ms":{},"total_duration_ms":{},"results_count":{}}},"timestamp":{},"sessionId":"debug-session","runId":"run1","hypothesisId":"D"}}"#, final_read_lock_wait.as_millis(), search_duration.as_millis(), total_duration.as_millis(), results.len(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
    }
    // #endregion
    println!("[file_history] search_file_history: ✓ 搜索完成，返回 {} 条结果", results.len());
    Ok(results)
}

pub fn delete_file_history(path: String, app_data_dir: &Path) -> Result<(), String> {
    // Lock once, do all operations
    let mut state = lock_history_write()?;
    load_history_into(&mut state, app_data_dir)?;

    state
        .remove(&path)
        .ok_or_else(|| format!("File history item not found: {}", path))?;

    // Clone the state for saving (we need to release the lock first)
    let state_clone = state.clone();
    drop(state); // Release lock before calling save_history_internal

    // Save to disk (save_history_internal doesn't lock)
    save_history_internal(&state_clone, app_data_dir)?;

    Ok(())
}

/// 按时间范围删除历史记录（闭区间），返回删除条数
pub fn delete_file_history_by_range(
    start_ts: Option<u64>,
    end_ts: Option<u64>,
    app_data_dir: &Path,
) -> Result<usize, String> {
    // start_ts/end_ts 为 Unix 秒时间戳，若为空则不限制该侧
    let mut state = lock_history_write()?;
    load_history_into(&mut state, app_data_dir)?;

    let before = state.len();
    state.retain(|_, item| {
        let ts = item.last_used;
        if let Some(s) = start_ts {
            if ts < s {
                return true; // 保留，未到范围
            }
        }
        if let Some(e) = end_ts {
            if ts > e {
                return true; // 保留，超出范围
            }
        }
        // 在范围内则删除
        false
    });
    let removed = before.saturating_sub(state.len());

    save_history_internal(&state, app_data_dir)?;
    Ok(removed)
}

/// 清理早于指定天数的历史记录，返回删除条数
pub fn purge_history_older_than(days: u64, app_data_dir: &Path) -> Result<usize, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let mut state = lock_history_write()?;
    // 确保内存数据最新
    load_history_into(&mut state, app_data_dir)?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to get timestamp: {}", e))?
        .as_secs();
    let cutoff = now.saturating_sub(days.saturating_mul(86_400));

    let before = state.len();
    state.retain(|_, item| item.last_used >= cutoff);
    let removed = before.saturating_sub(state.len());

    save_history_internal(&state, app_data_dir)?;
    Ok(removed)
}

pub fn update_file_history_name(
    path: String,
    new_name: String,
    app_data_dir: &Path,
) -> Result<FileHistoryItem, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to get timestamp: {}", e))?
        .as_secs();

    // Lock once, do all operations
    let mut state = lock_history_write()?;
    load_history_into(&mut state, app_data_dir)?;

    let item = state
        .get_mut(&path)
        .ok_or_else(|| format!("File history item not found: {}", path))?;

    item.name = new_name;
    item.last_used = timestamp;

    let item_clone = item.clone();
    let state_clone = state.clone();
    drop(state); // Release lock before calling save

    save_history_internal(&state_clone, app_data_dir)?;

    Ok(item_clone)
}

fn maybe_migrate_from_json(
    conn: &rusqlite::Connection,
    app_data_dir: &Path,
) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM file_history", [], |row| row.get(0))
        .map_err(|e| format!("Failed to count file_history rows: {}", e))?;

    if count == 0 {
        let history_file = get_history_file_path(app_data_dir);
        if history_file.exists() {
            if let Ok(content) = fs::read_to_string(&history_file) {
                if let Ok(history) =
                    serde_json::from_str::<HashMap<String, FileHistoryItem>>(&content)
                {
                    let _ = save_history_internal(&history, app_data_dir);
                }
            }
        }
    }

    Ok(())
}

pub fn launch_file(path: &str) -> Result<(), String> {
    let trimmed = path.trim();
    
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::{
            ShellExecuteExW, SHELLEXECUTEINFOW, SHELLEXECUTEINFOW_0,
        };
        
        // Special handling for control command (traditional Control Panel)
        if trimmed == "control" {
            use std::process::Command;
            use std::os::windows::process::CommandExt;
            
            eprintln!("[DEBUG] launch_file: executing control command");
            
            Command::new("control.exe")
                .creation_flags(0x08000000) // CREATE_NO_WINDOW - 不显示控制台窗口
                .spawn()
                .map_err(|e| format!("Failed to open Control Panel: {}", e))?;
            
            return Ok(());
        }
        
        // Special handling for ms-settings: URI (Windows 10/11 Settings app)
        if trimmed.starts_with("ms-settings:") {
            use std::process::Command;
            use std::os::windows::process::CommandExt;
            
            eprintln!("[DEBUG] launch_file: executing ms-settings URI: {}", trimmed);
            
            Command::new("cmd")
                .args(&["/c", "start", "", trimmed])
                .creation_flags(0x08000000) // CREATE_NO_WINDOW - 不显示控制台窗口
                .spawn()
                .map_err(|e| format!("Failed to open Windows Settings: {}", e))?;
            
            return Ok(());
        }
        
        // Check if this is a CLSID path (virtual folder like Recycle Bin)
        // CLSID paths start with "::"
        let is_clsid_path = trimmed.starts_with("::");
        
        let path_str = if is_clsid_path {
            // For CLSID paths, use as-is (don't normalize)
            trimmed.to_string()
        } else {
            // For normal paths, normalize: remove trailing backslashes/slashes and convert to backslashes
            let normalized = trimmed.trim_end_matches(|c| c == '\\' || c == '/');
            normalized.replace("/", "\\")
        };
        
        if !is_clsid_path {
            // For normal paths, check if they exist
            let path_buf = PathBuf::from(&path_str);
            if !path_buf.exists() {
                return Err(format!("Path not found: {}", path_str));
            }
        }
        
        eprintln!("[DEBUG] launch_file: opening path '{}' (is_clsid: {})", path_str, is_clsid_path);
        
        // Convert string to wide string (UTF-16) for Windows API
        let path_wide: Vec<u16> = OsStr::new(&path_str)
            .encode_wide()
            .chain(Some(0))
            .collect();
        
        // Use ShellExecuteExW for better error handling and control
        // This provides more detailed error information than ShellExecuteW
        let mut exec_info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: 0, // No special flags needed
            hwnd: 0, // No parent window
            lpVerb: std::ptr::null(), // NULL means "open"
            lpFile: path_wide.as_ptr(),
            lpParameters: std::ptr::null(),
            lpDirectory: std::ptr::null(),
            nShow: 1, // SW_SHOWNORMAL
            hInstApp: 0,
            lpIDList: std::ptr::null_mut(),
            lpClass: std::ptr::null(),
            hkeyClass: 0,
            dwHotKey: 0,
            Anonymous: SHELLEXECUTEINFOW_0 { hIcon: 0 },
            hProcess: 0,
        };
        
        let result = unsafe {
            ShellExecuteExW(&mut exec_info)
        };
        
        // ShellExecuteExW returns non-zero (TRUE) on success
        if result == 0 {
            // Get last error for more detailed error message
            use windows_sys::Win32::Foundation::GetLastError;
            let error_code = unsafe { GetLastError() };
            return Err(format!(
                "Failed to open path: {} (error code: {})",
                path_str, error_code
            ));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        use std::process::Command;
        // On Unix-like systems, use xdg-open
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to launch file: {}", e))?;
    }

    Ok(())
}
