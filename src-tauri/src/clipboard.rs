use crate::db;
use crate::settings;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use sha2::{Sha256, Digest};

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

    // 读取上限（有进程内缓存，首次才读设置）
    let max_items = get_clipboard_max_items(app_data_dir);

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

    // 检查并限制最大数量（复用同一连接，避免再开一个连接）
    enforce_max_items_with_conn(&conn, max_items)?;

    Ok(item)
}

/// 缓存 clipboard_max_items，避免每次复制事件都完整读一遍设置。
/// 0 表示不限制（保存设置时通过 invalidate_clipboard_max_items_cache 失效）。
static CLIPBOARD_MAX_ITEMS_CACHE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
static CLIPBOARD_MAX_ITEMS_LOADED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn get_clipboard_max_items(app_data_dir: &PathBuf) -> u32 {
    use std::sync::atomic::Ordering;
    if !CLIPBOARD_MAX_ITEMS_LOADED.load(Ordering::Relaxed) {
        let max_items = settings::load_settings(app_data_dir)
            .map(|s| s.clipboard_max_items)
            .unwrap_or_default();
        CLIPBOARD_MAX_ITEMS_CACHE.store(max_items, Ordering::Relaxed);
        CLIPBOARD_MAX_ITEMS_LOADED.store(true, Ordering::Relaxed);
        max_items
    } else {
        CLIPBOARD_MAX_ITEMS_CACHE.load(Ordering::Relaxed)
    }
}

/// 设置保存后调用：让剪贴板上限缓存失效（下次读取时重新加载）
pub fn invalidate_clipboard_max_items_cache() {
    CLIPBOARD_MAX_ITEMS_LOADED.store(false, std::sync::atomic::Ordering::Relaxed);
}

/// 限制剪切板历史的最大数量，删除超出部分的记录（复用调用方的连接）
fn enforce_max_items_with_conn(conn: &rusqlite::Connection, max_items: u32) -> Result<(), String> {
    if max_items == 0 {
        // 0 表示不限制
        return Ok(());
    }

    // 统计非收藏项的数量
    let non_favorite_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM clipboard_history WHERE is_favorite = 0",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to count clipboard items: {}", e))?;

    if non_favorite_count <= max_items as i64 {
        // 未超过最大数量，不需要删除
        return Ok(());
    }
    
    // 计算需要删除的数量
    let to_delete = non_favorite_count - max_items as i64;
    
    // 查询最旧的非收藏项（按创建时间升序）
    let mut stmt = conn
        .prepare(
            "SELECT id, content, content_type 
             FROM clipboard_history 
             WHERE is_favorite = 0 
             ORDER BY created_at ASC 
             LIMIT ?1"
        )
        .map_err(|e| format!("Failed to prepare delete query: {}", e))?;
    
    let items_to_delete: Vec<(String, String, String)> = stmt
        .query_map(params![to_delete], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| format!("Failed to query items to delete: {}", e))?
        .filter_map(|r| r.ok())
        .collect();
    
    drop(stmt);

    // 删除对应的图片文件（在数据库删除之前判断引用数，文件 IO 移到批量删除之后统一做）
    let mut image_files_to_delete: Vec<String> = Vec::new();
    for (_id, content, content_type) in &items_to_delete {
        if content_type == "image" {
            let image_path = std::path::Path::new(content);
            if image_path.exists() {
                // 检查是否还有其他记录引用这个图片（待删项本身仍占 1 条引用）
                let ref_count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM clipboard_history WHERE content = ?1 AND content_type = 'image'",
                        params![content],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);

                // 只有当没有其他记录引用时才删除文件
                if ref_count <= 1 {
                    image_files_to_delete.push(content.clone());
                }
            }
        }
    }

    // 单条 SQL 批量删除数据库记录（替代逐行 DELETE，避免多次 WAL 写）
    let ids: Vec<String> = items_to_delete.iter().map(|(id, _, _)| id.clone()).collect();
    conn.execute(
        "DELETE FROM clipboard_history WHERE id IN (SELECT value FROM json_each(?1))",
        params![serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string())],
    )
    .map_err(|e| format!("Failed to delete clipboard items: {}", e))?;

    // 数据库记录已删除，现在再检查引用并删除图片文件（文件 IO 不占用数据库锁）
    for (_id, content, content_type) in &items_to_delete {
        if content_type == "image" && image_files_to_delete.iter().any(|p| p == content) {
            let image_path = std::path::Path::new(content);
            if image_path.exists() {
                // 检查是否还有其他记录引用这个图片
                let ref_count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM clipboard_history WHERE content = ?1 AND content_type = 'image'",
                        params![content],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);

                // 只有当没有其他记录引用时才删除文件
                if ref_count == 0 {
                    if let Err(e) = std::fs::remove_file(image_path) {
                        eprintln!("[Clipboard] Failed to delete image file {}: {}", content, e);
                    } else {
                        println!("[Clipboard] Deleted image file: {}", content);
                    }
                }
            }
        }
    }

    println!("[Clipboard] Deleted {} old clipboard items (max_items: {})", to_delete, max_items);

    Ok(())
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
    
    // 先查询该项的内容和类型，如果是图片则需要删除文件
    let item: Option<(String, String)> = conn
        .query_row(
            "SELECT content, content_type FROM clipboard_history WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("Failed to query clipboard item: {}", e))?;
    
    // 先删除数据库记录
    let affected = conn
        .execute("DELETE FROM clipboard_history WHERE id = ?1", params![id])
        .map_err(|e| format!("Failed to delete clipboard item: {}", e))?;
    if affected == 0 {
        return Err("Clipboard item not found".to_string());
    }
    
    if let Some((content, content_type)) = item {
        // 如果是图片类型，检查是否还有其他记录引用这个文件
        if content_type == "image" {
            let ref_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM clipboard_history WHERE content = ?1 AND content_type = 'image'",
                    params![content],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            
            println!("[Clipboard] Image {} has {} remaining references", content, ref_count);
            
            // 只有当没有其他记录引用时才删除文件
            if ref_count == 0 {
                let image_path = std::path::Path::new(&content);
                println!("[Clipboard] Deleting image: {}", content);
                
                if image_path.exists() {
                    // 重试删除最多3次
                    let mut retry = 0;
                    let max_retries = 3;
                    
                    while retry < max_retries {
                        match std::fs::remove_file(image_path) {
                            Ok(_) => {
                                println!("[Clipboard] Successfully deleted image file: {}", content);
                                break;
                            }
                            Err(e) => {
                                retry += 1;
                                eprintln!("[Clipboard] Failed to delete image file {} (attempt {}): {}", content, retry, e);
                                if retry < max_retries {
                                    std::thread::sleep(std::time::Duration::from_millis(100));
                                }
                            }
                        }
                    }
                } else {
                    eprintln!("[Clipboard] Image file not found: {}", content);
                }
            }
        }
    }
    
    Ok(())
}

/// 清空剪切板历史
pub fn clear_clipboard_history(app_data_dir: &PathBuf) -> Result<(), String> {
    let conn = db::get_connection(app_data_dir)?;
    
    // 先查询所有要删除的图片项（去重）
    let mut stmt = conn
        .prepare("SELECT DISTINCT content FROM clipboard_history WHERE is_favorite = 0 AND content_type = 'image'")
        .map_err(|e| format!("Failed to prepare query: {}", e))?;
    
    let image_paths: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| format!("Failed to query image paths: {}", e))?
        .filter_map(|r| r.ok())
        .collect();
    
    // 释放语句，避免持有数据库连接
    drop(stmt);
    
    println!("[Clipboard] Found {} unique image files to check", image_paths.len());
    
    // 先删除数据库记录
    conn.execute("DELETE FROM clipboard_history WHERE is_favorite = 0", [])
        .map_err(|e| format!("Failed to clear clipboard history: {}", e))?;
    
    // 然后检查并删除图片文件
    let mut deleted_count = 0;
    for image_path in image_paths {
        // 检查是否还有收藏记录引用这个图片
        let ref_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM clipboard_history WHERE content = ?1 AND content_type = 'image'",
                params![image_path],
                |row| row.get(0),
            )
            .unwrap_or(0);
        
        if ref_count > 0 {
            println!("[Clipboard] Skipping {} (still referenced by {} favorite(s))", image_path, ref_count);
            continue;
        }
        
        let path = std::path::Path::new(&image_path);
        println!("[Clipboard] Attempting to delete: {}", image_path);
        
        if path.exists() {
            // 重试删除最多3次
            let mut retry = 0;
            let max_retries = 3;
            let mut success = false;
            
            while retry < max_retries {
                match std::fs::remove_file(path) {
                    Ok(_) => {
                        deleted_count += 1;
                        println!("[Clipboard] Successfully deleted: {}", image_path);
                        success = true;
                        break;
                    }
                    Err(e) => {
                        retry += 1;
                        eprintln!("[Clipboard] Failed to delete image file {} (attempt {}): {}", image_path, retry, e);
                        if retry < max_retries {
                            std::thread::sleep(std::time::Duration::from_millis(100));
                        }
                    }
                }
            }
            
            if !success {
                eprintln!("[Clipboard] Gave up deleting {} after {} attempts", image_path, max_retries);
            }
        } else {
            eprintln!("[Clipboard] Image file not found: {}", image_path);
        }
    }
    
    println!("[Clipboard] Successfully deleted {} image files", deleted_count);
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
    use std::thread;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::ffi::OsStr;
    use std::ptr;
    use windows_sys::Win32::System::DataExchange::{
        GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, CloseClipboard,
        AddClipboardFormatListener, RemoveClipboardFormatListener,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock, GlobalSize};
    use windows_sys::Win32::Foundation::{HWND, HINSTANCE, LPARAM, WPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW,
        RegisterClassExW, TranslateMessage, MSG, WNDCLASSEXW, WM_CLIPBOARDUPDATE,
        WS_OVERLAPPED, CS_HREDRAW, CS_VREDRAW,
    };
    use windows_sys::Win32::Graphics::Gdi::BITMAPINFOHEADER;

    const CF_TEXT: u32 = 1;
    const CF_UNICODETEXT: u32 = 13;
    const CF_DIB: u32 = 8;

    /// 启动剪切板监控线程（使用 Windows 消息机制，完全避免冲突）
    pub fn start_clipboard_monitor(app_data_dir: PathBuf) -> Result<(), String> {
        thread::spawn(move || {
            // 创建隐藏的消息窗口来接收剪贴板更新通知
            let hwnd = match create_message_window() {
                Ok(hwnd) => hwnd,
                Err(e) => {
                    eprintln!("[Clipboard Monitor] Failed to create message window: {}", e);
                    return;
                }
            };

            // 注册剪贴板格式监听器（不需要打开剪贴板，完全避免冲突）
            unsafe {
                if AddClipboardFormatListener(hwnd) == 0 {
                    eprintln!("[Clipboard Monitor] Failed to add clipboard format listener");
                    return;
                }
            }

            let mut last_text_content = String::new();
            let mut last_image_hash = String::new();

            // 消息循环：只在收到剪贴板更新通知时才读取剪贴板
            let mut msg: MSG = unsafe { std::mem::zeroed() };
            loop {
                unsafe {
                    let result = GetMessageW(&mut msg, hwnd, 0, 0);
                    if result == 0 || result == -1 {
                        // WM_QUIT 或错误
                        break;
                    }

                    if msg.message == WM_CLIPBOARDUPDATE {
                        // 剪贴板内容已改变，现在可以安全地读取
                        // 因为这是系统通知，说明剪贴板操作已完成
                        //
                        // ⚠️ 关键约束：监听线程绝不能在持有 OpenClipboard 状态时做耗时工作。
                        // 剪贴板是全系统单例资源，打开期间其他进程（微信/资源管理器/webview）
                        // 的剪贴板访问都会被阻塞；且本线程同时是 LL 键盘钩子链路的一部分，
                        // 卡住会拖慢全局键盘响应（表现为「软件打不开」）。
                        // 因此策略是：快速快照（拷贝字节）→ 立即 CloseClipboard → 再做重处理。

                        // 检查文本内容（OpenClipboard 窗口极短：仅拷贝字符串）
                        if let Ok((content, text_changed)) = snapshot_clipboard_text(&last_text_content) {
                            if text_changed {
                                last_text_content = content.clone();
                                let dir = app_data_dir.clone();
                                // 文本入库很快，但为绝对安全仍移到后台线程，不阻塞消息循环
                                thread::spawn(move || {
                                    if let Err(e) = add_clipboard_item(content, "text".to_string(), &dir) {
                                        eprintln!("[Clipboard Monitor] Failed to add text clipboard item: {}", e);
                                    }
                                });
                            }
                        }

                        // 检查图片内容：
                        // OpenClipboard → GlobalLock → 拷贝 DIB 字节 → GlobalUnlock → CloseClipboard
                        // 之后像素转换/哈希/PNG 编码全部在剪贴板关闭状态下进行
                        match snapshot_clipboard_image() {
                            SnapshotImage::None => {}
                            SnapshotImage::NoImage => {
                                // 剪贴板无图片，无操作
                            }
                            SnapshotImage::Data(dib_bytes) => {
                                if let Some(hash16) = hash_dib_snapshot(&dib_bytes) {
                                    if hash16 != last_image_hash {
                                        last_image_hash = hash16.clone();
                                        let dir = app_data_dir.clone();
                                        // PNG 编码 + 文件 IO + DB 写入全部在后台线程
                                        thread::spawn(move || {
                                            match save_dib_snapshot_as_png(&dib_bytes, &hash16, &dir) {
                                                Ok(image_path) => {
                                                    if let Err(e) = add_clipboard_item(image_path.clone(), "image".to_string(), &dir) {
                                                        eprintln!("[Clipboard Monitor] Failed to add image clipboard item: {}", e);
                                                    }
                                                }
                                                Err(e) => {
                                                    eprintln!("[Clipboard Monitor] Failed to save clipboard image: {}", e);
                                                }
                                            }
                                        });
                                    }
                                }
                            }
                        }
                    }

                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }

            // 清理：移除监听器
            unsafe {
                RemoveClipboardFormatListener(hwnd);
            }
        });
        
        Ok(())
    }

    /// 文本快照结果
    /// (文本内容, 是否为新增内容)
    fn snapshot_clipboard_text(last_text_content: &str) -> Result<(String, bool), String> {
        let content = get_clipboard_text()?;
        let changed = !content.is_empty() && content != last_text_content;
        Ok((content, changed))
    }

    /// 图片快照枚举
    enum SnapshotImage {
        /// 打不开剪贴板等瞬时错误（下次更新会重试）
        None,
        /// 剪贴板中没有图片
        NoImage,
        /// 成功快照的完整 DIB 字节（BITMAPINFOHEADER + 像素数据）
        Data(Vec<u8>),
    }

    /// 快照剪贴板图片：仅在 OpenClipboard 状态内做「拷贝字节」这一件事，
    /// 像素转换/哈希/PNG 编码等耗时工作留给调用方在 CloseClipboard 之后处理
    fn snapshot_clipboard_image() -> SnapshotImage {
        unsafe {
            // 打不开就立即放弃（剪贴板被其他进程占用，等下一次更新通知再试）
            if OpenClipboard(0 as HWND) == 0 {
                return SnapshotImage::None;
            }

            let result = if IsClipboardFormatAvailable(CF_DIB) != 0 {
                let h_data = GetClipboardData(CF_DIB);
                if h_data == 0 {
                    SnapshotImage::None
                } else {
                    let p_data = GlobalLock(h_data as *mut std::ffi::c_void);
                    if p_data.is_null() {
                        SnapshotImage::None
                    } else {
                        // 拷贝全部 DIB 字节后立即解锁关闭
                        let size = GlobalSize(h_data as *mut std::ffi::c_void);
                        let bytes = std::slice::from_raw_parts(p_data as *const u8, size).to_vec();
                        GlobalUnlock(h_data as *mut std::ffi::c_void);
                        SnapshotImage::Data(bytes)
                    }
                }
            } else {
                SnapshotImage::NoImage
            };

            CloseClipboard();
            result
        }
    }

    /// 对 DIB 快照计算内容哈希（用于去重判断，纯内存操作）
    fn hash_dib_snapshot(dib_bytes: &[u8]) -> Option<String> {
        let mut hasher = Sha256::new();
        hasher.update(dib_bytes);
        let hash_result = hasher.finalize();
        let hash_str = format!("{:x}", hash_result);
        Some(hash_str[..16].to_string())
    }

    /// 把 DIB 快照转换为 PNG 并保存到剪贴板图片目录（后台线程调用，无剪贴板依赖）
    fn save_dib_snapshot_as_png(dib_bytes: &[u8], hash16: &str, app_data_dir: &PathBuf) -> Result<String, String> {
        if dib_bytes.len() < std::mem::size_of::<BITMAPINFOHEADER>() {
            return Err("DIB 数据过小".to_string());
        }

        // 解析 BITMAPINFOHEADER
        let bmi = unsafe { &*(dib_bytes.as_ptr() as *const BITMAPINFOHEADER) };
        let width = bmi.biWidth;
        let height = bmi.biHeight.abs();
        let bit_count = bmi.biBitCount;

        if width <= 0 || height == 0 {
            return Err(format!("无效的图片尺寸: {}x{}", width, height));
        }

        let bytes_per_pixel = (bit_count / 8) as usize;
        if bytes_per_pixel < 3 {
            // 8/16 位等低色深格式暂不支持（罕见），避免越界
            return Err(format!("不支持的位深: {}", bit_count));
        }

        let row_size = ((width * bit_count as i32 + 31) / 32 * 4) as usize;
        let header_size = std::mem::size_of::<BITMAPINFOHEADER>();
        if dib_bytes.len() < header_size + row_size * height as usize {
            return Err("DIB 数据不完整".to_string());
        }

        let image_data = &dib_bytes[header_size..];

        // 转换 BGR 到 RGB
        let mut rgba_data = Vec::with_capacity((width * height * 4) as usize);
        for y in (0..height).rev() {
            for x in 0..width {
                let offset = (y as usize * row_size + x as usize * bytes_per_pixel) as usize;
                if offset + 3 <= image_data.len() {
                    let b = image_data[offset];
                    let g = image_data[offset + 1];
                    let r = image_data[offset + 2];
                    rgba_data.push(r);
                    rgba_data.push(g);
                    rgba_data.push(b);
                    rgba_data.push(255); // Alpha
                }
            }
        }

        // 保存目录
        let clipboard_images_dir = app_data_dir.join("clipboard_images");
        std::fs::create_dir_all(&clipboard_images_dir)
            .map_err(|e| format!("Failed to create clipboard images directory: {}", e))?;

        let filename = format!("clipboard_{}.png", hash16);
        let file_path = clipboard_images_dir.join(&filename);

        // 已存在说明是重复图片，直接复用
        if file_path.exists() {
            return Ok(file_path.to_string_lossy().to_string());
        }

        save_png(&file_path, &rgba_data, width as u32, height as u32)?;
        Ok(file_path.to_string_lossy().to_string())
    }

    /// 创建隐藏的消息窗口
    fn create_message_window() -> Result<HWND, String> {
        unsafe {
            let class_name = OsStr::new("ClipboardMonitorWindow\0")
                .encode_wide()
                .collect::<Vec<u16>>();

            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(window_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: 0 as HINSTANCE,
                hIcon: 0,
                hCursor: 0,
                hbrBackground: 0,
                lpszMenuName: ptr::null(),
                lpszClassName: class_name.as_ptr(),
                hIconSm: 0,
            };

            if RegisterClassExW(&wc) == 0 {
                return Err("Failed to register window class".to_string());
            }

            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                ptr::null(),
                WS_OVERLAPPED,
                0, 0, 0, 0,
                0 as HWND,
                0,
                0 as HINSTANCE,
                ptr::null_mut(),
            );

            if hwnd == 0 {
                return Err("Failed to create window".to_string());
            }

            Ok(hwnd)
        }
    }

    /// 窗口过程函数
    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> isize {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    /// 获取剪切板文本内容
    pub fn get_clipboard_text() -> Result<String, String> {
        unsafe {
            // 尝试打开剪贴板，如果失败（可能被其他程序占用），立即返回错误
            // 不重试，避免阻塞用户的复制操作
            if OpenClipboard(0 as HWND) == 0 {
                return Err("Clipboard is busy or unavailable".to_string());
            }

            let result = if IsClipboardFormatAvailable(CF_UNICODETEXT) != 0 {
                let h_data = GetClipboardData(CF_UNICODETEXT);
                if h_data == 0 {
                    CloseClipboard();
                    return Err("Failed to get clipboard data".to_string());
                }

                let p_data = GlobalLock(h_data as *mut std::ffi::c_void);
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
                
                GlobalUnlock(h_data as *mut std::ffi::c_void);
                
                text.to_string_lossy().to_string()
            } else if IsClipboardFormatAvailable(CF_TEXT) != 0 {
                let h_data = GetClipboardData(CF_TEXT);
                if h_data == 0 {
                    CloseClipboard();
                    return Err("Failed to get clipboard data".to_string());
                }

                let p_data = GlobalLock(h_data as *mut std::ffi::c_void);
                if p_data.is_null() {
                    CloseClipboard();
                    return Err("Failed to lock clipboard data".to_string());
                }

                let c_str = std::ffi::CStr::from_ptr(p_data as *const i8);
                let text = c_str.to_string_lossy().to_string();
                
                GlobalUnlock(h_data as *mut std::ffi::c_void);
                
                text
            } else {
                String::new()
            };

            CloseClipboard();
            Ok(result)
        }
    }

    /// 保存图片为 PNG 格式
    fn save_png(path: &std::path::Path, data: &[u8], width: u32, height: u32) -> Result<(), String> {
        use std::fs::File;
        use std::io::BufWriter;
        
        let file = File::create(path)
            .map_err(|e| format!("Failed to create file: {}", e))?;
        let writer = BufWriter::new(file);

        let mut encoder = png::Encoder::new(writer, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);

        let mut writer = encoder.write_header()
            .map_err(|e| format!("Failed to write PNG header: {}", e))?;

        writer.write_image_data(data)
            .map_err(|e| format!("Failed to write PNG data: {}", e))?;

        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
pub mod monitor {
    use std::path::PathBuf;

    pub fn start_clipboard_monitor(_app_data_dir: PathBuf) -> Result<(), String> {
        Err("Clipboard monitor is not yet supported on this platform".to_string())
    }
}
