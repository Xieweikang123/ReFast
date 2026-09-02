use crate::db;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MARKDOWN_EDITOR_WINDOW_KEY: &str = "markdown-editor-window";

/// launcher 位置的进程内缓存。
/// ⚠️ 死锁修复（dump 实锤）：托盘/热键唤起路径每次调用 get_launcher_position 都会
/// 抢 SHARED_CONNECTION DB 锁；当锁被长时间持有时，唤起链整体悬挂。
/// 位置是低频写、高频读的数据 —— 读路径走缓存，彻底移出唤起热路径。
static LAUNCHER_POSITION_CACHE: Mutex<Option<Option<WindowPosition>>> = Mutex::new(None);

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct WindowPosition {
    pub x: i32,
    pub y: i32,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct WindowConfig {
    pub position: Option<WindowPosition>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct AllWindowConfigs {
    pub launcher: WindowConfig,
}

pub fn get_window_config_file_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("window_config.json")
}

pub fn load_window_config(app_data_dir: &Path) -> Result<AllWindowConfigs, String> {
    let conn = db::get_connection(app_data_dir)?;
    maybe_migrate_from_json(&conn, app_data_dir)?;

    let config: Option<(Option<i32>, Option<i32>)> = conn
        .query_row(
            "SELECT x, y FROM window_config WHERE key = 'launcher' LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("Failed to load window config: {}", e))?;

    if let Some((x, y)) = config {
        Ok(AllWindowConfigs {
            launcher: WindowConfig {
                position: match (x, y) {
                    (Some(x), Some(y)) => Some(WindowPosition { x, y }),
                    _ => None,
                },
            },
        })
    } else {
        Ok(AllWindowConfigs::default())
    }
}

pub fn save_window_config(
    app_data_dir: &Path,
    configs: &AllWindowConfigs,
) -> Result<(), String> {
    let conn = db::get_connection(app_data_dir)?;
    let (x, y) = configs
        .launcher
        .position
        .as_ref()
        .map(|p| (Some(p.x), Some(p.y)))
        .unwrap_or((None, None));

    conn.execute(
        "INSERT INTO window_config (key, x, y) VALUES ('launcher', ?1, ?2)
         ON CONFLICT(key) DO UPDATE SET x = excluded.x, y = excluded.y",
        params![x, y],
    )
    .map_err(|e| format!("Failed to save window config: {}", e))?;

    Ok(())
}

pub fn save_launcher_position(
    app_data_dir: &Path,
    x: i32,
    y: i32,
) -> Result<(), String> {
    let mut configs = load_window_config(app_data_dir).unwrap_or_default();
    configs.launcher.position = Some(WindowPosition { x, y });
    let result = save_window_config(app_data_dir, &configs);
    if result.is_ok() {
        // 写成功后同步缓存（读路径不再回源）
        if let Ok(mut cache) = LAUNCHER_POSITION_CACHE.lock() {
            *cache = Some(Some(WindowPosition { x, y }));
        }
    }
    result
}

pub fn get_launcher_position(app_data_dir: &Path) -> Option<WindowPosition> {
    // 快路径：缓存命中直接返回（不碰 DB 锁）
    if let Ok(cache) = LAUNCHER_POSITION_CACHE.lock() {
        if let Some(ref cached) = *cache {
            return cached.clone();
        }
    }

    // 慢路径：读 DB 并填充缓存
    let loaded = load_window_config(app_data_dir)
        .ok()
        .and_then(|configs| configs.launcher.position);
    if let Ok(mut cache) = LAUNCHER_POSITION_CACHE.lock() {
        *cache = Some(loaded.clone());
    }
    loaded
}

#[derive(Debug, Clone, Default)]
pub struct WindowGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
    pub fullscreen: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct MonitorRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 判断窗口左上角是否仍落在任一显示器上（允许略微超出）
pub(crate) fn is_window_position_visible(x: i32, y: i32, monitors: &[MonitorRect]) -> bool {
    monitors.iter().any(|monitor| {
        let left = monitor.x;
        let top = monitor.y;
        let right = left + monitor.width as i32;
        let bottom = top + monitor.height as i32;
        x < right - 80 && x + 80 > left && y < bottom - 40 && y + 40 > top
    })
}

pub fn get_window_geometry(app_data_dir: &Path, key: &str) -> Option<WindowGeometry> {
    let conn = db::get_connection(app_data_dir).ok()?;
    conn.query_row(
        "SELECT x, y, width, height, maximized, fullscreen FROM window_config WHERE key = ?1 LIMIT 1",
        params![key],
        |row| {
            Ok(WindowGeometry {
                x: row.get::<_, Option<i32>>(0)?.unwrap_or(0),
                y: row.get::<_, Option<i32>>(1)?.unwrap_or(0),
                width: row.get::<_, Option<i32>>(2)?.unwrap_or(0).max(0) as u32,
                height: row.get::<_, Option<i32>>(3)?.unwrap_or(0).max(0) as u32,
                maximized: row.get::<_, Option<i32>>(4)?.unwrap_or(0) != 0,
                fullscreen: row.get::<_, Option<i32>>(5)?.unwrap_or(0) != 0,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
    .filter(|geo| {
        geo.maximized
            || geo.fullscreen
            || (geo.width > 0 && geo.height > 0)
    })
}

pub fn save_window_geometry(
    app_data_dir: &Path,
    key: &str,
    geometry: &WindowGeometry,
) -> Result<(), String> {
    let conn = db::get_connection(app_data_dir)?;
    conn.execute(
        "INSERT INTO window_config (key, x, y, width, height, maximized, fullscreen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(key) DO UPDATE SET
            x = excluded.x,
            y = excluded.y,
            width = excluded.width,
            height = excluded.height,
            maximized = excluded.maximized,
            fullscreen = excluded.fullscreen",
        params![
            key,
            geometry.x,
            geometry.y,
            geometry.width as i32,
            geometry.height as i32,
            if geometry.maximized { 1 } else { 0 },
            if geometry.fullscreen { 1 } else { 0 },
        ],
    )
    .map_err(|e| format!("Failed to save window geometry: {e}"))?;
    Ok(())
}

fn maybe_migrate_from_json(
    conn: &rusqlite::Connection,
    app_data_dir: &Path,
) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM window_config", [], |row| row.get(0))
        .map_err(|e| format!("Failed to count window_config rows: {}", e))?;

    if count == 0 {
        let json_path = get_window_config_file_path(app_data_dir);
        if json_path.exists() {
            if let Ok(content) = fs::read_to_string(&json_path) {
                if let Ok(cfg) = serde_json::from_str::<AllWindowConfigs>(&content) {
                    let _ = save_window_config(app_data_dir, &cfg);
                }
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_window_position_visible, MonitorRect, WindowPosition};
    use super::{
        get_launcher_position, save_launcher_position, LAUNCHER_POSITION_CACHE,
    };

    fn primary() -> MonitorRect {
        MonitorRect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        }
    }

    #[test]
    fn visible_on_primary_monitor() {
        assert!(is_window_position_visible(100, 80, &[primary()]));
    }

    #[test]
    fn hidden_when_off_all_monitors() {
        assert!(!is_window_position_visible(-800, -600, &[primary()]));
        assert!(!is_window_position_visible(4000, 80, &[primary()]));
    }

    #[test]
    fn visible_on_secondary_monitor() {
        let secondary = MonitorRect {
            x: 1920,
            y: 0,
            width: 1440,
            height: 900,
        };
        assert!(is_window_position_visible(2000, 40, &[primary(), secondary]));
    }

    // ===== launcher 位置缓存回归（死锁修复：唤起路径零 DB 访问） =====
    // ⚠️ LAUNCHER_POSITION_CACHE 是进程级单例，缓存相关测试必须与
    // db 测试一样避免并行互相污染：通过下方串行锁 + 每测前后 reset 保证。

    /// 生成唯一的临时目录
    fn test_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "refast-wincfg-test-{}-{}-{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 缓存相关测试的串行锁（缓存是全局单例，并行测试会互相污染）


    /// 清空位置缓存（测试间隔离；缓存是进程级单例）
    fn reset_position_cache() {
        *LAUNCHER_POSITION_CACHE.lock().unwrap() = None;
    }

    /// 回归：save 后 get 应立即命中缓存返回新位置（唤起路径不回源 DB）
    #[test]
    fn save_then_get_uses_cache() {
        let _serial = crate::db::test_global_serial_lock();
        reset_position_cache();
        let dir = test_dir("cache_roundtrip");

        save_launcher_position(&dir, 123, 456).expect("保存应成功");
        let pos = get_launcher_position(&dir);
        assert_eq!(pos, Some(WindowPosition { x: 123, y: 456 }));
    }

    /// 核心回归（死锁场景模拟）：缓存预热后，即使 DB 锁被占死，
    /// get_launcher_position 也必须成功返回 —— 这是唤起链零 DB 依赖的保证。
    #[test]
    fn cache_hit_avoids_db_when_db_locked() {
        let _serial = crate::db::test_global_serial_lock();
        reset_position_cache();
        let dir = test_dir("cache_no_db");

        // 预热缓存
        save_launcher_position(&dir, 77, 88).expect("保存应成功");

        // 占死 SHARED_CONNECTION（模拟持锁者卡住）
        let held = crate::db::test_lock_shared_connection();

        // 缓存命中路径不应触碰 DB 锁 → 不超时不阻塞，立即返回
        let start = std::time::Instant::now();
        let pos = get_launcher_position(&dir);
        let elapsed = start.elapsed();

        assert_eq!(pos, Some(WindowPosition { x: 77, y: 88 }));
        assert!(
            elapsed < std::time::Duration::from_millis(100),
            "缓存命中应即时返回（实际 {:?}），若接近 3s 说明回源了 DB（锁死风险回归）",
            elapsed
        );
        drop(held);
        reset_position_cache();
    }

    /// 回归：缓存未命中且 DB 可用时，从 DB 加载并填充缓存
    #[test]
    fn cache_miss_loads_from_db() {
        let _serial = crate::db::test_global_serial_lock();
        reset_position_cache();
        let dir = test_dir("cache_miss");

        // 直接写 DB（绕过缓存）
        {
            let conn = crate::db::get_connection(&dir).expect("DB 应可用");
            conn.execute(
                "INSERT OR REPLACE INTO window_config (key, x, y) VALUES ('launcher', 10, 20)",
                [],
            )
            .expect("写入应成功");
        }

        // 缓存空 → 应回源加载
        let pos = get_launcher_position(&dir);
        assert_eq!(pos, Some(WindowPosition { x: 10, y: 20 }));

        // 再清空缓存 + 删除 DB 记录 → 应返回 None（不残留旧缓存）
        reset_position_cache();
        {
            let conn = crate::db::get_connection(&dir).unwrap();
            conn.execute("DELETE FROM window_config WHERE key = 'launcher'", [])
                .unwrap();
        }
        assert_eq!(
            get_launcher_position(&dir),
            None,
            "DB 无记录且缓存为空时应返回 None"
        );
        reset_position_cache();
    }

    /// 回归：全新 DB（无任何记录）首次读取返回 None 且不 panic
    #[test]
    fn fresh_db_returns_none() {
        let _serial = crate::db::test_global_serial_lock();
        reset_position_cache();
        let dir = test_dir("fresh");
        assert_eq!(get_launcher_position(&dir), None);
        reset_position_cache();
    }
}




