use crate::db;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardItem {
    pub id: String,
    pub content: String,
    pub content_type: String, // "text", "image", "file"
    pub created_at: u64,
    pub is_favorite: bool,
}

fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// 获取所有剪切板历史
pub fn get_all_clipboard_items(app_data_dir: &PathBuf) -> Result<Vec<ClipboardItem>, String> {
    let conn = db::get_readonly_connection(app_data_dir)?;

    let mut stmt = conn
        .prepare("SELECT id, content, content_type, created_at, is_favorite FROM clipboard_history ORDER BY created_at DESC")
        .map_err(|e| format!("Failed to prepare clipboard query: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(ClipboardItem {
                id: row.get(0)?,
                content: row.get(1)?,
                content_type: row.get(2)?,
                created_at: row.get::<_, i64>(3)? as u64,
                is_favorite: row.get::<_, i64>(4)? != 0,
            })
        })
        .map_err(|e| format!("Failed to iterate clipboard items: {}", e))?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|e| format!("Failed to read clipboard row: {}", e))?);
    }
    Ok(items)
}

/// 添加剪切板项
pub fn add_clipboard_item(
    content: String,
    content_type: String,
    app_data_dir: &PathBuf,
) -> Result<ClipboardItem, String> {
    let now = now_ts();
    let id = format!("clipboard-{}", now);

    let item = ClipboardItem {
        id: id.clone(),
        content: content.clone(),
        content_type: content_type.clone(),
        created_at: now,
        is_favorite: false,
    };

    let conn = db::get_connection(app_data_dir)?;
    
    // 检查是否已存在相同内容（避免重复）
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM clipboard_history WHERE content = ?1 AND content_type = ?2",
            params![content, content_type],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to check existing clipboard: {}", e))?;
    
    if let Some(existing_id) = existing {
        // 如果已存在，更新时间戳
        conn.execute(
            "UPDATE clipboard_history SET created_at = ?1 WHERE id = ?2",
            params![now as i64, existing_id],
        )
        .map_err(|e| format!("Failed to update clipboard timestamp: {}", e))?;
        
        return Ok(ClipboardItem {
            id: existing_id,
            content,
            content_type,
            created_at: now,
            is_favorite: false,
        });
    }

    conn.execute(
        "INSERT INTO clipboard_history (id, content, content_type, created_at, is_favorite)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![item.id, item.content, item.content_type, item.created_at as i64, 0],
    )
    .map_err(|e| format!("Failed to insert clipboard item: {}", e))?;

    Ok(item)
}

/// 更新剪切板项内容
pub fn update_clipboard_item(
    id: String,
    content: String,
    app_data_dir: &PathBuf,
) -> Result<ClipboardItem, String> {
    let conn = db::get_connection(app_data_dir)?;

    let existing: Option<ClipboardItem> = conn
        .query_row(
            "SELECT id, content, content_type, created_at, is_favorite FROM clipboard_history WHERE id = ?1",
            params![id],
            |row| {
                Ok(ClipboardItem {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    content_type: row.get(2)?,
                    created_at: row.get::<_, i64>(3)? as u64,
                    is_favorite: row.get::<_, i64>(4)? != 0,
                })
            },
        )
        .optional()
        .map_err(|e| format!("Failed to load clipboard item: {}", e))?;

    let mut item = existing.ok_or_else(|| format!("Clipboard item {} not found", id))?;
    item.content = content;

    conn.execute(
        "UPDATE clipboard_history SET content = ?1 WHERE id = ?2",
        params![item.content, item.id],
    )
    .map_err(|e| format!("Failed to update clipboard item: {}", e))?;

    Ok(item)
}

/// 切换收藏状态
pub fn toggle_favorite_clipboard_item(
    id: String,
    app_data_dir: &PathBuf,
) -> Result<ClipboardItem, String> {
    let conn = db::get_connection(app_data_dir)?;

    let existing: Option<ClipboardItem> = conn
        .query_row(
            "SELECT id, content, content_type, created_at, is_favorite FROM clipboard_history WHERE id = ?1",
            params![id],
            |row| {
                Ok(ClipboardItem {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    content_type: row.get(2)?,
                    created_at: row.get::<_, i64>(3)? as u64,
                    is_favorite: row.get::<_, i64>(4)? != 0,
                })
            },
        )
        .optional()
        .map_err(|e| format!("Failed to load clipboard item: {}", e))?;

    let mut item = existing.ok_or_else(|| format!("Clipboard item {} not found", id))?;
    item.is_favorite = !item.is_favorite;

    conn.execute(
        "UPDATE clipboard_history SET is_favorite = ?1 WHERE id = ?2",
        params![if item.is_favorite { 1 } else { 0 }, item.id],
    )
    .map_err(|e| format!("Failed to toggle favorite: {}", e))?;

    Ok(item)
}

/// 删除剪切板项
pub fn delete_clipboard_item(id: String, app_data_dir: &PathBuf) -> Result<(), String> {
    let conn = db::get_connection(app_data_dir)?;
    let affected = conn
        .execute("DELETE FROM clipboard_history WHERE id = ?1", params![id])
        .map_err(|e| format!("Failed to delete clipboard item: {}", e))?;
    if affected == 0 {
        return Err("Clipboard item not found".to_string());
    }
    Ok(())
}

/// 清空剪切板历史
pub fn clear_clipboard_history(app_data_dir: &PathBuf) -> Result<(), String> {
    let conn = db::get_connection(app_data_dir)?;
    conn.execute("DELETE FROM clipboard_history WHERE is_favorite = 0", [])
        .map_err(|e| format!("Failed to clear clipboard history: {}", e))?;
    Ok(())
}

/// 搜索剪切板历史
pub fn search_clipboard_items(query: &str, app_data_dir: &PathBuf) -> Result<Vec<ClipboardItem>, String> {
    let conn = db::get_readonly_connection(app_data_dir)?;

    let like = format!("%{}%", query.to_lowercase());
    let mut stmt = conn
        .prepare(
            "SELECT id, content, content_type, created_at, is_favorite
             FROM clipboard_history
             WHERE lower(content) LIKE ?1
             ORDER BY is_favorite DESC, created_at DESC",
        )
        .map_err(|e| format!("Failed to prepare clipboard search: {}", e))?;

    let rows = stmt
        .query_map(params![like], |row| {
            Ok(ClipboardItem {
                id: row.get(0)?,
                content: row.get(1)?,
                content_type: row.get(2)?,
                created_at: row.get::<_, i64>(3)? as u64,
                is_favorite: row.get::<_, i64>(4)? != 0,
            })
        })
        .map_err(|e| format!("Failed to iterate clipboard search: {}", e))?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|e| format!("Failed to read clipboard row: {}", e))?);
    }
    Ok(items)
}

#[cfg(target_os = "windows")]
pub mod monitor {
    use super::*;
    use std::sync::mpsc::{channel, Sender};
    use std::thread;
    use std::time::Duration;
    use windows_sys::Win32::System::DataExchange::{
        GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, CloseClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows_sys::Win32::Foundation::HWND;

    const CF_TEXT: u32 = 1;
    const CF_UNICODETEXT: u32 = 13;

    /// 启动剪切板监控线程
    pub fn start_clipboard_monitor(app_data_dir: PathBuf) -> Result<(), String> {
        thread::spawn(move || {
            let mut last_content = String::new();
            
            loop {
                thread::sleep(Duration::from_millis(500));
                
                if let Ok(content) = get_clipboard_text() {
                    if !content.is_empty() && content != last_content {
                        // 只记录文本内容变化
                        if let Err(e) = add_clipboard_item(content.clone(), "text".to_string(), &app_data_dir) {
                            eprintln!("[Clipboard Monitor] Failed to add clipboard item: {}", e);
                        }
                        last_content = content;
                    }
                }
            }
        });
        
        Ok(())
    }

    /// 获取剪切板文本内容
    pub fn get_clipboard_text() -> Result<String, String> {
        unsafe {
            if OpenClipboard(0 as HWND) == 0 {
                return Err("Failed to open clipboard".to_string());
            }

            let result = if IsClipboardFormatAvailable(CF_UNICODETEXT) != 0 {
                let h_data = GetClipboardData(CF_UNICODETEXT);
                if h_data == 0 {
                    CloseClipboard();
                    return Err("Failed to get clipboard data".to_string());
                }

                let p_data = GlobalLock(h_data);
                if p_data.is_null() {
                    CloseClipboard();
                    return Err("Failed to lock clipboard data".to_string());
                }

                let text = std::ffi::OsString::from_wide(
                    std::slice::from_raw_parts(
                        p_data as *const u16,
                        (0..).take_while(|&i| *((p_data as *const u16).add(i)) != 0).count(),
                    ),
                );
                
                GlobalUnlock(h_data);
                
                text.to_string_lossy().to_string()
            } else if IsClipboardFormatAvailable(CF_TEXT) != 0 {
                let h_data = GetClipboardData(CF_TEXT);
                if h_data == 0 {
                    CloseClipboard();
                    return Err("Failed to get clipboard data".to_string());
                }

                let p_data = GlobalLock(h_data);
                if p_data.is_null() {
                    CloseClipboard();
                    return Err("Failed to lock clipboard data".to_string());
                }

                let c_str = std::ffi::CStr::from_ptr(p_data as *const i8);
                let text = c_str.to_string_lossy().to_string();
                
                GlobalUnlock(h_data);
                
                text
            } else {
                String::new()
            };

            CloseClipboard();
            Ok(result)
        }
    }
}
