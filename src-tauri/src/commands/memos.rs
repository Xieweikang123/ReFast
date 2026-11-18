//! 备忘录相关命令模块
//!
//! 提供备忘录的 CRUD 操作；磁盘 Markdown 为真相源。
//! 慢路径（读盘 / SQLite / 写文件）一律 async + spawn_blocking，避免阻塞主线程。

use crate::memos;
use super::get_app_data_dir;
use tauri::AppHandle;

/// 获取所有备忘录
#[tauri::command]
pub async fn get_all_memos(app: AppHandle) -> Result<Vec<memos::MemoItem>, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    tokio::task::spawn_blocking(move || memos::get_all_memos(&app_data_dir))
        .await
        .map_err(|e| format!("加载备忘录任务失败: {}", e))?
}

/// 添加备忘录
#[tauri::command]
pub async fn add_memo(
    title: String,
    content: String,
    app: AppHandle,
) -> Result<memos::MemoItem, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    tokio::task::spawn_blocking(move || memos::add_memo(title, content, &app_data_dir))
        .await
        .map_err(|e| format!("添加备忘录任务失败: {}", e))?
}

/// 更新备忘录
#[tauri::command]
pub async fn update_memo(
    id: String,
    title: Option<String>,
    content: Option<String>,
    app: AppHandle,
) -> Result<memos::MemoItem, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    tokio::task::spawn_blocking(move || memos::update_memo(id, title, content, &app_data_dir))
        .await
        .map_err(|e| format!("更新备忘录任务失败: {}", e))?
}

/// 删除备忘录
#[tauri::command]
pub async fn delete_memo(id: String, app: AppHandle) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    tokio::task::spawn_blocking(move || memos::delete_memo(id, &app_data_dir))
        .await
        .map_err(|e| format!("删除备忘录任务失败: {}", e))?
}

/// 搜索备忘录
#[tauri::command]
pub async fn search_memos(
    query: String,
    app: AppHandle,
) -> Result<Vec<memos::MemoItem>, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    tokio::task::spawn_blocking(move || memos::search_memos(&query, &app_data_dir))
        .await
        .map_err(|e| format!("搜索备忘录任务失败: {}", e))?
}

/// 保存备忘录图片，返回相对路径 `images/xxx.ext`
#[tauri::command]
pub async fn save_memo_image(
    image_data: Vec<u8>,
    extension: String,
    app: AppHandle,
) -> Result<String, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        memos::save_memo_image(image_data, extension, &app_data_dir)
    })
    .await
    .map_err(|e| format!("保存备忘录图片任务失败: {}", e))?
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
