use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct Settings {
    pub ollama: OllamaSettings,
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
    let settings_file = get_settings_file_path(app_data_dir);

    if !settings_file.exists() {
        return Ok(Settings::default()); // No settings file, return defaults
    }

    let content = fs::read_to_string(&settings_file)
        .map_err(|e| format!("Failed to read settings file: {}", e))?;

    let settings: Settings = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse settings file: {}", e))?;

    Ok(settings)
}

pub fn save_settings(app_data_dir: &Path, settings: &Settings) -> Result<(), String> {
    // Create directory if it doesn't exist
    if !app_data_dir.exists() {
        fs::create_dir_all(app_data_dir)
            .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    }

    let settings_file = get_settings_file_path(app_data_dir);

    let settings_json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    fs::write(&settings_file, settings_json)
        .map_err(|e| format!("Failed to write settings file: {}", e))?;

    Ok(())
}

