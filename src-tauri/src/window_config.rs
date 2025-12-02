use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

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
    let config_file = get_window_config_file_path(app_data_dir);

    if !config_file.exists() {
        return Ok(AllWindowConfigs::default()); // No config file, return defaults
    }

    let content = fs::read_to_string(&config_file)
        .map_err(|e| format!("Failed to read window config file: {}", e))?;

    let configs: AllWindowConfigs = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse window config file: {}", e))?;

    Ok(configs)
}

pub fn save_window_config(
    app_data_dir: &Path,
    configs: &AllWindowConfigs,
) -> Result<(), String> {
    // Create directory if it doesn't exist
    if !app_data_dir.exists() {
        fs::create_dir_all(app_data_dir)
            .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    }

    let config_file = get_window_config_file_path(app_data_dir);

    let config_json = serde_json::to_string_pretty(configs)
        .map_err(|e| format!("Failed to serialize window config: {}", e))?;

    fs::write(&config_file, config_json)
        .map_err(|e| format!("Failed to write window config file: {}", e))?;

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
