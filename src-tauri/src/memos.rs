use crate::db;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
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

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn memos_json_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("memos.json")
}

/// 用户可见的备忘录根目录：Documents/ReFast/memos
pub fn memos_root() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法获取用户主目录".to_string())?;
    Ok(PathBuf::from(home)
        .join("Documents")
        .join("ReFast")
        .join("memos"))
}

pub(crate) fn memo_md_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{}.md", id))
}

pub(crate) fn memo_images_dir(root: &Path) -> PathBuf {
    root.join("images")
}

fn ensure_dirs(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| format!("创建备忘录目录失败: {}", e))?;
    fs::create_dir_all(memo_images_dir(root))
        .map_err(|e| format!("创建备忘录图片目录失败: {}", e))?;
    Ok(())
}

/// 解析 frontmatter + 正文（仅支持本应用写出的固定字段）
pub(crate) fn parse_memo_markdown(raw: &str) -> Result<MemoItem, String> {
    let raw = raw.trim_start_matches('\u{feff}');
    if !raw.starts_with("---") {
        return Err("缺少 YAML frontmatter".to_string());
    }
    let after_start = &raw[3..];
    let after_start = after_start.strip_prefix('\n').unwrap_or(after_start);
    let end = after_start
        .find("\n---")
        .ok_or_else(|| "frontmatter 未正确结束".to_string())?;
    let yaml = &after_start[..end];
    let body = after_start[end + 4..]
        .strip_prefix('\n')
        .unwrap_or(&after_start[end + 4..]);

    let mut id = String::new();
    let mut title = String::new();
    let mut created_at: u64 = 0;
    let mut updated_at: u64 = 0;

    for line in yaml.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        match key {
            "id" => id = parse_yaml_string(value),
            "title" => title = parse_yaml_string(value),
            "created_at" => {
                created_at = parse_yaml_string(value)
                    .parse()
                    .map_err(|_| format!("无效 created_at: {}", value))?;
            }
            "updated_at" => {
                updated_at = parse_yaml_string(value)
                    .parse()
                    .map_err(|_| format!("无效 updated_at: {}", value))?;
            }
            _ => {}
        }
    }

    if id.is_empty() {
        return Err("frontmatter 缺少 id".to_string());
    }

    Ok(MemoItem {
        id,
        title,
        content: body.to_string(),
        created_at,
        updated_at,
    })
}

fn parse_yaml_string(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        let inner = &value[1..value.len() - 1];
        return inner.replace("\\\"", "\"").replace("\\\\", "\\");
    }
    value.trim_matches('\'').to_string()
}

/// 转义 frontmatter 标题中的特殊字符（保持单行）
fn escape_title(title: &str) -> String {
    title.replace('\\', "\\\\").replace('"', "\\\"")
}

pub(crate) fn format_memo_markdown(item: &MemoItem) -> String {
    // 结束 --- 后只留一个换行，正文原样接上（避免解析时多出空行）
    format!(
        "---\nid: {}\ntitle: \"{}\"\ncreated_at: {}\nupdated_at: {}\n---\n{}",
        item.id,
        escape_title(&item.title),
        item.created_at,
        item.updated_at,
        item.content
    )
}

fn write_memo_file(root: &Path, item: &MemoItem) -> Result<(), String> {
    ensure_dirs(root)?;
    let path = memo_md_path(root, &item.id);
    let text = format_memo_markdown(item);
    fs::write(&path, text).map_err(|e| format!("写入备忘录文件失败: {}", e))?;
    Ok(())
}

fn read_memo_file(path: &Path) -> Result<MemoItem, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("读取备忘录失败: {}", e))?;
    parse_memo_markdown(&raw)
}

/// 从正文提取 `images/...` 相对路径
pub(crate) fn extract_image_refs(content: &str) -> Vec<String> {
    let mut refs = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("](images/") {
        let from = start + 2; // 从 images/ 开始
        if let Some(end_rel) = rest[from..].find(')') {
            let rel = &rest[from..from + end_rel];
            if rel.starts_with("images/") && !rel.contains("..") {
                refs.push(rel.to_string());
            }
            rest = &rest[from + end_rel + 1..];
        } else {
            break;
        }
    }
    refs
}

fn upsert_sqlite(conn: &rusqlite::Connection, item: &MemoItem) -> Result<(), String> {
    conn.execute(
        "INSERT INTO memos (id, title, content, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           content = excluded.content,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at",
        params![
            item.id,
            item.title,
            item.content,
            item.created_at as i64,
            item.updated_at as i64
        ],
    )
    .map_err(|e| format!("同步备忘录索引失败: {}", e))?;
    Ok(())
}

fn delete_sqlite(conn: &rusqlite::Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM memos WHERE id = ?1", params![id])
        .map_err(|e| format!("删除备忘录索引失败: {}", e))?;
    Ok(())
}

fn load_all_from_disk(root: &Path) -> Result<Vec<MemoItem>, String> {
    ensure_dirs(root)?;
    let mut items = Vec::new();
    let entries = fs::read_dir(root).map_err(|e| format!("读取备忘录目录失败: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        match read_memo_file(&path) {
            Ok(item) => items.push(item),
            Err(e) => {
                eprintln!("跳过无效备忘录 {}: {}", path.display(), e);
            }
        }
    }
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(items)
}

fn maybe_migrate_from_json(
    conn: &rusqlite::Connection,
    app_data_dir: &Path,
) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM memos", [], |row| row.get(0))
        .map_err(|e| format!("Failed to count memos: {}", e))?;

    if count == 0 {
        let path = memos_json_path(app_data_dir);
        if path.exists() {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(items) = serde_json::from_str::<Vec<MemoItem>>(&content) {
                    for m in items {
                        upsert_sqlite(conn, &m)?;
                    }
                }
            }
        }
    }
    Ok(())
}

/// 收集 SQLite 中尚无对应 .md 的记录（不写盘，避免持锁做 IO）
fn collect_sqlite_memos_missing_files(
    conn: &rusqlite::Connection,
    root: &Path,
) -> Result<Vec<MemoItem>, String> {
    let mut stmt = conn
        .prepare("SELECT id, title, content, created_at, updated_at FROM memos")
        .map_err(|e| format!("Failed to prepare memos export: {}", e))?;
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
        .map_err(|e| format!("Failed to iterate memos export: {}", e))?;

    let mut pending = Vec::new();
    for row in rows {
        let item = row.map_err(|e| format!("Failed to read memo row: {}", e))?;
        if !memo_md_path(root, &item.id).exists() {
            pending.push(item);
        }
    }
    Ok(pending)
}

fn ensure_store(app_data_dir: &Path) -> Result<PathBuf, String> {
    let root = memos_root()?;
    ensure_dirs(&root)?;
    // 先完成 DB 迁移/查询并释放 SHARED_CONNECTION，再写文件
    let pending = {
        let conn = db::get_connection(app_data_dir)?;
        maybe_migrate_from_json(&conn, app_data_dir)?;
        collect_sqlite_memos_missing_files(&conn, &root)?
    };
    for item in pending {
        write_memo_file(&root, &item)?;
    }
    Ok(root)
}

pub fn get_all_memos(app_data_dir: &PathBuf) -> Result<Vec<MemoItem>, String> {
    let root = ensure_store(app_data_dir)?;
    load_all_from_disk(&root)
}

pub fn add_memo(
    title: String,
    content: String,
    app_data_dir: &PathBuf,
) -> Result<MemoItem, String> {
    let root = ensure_store(app_data_dir)?;
    let now = now_ts();
    let id = format!("memo-{}", now_nanos());

    let item = MemoItem {
        id,
        title,
        content,
        created_at: now,
        updated_at: now,
    };

    write_memo_file(&root, &item)?;
    {
        let conn = db::get_connection(app_data_dir)?;
        upsert_sqlite(&conn, &item)?;
    }
    Ok(item)
}

pub fn update_memo(
    id: String,
    title: Option<String>,
    content: Option<String>,
    app_data_dir: &PathBuf,
) -> Result<MemoItem, String> {
    let root = ensure_store(app_data_dir)?;
    let path = memo_md_path(&root, &id);
    if !path.exists() {
        return Err(format!("Memo {} not found", id));
    }

    let mut memo = read_memo_file(&path)?;
    let old_refs: HashSet<String> = extract_image_refs(&memo.content).into_iter().collect();

    if let Some(t) = title {
        memo.title = t;
    }
    if let Some(c) = content {
        memo.content = c;
    }
    memo.updated_at = now_ts();

    write_memo_file(&root, &memo)?;
    {
        let conn = db::get_connection(app_data_dir)?;
        upsert_sqlite(&conn, &memo)?;
    }

    // 清理更新后不再引用的图片（当前文件已是新正文，按全量引用判断）
    let new_refs: HashSet<String> = extract_image_refs(&memo.content).into_iter().collect();
    for rel in old_refs.difference(&new_refs) {
        try_delete_unused_image(&root, rel)?;
    }

    Ok(memo)
}

pub fn delete_memo(id: String, app_data_dir: &PathBuf) -> Result<(), String> {
    let root = ensure_store(app_data_dir)?;
    let path = memo_md_path(&root, &id);
    if !path.exists() {
        // 兼容仅有索引的情况
        let conn = db::get_connection(app_data_dir)?;
        let affected = conn
            .execute("DELETE FROM memos WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete memo: {}", e))?;
        if affected == 0 {
            return Err("Memo not found".to_string());
        }
        return Ok(());
    }

    let memo = read_memo_file(&path)?;
    let refs = extract_image_refs(&memo.content);
    fs::remove_file(&path).map_err(|e| format!("删除备忘录文件失败: {}", e))?;

    {
        let conn = db::get_connection(app_data_dir)?;
        delete_sqlite(&conn, &id)?;
    }

    for rel in refs {
        try_delete_unused_image(&root, &rel)?;
    }
    Ok(())
}

pub fn search_memos(query: &str, app_data_dir: &PathBuf) -> Result<Vec<MemoItem>, String> {
    let q = query.to_lowercase();
    let items = get_all_memos(app_data_dir)?;
    Ok(items
        .into_iter()
        .filter(|m| {
            m.title.to_lowercase().contains(&q) || m.content.to_lowercase().contains(&q)
        })
        .collect())
}

/// 保存图片到 memos/images，返回相对路径 `images/xxx.ext`
pub fn save_memo_image(
    image_data: Vec<u8>,
    extension: String,
    _app_data_dir: &PathBuf,
) -> Result<String, String> {
    let root = memos_root()?;
    ensure_dirs(&root)?;

    let ext = extension
        .trim()
        .trim_start_matches('.')
        .to_lowercase();
    let ext = if ext.is_empty() {
        "png".to_string()
    } else {
        ext
    };
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp") {
        return Err(format!("不支持的图片类型: {}", ext));
    }

    let filename = format!("{}.{}", now_nanos(), ext);
    let rel = format!("images/{}", filename);
    let abs = root.join(&rel);
    let mut file = fs::File::create(&abs).map_err(|e| format!("创建图片文件失败: {}", e))?;
    file.write_all(&image_data)
        .map_err(|e| format!("写入图片失败: {}", e))?;
    Ok(rel)
}

/// 读取备忘录图片：支持相对路径 `images/...` 或绝对路径
pub fn get_memo_image_data(image_path: String) -> Result<Vec<u8>, String> {
    let path = resolve_memo_image_path(&image_path)?;
    fs::read(&path).map_err(|e| format!("读取备忘录图片失败: {}", e))
}

pub(crate) fn resolve_memo_image_path(image_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(image_path);
    if path.is_absolute() {
        // 仅允许 memos 根目录下的文件
        let root = memos_root()?;
        let canon_root = root
            .canonicalize()
            .unwrap_or(root.clone());
        let canon = path
            .canonicalize()
            .map_err(|e| format!("无效图片路径: {}", e))?;
        if !canon.starts_with(&canon_root) {
            return Err("图片路径不在备忘录目录内".to_string());
        }
        return Ok(canon);
    }

    if !image_path.starts_with("images/") || image_path.contains("..") {
        return Err("非法的相对图片路径".to_string());
    }
    let root = memos_root()?;
    Ok(root.join(image_path))
}

fn try_delete_unused_image(root: &Path, rel: &str) -> Result<(), String> {
    if !rel.starts_with("images/") || rel.contains("..") {
        return Ok(());
    }
    // 若仍被其他备忘录引用则保留
    let items = load_all_from_disk(root)?;
    for item in &items {
        if extract_image_refs(&item.content).iter().any(|r| r == rel) {
            return Ok(());
        }
    }
    let abs = root.join(rel);
    if abs.exists() {
        let _ = fs::remove_file(abs);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_and_parse_roundtrip() {
        let item = MemoItem {
            id: "memo-1".into(),
            title: "标题 \"测试\"".into(),
            content: "你好\n\n![图](images/1.png)\n".into(),
            created_at: 100,
            updated_at: 200,
        };
        let md = format_memo_markdown(&item);
        let parsed = parse_memo_markdown(&md).expect("parse");
        assert_eq!(parsed.id, item.id);
        assert_eq!(parsed.title, item.title);
        assert_eq!(parsed.content, item.content);
        assert_eq!(parsed.created_at, 100);
        assert_eq!(parsed.updated_at, 200);
    }

    #[test]
    fn extract_image_refs_finds_relative() {
        let content = "a ![x](images/a.png) b ![](images/b.jpg) c ![bad](http://x) d";
        let refs = extract_image_refs(content);
        assert_eq!(refs, vec!["images/a.png", "images/b.jpg"]);
    }

    #[test]
    fn resolve_rejects_path_traversal() {
        let err = resolve_memo_image_path("images/../secret.png").unwrap_err();
        assert!(err.contains("非法"));
    }
}
