//! 备忘录相关命令模块
//!
//! 提供备忘录的 CRUD 操作；磁盘 Markdown 为真相源。

use crate::memos;
use super::get_app_data_dir;
use tauri::AppHandle;

/// 获取所有备忘录
#[tauri::command]
pub fn get_all_memos(app: AppHandle) -> Result<Vec<memos::MemoItem>, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    memos::get_all_memos(&app_data_dir)
}

/// 添加备忘录
#[tauri::command]
pub fn add_memo(
    title: String,
    content: String,
    app: AppHandle,
) -> Result<memos::MemoItem, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    memos::add_memo(title, content, &app_data_dir)
}

/// 更新备忘录
#[tauri::command]
pub fn update_memo(
    id: String,
    title: Option<String>,
    content: Option<String>,
    app: AppHandle,
) -> Result<memos::MemoItem, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    memos::update_memo(id, title, content, &app_data_dir)
}

/// 删除备忘录
#[tauri::command]
pub fn delete_memo(id: String, app: AppHandle) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    memos::delete_memo(id, &app_data_dir)
}

/// 搜索备忘录
#[tauri::command]
pub fn search_memos(query: String, app: AppHandle) -> Result<Vec<memos::MemoItem>, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    memos::search_memos(&query, &app_data_dir)
}

/// 保存备忘录图片，返回相对路径 `images/xxx.ext`
#[tauri::command]
pub fn save_memo_image(
    image_data: Vec<u8>,
    extension: String,
    app: AppHandle,
) -> Result<String, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    memos::save_memo_image(image_data, extension, &app_data_dir)
}

/// 读取备忘录图片字节（相对路径或 memos 目录内绝对路径）
#[tauri::command]
pub async fn get_memo_image_data(image_path: String) -> Result<Vec<u8>, String> {
    tokio::task::spawn_blocking(move || memos::get_memo_image_data(image_path))
        .await
        .map_err(|e| format!("读取备忘录图片任务失败: {}", e))?
}

/// 返回备忘录根目录（Documents/ReFast/memos）
#[tauri::command]
pub fn get_memos_root_path() -> Result<String, String> {
    memos::memos_root()?
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "备忘录路径包含无效字符".to_string())
}
