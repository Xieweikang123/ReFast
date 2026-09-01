use crate::db;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoItem {
    pub id: String,
    pub title: String,
    pub content: String,
    pub created_at: u64,
    pub updated_at: u64,
}

fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn memos_file_path(app_data_dir: &PathBuf) -> PathBuf {
    app_data_dir.join("memos.json")
}

pub fn get_all_memos(app_data_dir: &PathBuf) -> Result<Vec<MemoItem>, String> {
    let mut conn = db::get_connection(app_data_dir)?;
    maybe_migrate_from_json(&mut conn, app_data_dir)?;

    let mut stmt = conn
        .prepare("SELECT id, title, content, created_at, updated_at FROM memos ORDER BY updated_at DESC")
        .map_err(|e| format!("Failed to prepare memos query: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(MemoItem {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                created_at: row.get::<_, i64>(3)? as u64,
                updated_at: row.get::<_, i64>(4)? as u64,
            })
        })
        .map_err(|e| format!("Failed to iterate memos: {}", e))?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|e| format!("Failed to read memo row: {}", e))?);
    }
    Ok(items)
}

pub fn add_memo(
    title: String,
    content: String,
    app_data_dir: &PathBuf,
) -> Result<MemoItem, String> {
    let now = now_ts();
    let id = format!("memo-{}", now_ts());

    let item = MemoItem {
        id,
        title,
        content,
        created_at: now,
        updated_at: now,
    };

    let mut conn = db::get_connection(app_data_dir)?;
    maybe_migrate_from_json(&mut conn, app_data_dir)?;
    conn.execute(
        "INSERT INTO memos (id, title, content, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![item.id, item.title, item.content, item.created_at as i64, item.updated_at as i64],
    )
    .map_err(|e| format!("Failed to insert memo: {}", e))?;

    Ok(item)
}

pub fn update_memo(
    id: String,
    title: Option<String>,
    content: Option<String>,
    app_data_dir: &PathBuf,
) -> Result<MemoItem, String> {
    let mut conn = db::get_connection(app_data_dir)?;
    maybe_migrate_from_json(&mut conn, app_data_dir)?;

    let existing: Option<MemoItem> = conn
        .query_row(
            "SELECT id, title, content, created_at, updated_at FROM memos WHERE id = ?1",
            params![id],
            |row| {
                Ok(MemoItem {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    created_at: row.get::<_, i64>(3)? as u64,
                    updated_at: row.get::<_, i64>(4)? as u64,
                })
            },
        )
        .optional()
        .map_err(|e| format!("Failed to load memo: {}", e))?;

    let mut memo = existing.ok_or_else(|| format!("Memo {} not found", id))?;
    if let Some(t) = title {
        memo.title = t;
    }
    if let Some(c) = content {
        memo.content = c;
    }
    memo.updated_at = now_ts();

    conn.execute(
        "UPDATE memos SET title = ?1, content = ?2, updated_at = ?3 WHERE id = ?4",
        params![memo.title, memo.content, memo.updated_at as i64, memo.id],
    )
    .map_err(|e| format!("Failed to update memo: {}", e))?;

    Ok(memo)
}

pub fn delete_memo(id: String, app_data_dir: &PathBuf) -> Result<(), String> {
    let mut conn = db::get_connection(app_data_dir)?;
    maybe_migrate_from_json(&mut conn, app_data_dir)?;
    let affected = conn
        .execute("DELETE FROM memos WHERE id = ?1", params![id])
        .map_err(|e| format!("Failed to delete memo: {}", e))?;
    if affected == 0 {
        return Err("Memo not found".to_string());
    }
    Ok(())
}

pub fn search_memos(query: &str, app_data_dir: &PathBuf) -> Result<Vec<MemoItem>, String> {
    let mut conn = db::get_connection(app_data_dir)?;
    maybe_migrate_from_json(&mut conn, app_data_dir)?;

    let like = format!("%{}%", query.to_lowercase());
    let mut stmt = conn
        .prepare(
            "SELECT id, title, content, created_at, updated_at
             FROM memos
             WHERE lower(title) LIKE ?1 OR lower(content) LIKE ?1
             ORDER BY updated_at DESC",
        )
        .map_err(|e| format!("Failed to prepare memo search: {}", e))?;

    let rows = stmt
        .query_map(params![like], |row| {
            Ok(MemoItem {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                created_at: row.get::<_, i64>(3)? as u64,
                updated_at: row.get::<_, i64>(4)? as u64,
            })
        })
        .map_err(|e| format!("Failed to iterate memo search: {}", e))?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|e| format!("Failed to read memo row: {}", e))?);
    }
    Ok(items)
}

fn maybe_migrate_from_json(
    conn: &mut rusqlite::Connection,
    app_data_dir: &PathBuf,
) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM memos", [], |row| row.get(0))
        .map_err(|e| format!("Failed to count memos: {}", e))?;

    if count == 0 {
        let path = memos_file_path(app_data_dir);
        if path.exists() {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(items) = serde_json::from_str::<Vec<MemoItem>>(&content) {
                    let tx = conn
                        .transaction()
                        .map_err(|e| format!("Failed to start memo migration: {}", e))?;
                    tx.execute("DELETE FROM memos", [])
                        .map_err(|e| format!("Failed to clear memos table: {}", e))?;
                    for m in items {
                        tx.execute(
                            "INSERT INTO memos (id, title, content, created_at, updated_at)
                             VALUES (?1, ?2, ?3, ?4, ?5)",
                            params![
                                m.id,
                                m.title,
                                m.content,
                                m.created_at as i64,
                                m.updated_at as i64
                            ],
                        )
                        .map_err(|e| format!("Failed to migrate memo {}: {}", m.id, e))?;
                    }
                    let _ = tx.commit();
                }
            }
        }
    }
    Ok(())
}