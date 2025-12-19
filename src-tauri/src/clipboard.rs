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

    // 检查并限制最大数量
    enforce_max_items(app_data_dir)?;

    Ok(item)
}

/// 限制剪切板历史的最大数量，删除超出部分的记录
fn enforce_max_items(app_data_dir: &PathBuf) -> Result<(), String> {
    // 获取设置中的最大数量
    let settings = settings::load_settings(app_data_dir)
        .unwrap_or_default();
    let max_items = settings.clipboard_max_items;
    
    if max_items == 0 {
        // 0 表示不限制
        return Ok(());
    }

    let conn = db::get_connection(app_data_dir)?;
    
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
    
    // 删除对应的图片文件
    for (id, content, content_type) in &items_to_delete {
        if content_type == "image" {
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
                if ref_count <= 1 {
                    if let Err(e) = std::fs::remove_file(image_path) {
                        eprintln!("[Clipboard] Failed to delete image file {}: {}", content, e);
                    } else {
                        println!("[Clipboard] Deleted image file: {}", content);
                    }
                }
            }
        }
    }
    
    // 删除数据库记录（逐个删除更安全）
    for (id, _, _) in &items_to_delete {
        conn.execute(
            "DELETE FROM clipboard_history WHERE id = ?1",
            params![id],
        )
        .map_err(|e| format!("Failed to delete clipboard item {}: {}", id, e))?;
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
    use std::time::Duration;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::DataExchange::{
        GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, CloseClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock, GlobalSize};
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Gdi::{
        GetDIBits, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };

    const CF_TEXT: u32 = 1;
    const CF_UNICODETEXT: u32 = 13;
    const CF_DIB: u32 = 8;
    const CF_BITMAP: u32 = 2;

    /// 启动剪切板监控线程
    pub fn start_clipboard_monitor(app_data_dir: PathBuf) -> Result<(), String> {
        thread::spawn(move || {
            let mut last_text_content = String::new();
            let mut last_image_hash = String::new();
            
            loop {
                thread::sleep(Duration::from_millis(500));
                
                // 检查文本内容
                if let Ok(content) = get_clipboard_text() {
                    if !content.is_empty() && content != last_text_content {
                        if let Err(e) = add_clipboard_item(content.clone(), "text".to_string(), &app_data_dir) {
                            eprintln!("[Clipboard Monitor] Failed to add text clipboard item: {}", e);
                        }
                        last_text_content = content;
                    }
                }
                
                // 检查图片内容
                if let Ok(image_path) = get_clipboard_image(&app_data_dir) {
                    if !image_path.is_empty() {
                        // 使用文件路径作为简单的哈希来检测重复
                        let image_hash = format!("{}", image_path);
                        if image_hash != last_image_hash {
                            if let Err(e) = add_clipboard_item(image_path.clone(), "image".to_string(), &app_data_dir) {
                                eprintln!("[Clipboard Monitor] Failed to add image clipboard item: {}", e);
                            }
                            last_image_hash = image_hash;
                        }
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

    /// 获取剪切板图片并保存到本地
    pub fn get_clipboard_image(app_data_dir: &PathBuf) -> Result<String, String> {
        unsafe {
            if OpenClipboard(0 as HWND) == 0 {
                return Err("Failed to open clipboard".to_string());
            }

            let result = if IsClipboardFormatAvailable(CF_DIB) != 0 {
                let h_data = GetClipboardData(CF_DIB);
                if h_data == 0 {
                    CloseClipboard();
                    return Err("Failed to get clipboard DIB data".to_string());
                }

                let p_data = GlobalLock(h_data as *mut std::ffi::c_void);
                if p_data.is_null() {
                    CloseClipboard();
                    return Err("Failed to lock clipboard data".to_string());
                }

                let data_size = GlobalSize(h_data as *mut std::ffi::c_void);
                if data_size == 0 {
                    GlobalUnlock(h_data as *mut std::ffi::c_void);
                    CloseClipboard();
                    return Err("Invalid clipboard data size".to_string());
                }

                // 读取 BITMAPINFOHEADER
                let bmi = p_data as *const BITMAPINFOHEADER;
                let width = (*bmi).biWidth;
                let height = (*bmi).biHeight.abs();
                let bit_count = (*bmi).biBitCount;

                // 创建保存目录
                let clipboard_images_dir = app_data_dir.join("clipboard_images");
                if let Err(e) = std::fs::create_dir_all(&clipboard_images_dir) {
                    GlobalUnlock(h_data as *mut std::ffi::c_void);
                    CloseClipboard();
                    return Err(format!("Failed to create clipboard images directory: {}", e));
                }

                // 计算图片数据大小
                let bytes_per_pixel = (bit_count / 8) as usize;
                let row_size = ((width * bit_count as i32 + 31) / 32 * 4) as usize;
                let image_data_size = row_size * height as usize;

                // 获取图片数据指针（跳过 BITMAPINFOHEADER）
                let image_data_ptr = (p_data as *const u8).add(std::mem::size_of::<BITMAPINFOHEADER>());
                let image_data = std::slice::from_raw_parts(image_data_ptr, image_data_size.min(data_size - std::mem::size_of::<BITMAPINFOHEADER>()));

                // 转换 BGR 到 RGB 并保存为 PNG
                let mut rgba_data = Vec::with_capacity((width * height * 4) as usize);
                for y in (0..height).rev() {
                    for x in 0..width {
                        let offset = (y as usize * row_size + x as usize * bytes_per_pixel) as usize;
                        if offset + bytes_per_pixel <= image_data.len() {
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

                // 计算图片内容的哈希值（用于去重）
                let mut hasher = Sha256::new();
                hasher.update(&rgba_data);
                let hash_result = hasher.finalize();
                let hash_str = format!("{:x}", hash_result);
                
                // 使用哈希值作为文件名（取前16个字符）
                let filename = format!("clipboard_{}.png", &hash_str[..16]);
                let file_path = clipboard_images_dir.join(&filename);

                // 如果文件已存在（说明是重复的图片），直接返回路径
                if file_path.exists() {
                    GlobalUnlock(h_data as *mut std::ffi::c_void);
                    CloseClipboard();
                    return Ok(file_path.to_string_lossy().to_string());
                }

                // 保存为 PNG
                let save_result = save_png(&file_path, &rgba_data, width as u32, height as u32);

                GlobalUnlock(h_data as *mut std::ffi::c_void);
                
                match save_result {
                    Ok(_) => Ok(file_path.to_string_lossy().to_string()),
                    Err(e) => Err(format!("Failed to save PNG: {}", e)),
                }
            } else {
                Err("No image in clipboard".to_string())
            };

            CloseClipboard();
            result
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
