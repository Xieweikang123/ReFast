use crate::db;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Settings {
    pub ollama: OllamaSettings,
    #[serde(default)]
    pub startup_enabled: bool,
    #[serde(default)]
    pub hotkey: Option<HotkeyConfig>,
    #[serde(default)]
    pub app_center_hotkey: Option<HotkeyConfig>,
    #[serde(default)]
    pub plugin_hotkeys: HashMap<String, HotkeyConfig>,
    #[serde(default)]
    pub app_hotkeys: HashMap<String, HotkeyConfig>,
    #[serde(default = "default_close_on_blur")]
    pub close_on_blur: bool,
    #[serde(default = "default_result_style")]
    pub result_style: String,
    #[serde(default = "default_auto_check_update")]
    pub auto_check_update: bool,
    #[serde(default)]
    pub last_update_check_time: Option<i64>,
    #[serde(default)]
    pub ignored_update_version: Option<String>,
    #[serde(default = "default_clipboard_max_items")]
    pub clipboard_max_items: u32,
}

fn default_clipboard_max_items() -> u32 {
    100
}

fn default_result_style() -> String {
    "skeuomorphic".to_string()
}

fn default_close_on_blur() -> bool {
    true
}

fn default_auto_check_update() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ollama: OllamaSettings::default(),
            startup_enabled: false,
            hotkey: None,
            app_center_hotkey: None,
            plugin_hotkeys: HashMap::new(),
            app_hotkeys: HashMap::new(),
            close_on_blur: default_close_on_blur(),
            result_style: default_result_style(),
            auto_check_update: default_auto_check_update(),
            last_update_check_time: None,
            ignored_update_version: None,
            clipboard_max_items: default_clipboard_max_items(),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct HotkeyConfig {
    pub modifiers: Vec<String>,
    pub key: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OllamaSettings {
    pub model: String,
    pub base_url: String,
}

impl Default for OllamaSettings {
    fn default() -> Self {
        Self {
            model: "llama2".to_string(),
            base_url: "http://localhost:11434".to_string(),
        }
    }
}

pub fn get_settings_file_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("settings.json")
}

pub fn load_settings(app_data_dir: &Path) -> Result<Settings, String> {
    let conn = db::get_connection(app_data_dir)?;
    maybe_migrate_from_json(&conn, app_data_dir)?;

    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'settings' LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to load settings from database: {}", e))?;

    if let Some(json) = value {
        serde_json::from_str(&json)
            .map_err(|e| format!("Failed to parse settings from database: {}", e))
    } else {
        Ok(Settings::default())
    }
}

pub fn save_settings(app_data_dir: &Path, settings: &Settings) -> Result<(), String> {
    let conn = db::get_connection(app_data_dir)?;
    save_settings_with_conn(&conn, settings)
}

fn save_settings_with_conn(conn: &rusqlite::Connection, settings: &Settings) -> Result<(), String> {
    let settings_json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('settings', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![settings_json],
    )
    .map_err(|e| format!("Failed to save settings to database: {}", e))?;

    Ok(())
}

/// Import legacy JSON once if the database table is empty.
fn maybe_migrate_from_json(
    conn: &rusqlite::Connection,
    app_data_dir: &Path,
) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM settings", [], |row| row.get(0))
        .map_err(|e| format!("Failed to count settings rows: {}", e))?;

    if count == 0 {
        let settings_file = get_settings_file_path(app_data_dir);
        if settings_file.exists() {
            if let Ok(content) = fs::read_to_string(&settings_file) {
                if let Ok(settings) = serde_json::from_str::<Settings>(&content) {
                    // Best effort import; ignore errors to avoid blocking startup.
                    let _ = save_settings_with_conn(conn, &settings);
                }
            }
        }
    }

    Ok(())
}

