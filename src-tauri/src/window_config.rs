use crate::db;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const MARKDOWN_EDITOR_WINDOW_KEY: &str = "markdown-editor-window";

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
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
    save_window_config(app_data_dir, &configs)
}

pub fn get_launcher_position(app_data_dir: &Path) -> Option<WindowPosition> {
    load_window_config(app_data_dir)
        .ok()
        .and_then(|configs| configs.launcher.position)
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
    use super::{is_window_position_visible, MonitorRect};

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
}


