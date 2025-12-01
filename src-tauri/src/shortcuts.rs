use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ShortcutItem {
    pub id: String,
    pub name: String,
    pub path: String,
    pub icon: Option<String>, // Optional icon path or base64 data
    pub created_at: u64, // Unix timestamp
    pub updated_at: u64, // Unix timestamp
}

static SHORTCUTS: LazyLock<Arc<Mutex<HashMap<String, ShortcutItem>>>> =
    LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

pub fn get_shortcuts_file_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("shortcuts.json")
}

pub fn load_shortcuts(app_data_dir: &Path) -> Result<(), String> {
    let shortcuts_file = get_shortcuts_file_path(app_data_dir);
    
    if !shortcuts_file.exists() {
        return Ok(()); // No shortcuts file, start fresh
    }

    let content = fs::read_to_string(&shortcuts_file)
        .map_err(|e| format!("Failed to read shortcuts file: {}", e))?;

    let shortcuts: HashMap<String, ShortcutItem> = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse shortcuts file: {}", e))?;

    let mut state = SHORTCUTS.lock().map_err(|e| e.to_string())?;
    *state = shortcuts;

    Ok(())
}

pub fn save_shortcuts(app_data_dir: &Path) -> Result<(), String> {
    // Create directory if it doesn't exist
    if !app_data_dir.exists() {
        fs::create_dir_all(app_data_dir)
            .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    }

    let shortcuts_file = get_shortcuts_file_path(app_data_dir);
    
    let state = SHORTCUTS.lock().map_err(|e| e.to_string())?;
    let shortcuts_json = serde_json::to_string_pretty(&*state)
        .map_err(|e| format!("Failed to serialize shortcuts: {}", e))?;

    fs::write(&shortcuts_file, shortcuts_json)
        .map_err(|e| format!("Failed to write shortcuts file: {}", e))?;

    Ok(())
}

pub fn get_all_shortcuts() -> Vec<ShortcutItem> {
    let state = SHORTCUTS.lock().unwrap();
    state.values().cloned().collect()
}

pub fn add_shortcut(
    name: String,
    path: String,
    icon: Option<String>,
    app_data_dir: &Path,
) -> Result<ShortcutItem, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to get timestamp: {}", e))?
        .as_secs();

    // Generate ID from name and timestamp
    let id = format!("{}_{}", name.replace(" ", "_"), timestamp);

    let shortcut = ShortcutItem {
        id: id.clone(),
        name,
        path,
        icon,
        created_at: timestamp,
        updated_at: timestamp,
    };

    let mut state = SHORTCUTS.lock().map_err(|e| e.to_string())?;
    state.insert(id.clone(), shortcut.clone());
    drop(state);

    save_shortcuts(app_data_dir)?;

    Ok(shortcut)
}

pub fn update_shortcut(
    id: String,
    name: Option<String>,
    path: Option<String>,
    icon: Option<String>,
    app_data_dir: &Path,
) -> Result<ShortcutItem, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to get timestamp: {}", e))?
        .as_secs();

    let mut state = SHORTCUTS.lock().map_err(|e| e.to_string())?;
    
    let shortcut = state.get_mut(&id)
        .ok_or_else(|| format!("Shortcut not found: {}", id))?;

    if let Some(name) = name {
        shortcut.name = name;
    }
    if let Some(path) = path {
        shortcut.path = path;
    }
    if let Some(icon) = icon {
        shortcut.icon = Some(icon);
    }
    shortcut.updated_at = timestamp;

    let shortcut_clone = shortcut.clone();
    drop(state);

    save_shortcuts(app_data_dir)?;

    Ok(shortcut_clone)
}

pub fn delete_shortcut(id: String, app_data_dir: &Path) -> Result<(), String> {
    let mut state = SHORTCUTS.lock().map_err(|e| e.to_string())?;
    
    state.remove(&id)
        .ok_or_else(|| format!("Shortcut not found: {}", id))?;
    
    drop(state);

    save_shortcuts(app_data_dir)?;

    Ok(())
}

