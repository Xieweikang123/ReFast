use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AppInfo {
    pub name: String,
    pub path: String,
    pub icon: Option<String>,
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_pinyin: Option<String>, // Cached pinyin for faster search
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_pinyin_initials: Option<String>, // Cached pinyin initials for faster search
}

#[cfg(target_os = "windows")]
pub mod windows {
    use super::*;
    use base64::Engine;
    use pinyin::ToPinyin;
    use std::env;
    use std::io::Write;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::process::CommandExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    // #region agent log helper
    fn agent_log(hypothesis_id: &str, location: &str, message: &str, data: serde_json::Value) {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let payload = serde_json::json!({
            "sessionId": "debug-session",
            "runId": "run1",
            "hypothesisId": hypothesis_id,
            "location": location,
            "message": message,
            "data": data,
            "timestamp": timestamp
        });
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open("d:\\project\\re-fast\\.cursor\\debug.log")
        {
            let _ = writeln!(file, "{}", payload.to_string());
        }
    }
    // #endregion agent log helper
    
    // Icon extraction failure marker
    // Use a special marker string to indicate that icon extraction was attempted but failed
    // This prevents repeated extraction attempts for files that consistently fail
    pub const ICON_EXTRACTION_FAILED_MARKER: &str = "__ICON_EXTRACTION_FAILED__";
    
    // Check if an icon value represents a failed extraction
    pub fn is_icon_extraction_failed(icon: &Option<String>) -> bool {
        icon.as_ref().map(|s| s == ICON_EXTRACTION_FAILED_MARKER).unwrap_or(false)
    }
    
    // Check if an icon needs extraction (not present and not marked as failed)
    pub fn needs_icon_extraction(icon: &Option<String>) -> bool {
        match icon {
            None => true,  // No icon, needs extraction
            Some(s) if s == ICON_EXTRACTION_FAILED_MARKER => false,  // Already marked as failed, skip
            Some(_) => false,  // Has valid icon, no extraction needed
        }
    }
    
    // Cache file name
    pub fn get_cache_file_path(app_data_dir: &Path) -> PathBuf {
        app_data_dir.join("app_cache.json")
    }

    // Constants
    const MAX_SEARCH_RESULTS: usize = 20;
    const MAX_PERFECT_MATCHES: usize = 3;
    const ICON_SIZE: u32 = 32;
    const MAX_SCAN_DEPTH: usize = 3;
    const MAX_APPS: usize = 2000;
    const WINDOWSAPPS_PATH: &str = "windowsapps";
    const RECENT_PATH: &str = "recent";

    // Helper function to check if a path is a WindowsApps path
    fn is_windowsapps_path(path: &str) -> bool {
        path.to_lowercase().contains(WINDOWSAPPS_PATH)
    }

    // Helper function to check if a path is a Recent directory path
    fn is_recent_path(path: &str) -> bool {
        let path_lower = path.to_lowercase();
        path_lower.contains("\\recent") || path_lower.contains("/recent")
    }

    // Helper function to filter out WindowsApps paths from app list
    fn filter_windowsapps_paths(apps: &mut Vec<AppInfo>) {
        apps.retain(|app| !is_windowsapps_path(&app.path));
    }

    // Helper function to normalize path for comparison
    fn normalize_path(path: &str) -> String {
        path.to_lowercase().replace('\\', "/")
    }

    // Helper function to get app priority for sorting
    fn app_priority(app: &AppInfo) -> u8 {
        let path = app.path.to_lowercase();
        if path.ends_with(".exe") {
            0
        } else if path.ends_with(".lnk") {
            1
        } else if path.starts_with("shell:appsfolder") {
            3
        } else {
            2
        }
    }

    // Helper function to get Settings app priority for sorting
    fn settings_app_priority(path: &str) -> u8 {
        if path.starts_with("shell:AppsFolder") {
            0
        } else if path.starts_with("ms-settings:") {
            1
        } else {
            2
        }
    }

    // Helper function to get Calculator app priority for sorting
    fn calculator_app_priority(path: &str) -> u8 {
        if path.starts_with("shell:AppsFolder") {
            0
        } else {
            1
        }
    }

    // Check if a .lnk file points to an existing .exe based on path matching
    fn lnk_points_to_existing_exe(lnk_path: &str, lnk_name: &str, seen_exe_paths: &std::collections::HashSet<String>) -> bool {
        let lnk_normalized = normalize_path(lnk_path);
        let name_lower = lnk_name.to_lowercase();
        
        seen_exe_paths.iter().any(|exe_path| {
            // Method 1: Extract directory structure from .lnk path and match with .exe path
            if let Some(programs_idx) = lnk_normalized.find("/programs/") {
                let after_programs = &lnk_normalized[programs_idx + "/programs/".len()..];
                let product_part = after_programs.trim_end_matches(".lnk");
                
                // Extract company name (first directory after programs/)
                if let Some(slash_idx) = product_part.find('/') {
                    let company_dir = &product_part[..slash_idx];
                    let product_name = &product_part[slash_idx + 1..];
                    
                    if exe_path.contains(company_dir) && exe_path.contains(product_name) {
                        return true;
                    }
                } else {
                    // Single-level: the product_part is the company/product name
                    if exe_path.contains(product_part) && exe_path.contains(&name_lower) {
                        return true;
                    }
                }
            }
            
            // Method 2: Simple check - if .lnk name (lowercase) appears in .exe path
            let name_words: Vec<&str> = name_lower.split_whitespace().collect();
            if name_words.len() > 1 {
                let significant_words: Vec<&str> = name_words.iter()
                    .filter(|w| w.len() > 2)
                    .copied()
                    .collect();
                if !significant_words.is_empty() {
                    let all_words_match = significant_words.iter().all(|word| exe_path.contains(word));
                    // Check for common directory patterns
                    let has_common_dir = exe_path.contains("premiumsoft") || exe_path.contains("navicat");
                    if all_words_match && has_common_dir {
                        return true;
                    }
                }
            }
            
            false
        })
    }

    // Deduplicate apps by path and name, with special handling for Settings and Calculator
    fn deduplicate_apps(mut apps: Vec<AppInfo>) -> Vec<AppInfo> {
        // Remove duplicates based on path (more accurate than name)
        apps.sort_by(|a, b| {
            let a_is_ms_settings = a.path.starts_with("ms-settings:");
            let b_is_ms_settings = b.path.starts_with("ms-settings:");
            if a_is_ms_settings && !b_is_ms_settings {
                std::cmp::Ordering::Greater
            } else if !a_is_ms_settings && b_is_ms_settings {
                std::cmp::Ordering::Less
            } else {
                a.path.cmp(&b.path)
            }
        });
        apps.dedup_by(|a, b| {
            if a.path == b.path {
                return true;
            }
            // If both are Settings apps, keep shell:AppsFolder and remove ms-settings:
            if a.name == "设置" && b.name == "设置" {
                if a.path.starts_with("shell:AppsFolder") && b.path.starts_with("ms-settings:") {
                    return true;
                }
                if b.path.starts_with("shell:AppsFolder") && a.path.starts_with("ms-settings:") {
                    return true;
                }
            }
            false
        });

        // Sort by name and priority
        apps.sort_by(|a, b| {
            let name_cmp = a.name.cmp(&b.name);
            if name_cmp != std::cmp::Ordering::Equal {
                return name_cmp;
            }
            let priority_cmp = app_priority(a).cmp(&app_priority(b));
            if priority_cmp != std::cmp::Ordering::Equal {
                return priority_cmp;
            }
            a.path.len().cmp(&b.path.len())
        });
        
        // Deduplicate by name and target path
        let mut deduplicated = Vec::new();
        let mut seen_names = std::collections::HashSet::new();
        let mut seen_target_paths = std::collections::HashSet::new();
        let mut settings_apps: Vec<AppInfo> = Vec::new();
        let mut calculator_apps: Vec<AppInfo> = Vec::new();
        
        for app in apps {
            let name_lower = app.name.to_lowercase();
            
            // Special handling for Settings and Calculator apps
            // Use cached lowercase name to avoid repeated comparisons
            let is_settings = name_lower == "设置" || name_lower == "settings" || 
                             name_lower.contains("设置") || name_lower.contains("settings");
            let is_calculator = name_lower == "计算器" || name_lower == "calculator" ||
                                name_lower.contains("计算器") || name_lower.contains("calculator");
            
            if is_settings {
                settings_apps.push(app);
            } else if is_calculator {
                calculator_apps.push(app);
            } else {
                // For other apps, check target path first
                let app_path_lower = app.path.to_lowercase();
                
                let target_path_to_check = if !app_path_lower.ends_with(".lnk") {
                    Some(normalize_path(&app.path))
                } else {
                    // For .lnk files, check if they point to an existing .exe
                    if lnk_points_to_existing_exe(&app.path, &app.name, &seen_target_paths) {
                        continue;
                    }
                    None
                };
                
                // Skip if target path already seen
                if let Some(ref target_path) = target_path_to_check {
                    if seen_target_paths.contains(target_path) {
                        continue;
                    }
                }
                
                // Skip if name already seen
                if seen_names.contains(&name_lower) {
                    continue;
                }
                
                // Add the app
                seen_names.insert(name_lower);
                if let Some(target_path) = target_path_to_check {
                    seen_target_paths.insert(target_path);
                }
                deduplicated.push(app);
            }
        }
        
        // Add Settings app(s) - prefer shell:AppsFolder, then ms-settings:
        if !settings_apps.is_empty() {
            settings_apps.sort_by(|a, b| {
                settings_app_priority(&a.path).cmp(&settings_app_priority(&b.path))
            });
            deduplicated.push(settings_apps[0].clone());
        } else {
            // Add builtin Settings app
            deduplicated.push(AppInfo {
                name: "设置".to_string(),
                path: "ms-settings:".to_string(),
                icon: None,
                description: Some("Windows 系统设置".to_string()),
                name_pinyin: Some("shezhi".to_string()),
                name_pinyin_initials: Some("sz".to_string()),
            });
        }
        
        // Add Calculator app(s) - prefer shell:AppsFolder
        if !calculator_apps.is_empty() {
            calculator_apps.sort_by(|a, b| {
                calculator_app_priority(&a.path).cmp(&calculator_app_priority(&b.path))
            });
            deduplicated.push(calculator_apps[0].clone());
        } else {
            // Add builtin Calculator app
            deduplicated.push(AppInfo {
                name: "计算器".to_string(),
                path: "shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App".to_string(),
                icon: None,
                description: Some("Windows 计算器".to_string()),
                name_pinyin: Some("jisuanqi".to_string()),
                name_pinyin_initials: Some("jsq".to_string()),
            });
        }
        
        // Final filter: remove any WindowsApps paths
        filter_windowsapps_paths(&mut deduplicated);
        
        deduplicated
    }

    // Load cached apps from disk
    pub fn load_cache(app_data_dir: &Path) -> Result<Vec<AppInfo>, String> {
        let cache_file = get_cache_file_path(app_data_dir);

        if !cache_file.exists() {
            return Ok(Vec::new());
        }

        let content = fs::read_to_string(&cache_file)
            .map_err(|e| format!("Failed to read cache file: {}", e))?;

        let mut apps: Vec<AppInfo> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse cache file: {}", e))?;

        // Filter out WindowsApps paths from cache (in case old cache contains them)
        filter_windowsapps_paths(&mut apps);

        Ok(apps)
    }

    // Save apps cache to disk
    pub fn save_cache(app_data_dir: &Path, apps: &[AppInfo]) -> Result<(), String> {
        // Create directory if it doesn't exist
        if !app_data_dir.exists() {
            fs::create_dir_all(app_data_dir)
                .map_err(|e| format!("Failed to create app data directory: {}", e))?;
        }

        // Filter out WindowsApps paths before saving (double check)
        let mut filtered_apps: Vec<AppInfo> = apps.to_vec();
        filter_windowsapps_paths(&mut filtered_apps);

        let cache_file = get_cache_file_path(app_data_dir);
        let json_string = serde_json::to_string_pretty(&filtered_apps)
            .map_err(|e| format!("Failed to serialize cache: {}", e))?;

        fs::write(&cache_file, json_string)
            .map_err(|e| format!("Failed to write cache file: {}", e))?;

        Ok(())
    }

    // Windows-specific implementation
    pub fn scan_start_menu(tx: Option<std::sync::mpsc::Sender<(u8, String)>>) -> Result<Vec<AppInfo>, String> {
        let scan_start_time = std::time::Instant::now();
        crate::log!("AppScan", "===== 开始扫描应用 =====");
        
        let mut apps = Vec::new();

        // Common start menu paths - scan user, local user, and system start menus
        // Many apps (like Cursor) install shortcuts in LOCALAPPDATA instead of APPDATA
        let start_menu_paths = vec![
            env::var("APPDATA")
                .ok()
                .map(|p| PathBuf::from(p).join("Microsoft/Windows/Start Menu/Programs")),
            env::var("LOCALAPPDATA")
                .ok()
                .map(|p| PathBuf::from(p).join("Microsoft/Windows/Start Menu/Programs")),
            env::var("PROGRAMDATA")
                .ok()
                .map(|p| PathBuf::from(p).join("Microsoft/Windows/Start Menu/Programs")),
            // Add Local AppData Programs folder (where apps like Trae, VS Code often install)
            env::var("LOCALAPPDATA")
                .ok()
                .map(|p| PathBuf::from(p).join("Programs")),
        ];

        // Desktop paths - scan user desktop and public desktop
        let desktop_paths = vec![
            env::var("USERPROFILE")
                .ok()
                .map(|p| PathBuf::from(p).join("Desktop")),
            env::var("PUBLIC")
                .ok()
                .map(|p| PathBuf::from(p).join("Desktop")),
        ];

        // 记录扫描路径
        let start_menu_paths_str: Vec<String> = start_menu_paths.iter().flatten().map(|p| p.to_string_lossy().to_string()).collect();
        let desktop_paths_str: Vec<String> = desktop_paths.iter().flatten().map(|p| p.to_string_lossy().to_string()).collect();
        crate::log!("AppScan", "扫描路径准备完成");
        crate::log!("AppScan", "  开始菜单路径: {:?}", start_menu_paths_str);
        crate::log!("AppScan", "  桌面路径: {:?}", desktop_paths_str);

        if let Some(ref tx) = tx {
            let _ = tx.send((5, "开始扫描应用...".to_string()));
        }

        // Scan start menu paths
        let start_menu_scan_start = std::time::Instant::now();
        let start_menu_count = start_menu_paths.len();
        for (idx, start_menu_path) in start_menu_paths.into_iter().flatten().enumerate() {
            if start_menu_path.exists() {
                let path_scan_start = std::time::Instant::now();
                let path_str = start_menu_path.to_string_lossy().to_string();
                let apps_before = apps.len();
                
                if let Some(ref tx) = tx {
                    let path_name = start_menu_path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("开始菜单")
                        .to_string();
                    let _ = tx.send((10 + (idx as u8 * 15), format!("正在扫描: {}", path_name)));
                }
                
                // Start scanning from depth 0, limit to 3 levels for better coverage
                if let Err(e) = scan_directory(&start_menu_path, &mut apps, 0) {
                    crate::log!("AppScan", "开始菜单扫描出错: {} - {}", path_str, e);
                } else {
                    let apps_found = apps.len() - apps_before;
                    let duration_ms = path_scan_start.elapsed().as_millis();
                    crate::log!("AppScan", "开始菜单扫描完成: {} - 找到 {} 个应用 (耗时 {}ms)", path_str, apps_found, duration_ms);
                }
            }
        }
        let start_menu_duration = start_menu_scan_start.elapsed();
        crate::log!("AppScan", "所有开始菜单扫描完成 - 共找到 {} 个应用 (总耗时 {}ms)", apps.len(), start_menu_duration.as_millis());

        // Scan desktop paths (only scan depth 0 for desktop, no recursion)
        let desktop_scan_start = std::time::Instant::now();
        if let Some(ref tx) = tx {
            let _ = tx.send((60, "正在扫描桌面...".to_string()));
        }
        let apps_before_desktop = apps.len();
        for desktop_path in desktop_paths.into_iter().flatten() {
            if desktop_path.exists() {
                if let Err(e) = scan_directory(&desktop_path, &mut apps, 0) {
                    crate::log!("AppScan", "桌面扫描出错: {} - {}", desktop_path.to_string_lossy(), e);
                }
            }
        }
        let desktop_apps_found = apps.len() - apps_before_desktop;
        let desktop_duration = desktop_scan_start.elapsed();
        crate::log!("AppScan", "桌面扫描完成 - 找到 {} 个应用 (耗时 {}ms)", desktop_apps_found, desktop_duration.as_millis());

        // Scan Microsoft Store / UWP apps via shell:AppsFolder enumeration
        let uwp_scan_start = std::time::Instant::now();
        if let Some(ref tx) = tx {
            let _ = tx.send((70, "正在扫描 Microsoft Store 应用...".to_string()));
        }
        crate::log!("AppScan", "开始扫描 UWP/Microsoft Store 应用...");
        
        match scan_uwp_apps() {
            Ok(mut uwp_apps) => {
                let uwp_count = uwp_apps.len();
                let uwp_duration = uwp_scan_start.elapsed();
                crate::log!("AppScan", "UWP 应用扫描成功 - 找到 {} 个应用 (耗时 {}ms)", uwp_count, uwp_duration.as_millis());
                apps.append(&mut uwp_apps);
            }
            Err(e) => {
                let uwp_duration = uwp_scan_start.elapsed();
                crate::log!("AppScan", "UWP 应用扫描失败 - {} (耗时 {}ms)", e, uwp_duration.as_millis());
            }
        }

        let apps_before_dedup = apps.len();
        if let Some(ref tx) = tx {
            let _ = tx.send((80, format!("找到 {} 个应用，正在去重...", apps.len())));
        }
        crate::log!("AppScan", "开始去重处理 - 原始应用数: {}", apps_before_dedup);
        
        let dedup_start = std::time::Instant::now();
        apps = deduplicate_apps(apps);
        let apps_after_dedup = apps.len();
        let dedup_duration = dedup_start.elapsed();
        let removed_count = apps_before_dedup - apps_after_dedup;
        crate::log!("AppScan", "去重处理完成 - 去重前: {} 个, 去重后: {} 个, 移除: {} 个 (耗时 {}ms)", 
            apps_before_dedup, apps_after_dedup, removed_count, dedup_duration.as_millis());
        
        if let Some(ref tx) = tx {
            let _ = tx.send((95, format!("去重完成，共 {} 个应用", apps.len())));
        }
        

        if let Some(ref tx) = tx {
            let _ = tx.send((100, "扫描完成".to_string()));
        }

        let total_duration = scan_start_time.elapsed();
        crate::log!("AppScan", "===== 扫描全部完成 - 最终应用数: {} 个, 总耗时: {}.{}s =====", 
            apps.len(), total_duration.as_secs(), total_duration.subsec_millis());

        Ok(apps)
    }

    /// 获取内置系统应用列表（确保关键系统应用始终可用）
    /// 这些应用会在 UWP 扫描之前添加，如果 UWP 扫描找到了同名应用，会在去重时保留 UWP 版本
    pub fn get_builtin_system_apps() -> Vec<AppInfo> {
        // 内置系统应用列表（当前为空，可根据需要添加）
        Vec::new()
    }

    /// 扫描特定路径并返回找到的应用
    /// 用于在搜索时实时发现新应用
    pub fn scan_specific_path(path: &Path) -> Result<Vec<AppInfo>, String> {
        // Skip WindowsApps directory
        let path_str = path.to_string_lossy();
        if is_windowsapps_path(&path_str) {
            return Ok(Vec::new());
        }

        let mut apps = Vec::new();
        if path.exists() {
            scan_directory(path, &mut apps, 0)?;
        }
        Ok(apps)
    }

    #[derive(Deserialize)]
    struct StartAppEntry {
        #[serde(rename = "Name")]
        name: String,
        #[serde(rename = "AppID")]
        app_id: String,
    }

    /// Enumerate Microsoft Store / UWP apps by directly enumerating shell:AppsFolder.
    /// This method finds ALL apps in shell:AppsFolder, not just those returned by Get-StartApps.
    /// Produces shell:AppsFolder targets so they can be launched via ShellExecute.
    fn scan_uwp_apps() -> Result<Vec<AppInfo>, String> {
        scan_uwp_apps_direct()
    }

    /// Public function for direct testing of UWP app scanning
    pub fn scan_uwp_apps_direct() -> Result<Vec<AppInfo>, String> {
        crate::log!("AppScan", "[UWP] 开始 UWP 应用扫描");
        fn decode_oem_bytes(bytes: &[u8]) -> Result<String, String> {
            if bytes.is_empty() {
                return Ok(String::new());
            }

            use ::windows::Win32::Foundation::GetLastError;
            use ::windows::Win32::Globalization::{MultiByteToWideChar, CP_OEMCP, MB_ERR_INVALID_CHARS};

            let wide_len = unsafe {
                MultiByteToWideChar(
                    CP_OEMCP,
                    MB_ERR_INVALID_CHARS,
                    bytes,
                    None,
                )
            };

            if wide_len == 0 {
                let err = unsafe { GetLastError().0 };
                return Err(format!(
                    "MultiByteToWideChar length failed for OEM bytes, error code: {}",
                    err
                ));
            }

            let mut wide_buf: Vec<u16> = vec![0; wide_len as usize];
            let converted = unsafe {
                MultiByteToWideChar(
                    CP_OEMCP,
                    MB_ERR_INVALID_CHARS,
                    bytes,
                    Some(&mut wide_buf),
                )
            };

            if converted == 0 {
                let err = unsafe { GetLastError().0 };
                return Err(format!(
                    "MultiByteToWideChar convert failed for OEM bytes, error code: {}",
                    err
                ));
            }

            wide_buf.truncate(converted as usize);
            String::from_utf16(&wide_buf)
                .map_err(|e| format!("Failed to build UTF-16 from OEM bytes: {}", e))
        }

        fn decode_powershell_output(bytes: &[u8]) -> Result<String, String> {
            if bytes.is_empty() {
                return Ok(String::new());
            }

            // 由于我们使用了 -OutputEncoding UTF8，优先尝试 UTF-8 解码
            match String::from_utf8(bytes.to_vec()) {
                Ok(s) => {
                    return Ok(s);
                }
                Err(_) => {
                    // UTF-8 解码失败，尝试其他编码
                }
            }
            
            // 回退方案1：尝试 UTF-16LE 解码（旧版 PowerShell 或未设置 OutputEncoding 的情况）
            if bytes.len() % 2 == 0 && bytes.len() >= 2 {
                let has_bom = bytes.starts_with(&[0xFF, 0xFE]);
                
                let data_start = if has_bom { 2 } else { 0 };
                let data_len = bytes.len() - data_start;
                let utf16_len = if data_len % 2 == 0 { data_len } else { data_len - 1 };
                
                if utf16_len >= 2 {
                    let mut utf16_units = Vec::with_capacity(utf16_len / 2);
                    for i in (0..utf16_len).step_by(2) {
                        let idx = data_start + i;
                        if idx + 1 < bytes.len() {
                            let low = bytes[idx];
                            let high = bytes[idx + 1];
                            utf16_units.push(u16::from_le_bytes([low, high]));
                        }
                    }

                    if let Ok(s) = String::from_utf16(&utf16_units) {
                        return Ok(s);
                    }
                }
            }

            // 回退方案2：尝试使用 OEM 代码页解码
            match decode_oem_bytes(bytes) {
                Ok(oem_str) => {
                    return Ok(oem_str);
                }
                Err(_) => {
                    // OEM 解码失败
                }
            }
            
            // 最后回退：使用 UTF-8 lossy 解码
            let lossy = String::from_utf8_lossy(bytes);
            Ok(lossy.to_string())
        }

        // PowerShell script: enumerate UWP apps using Get-StartApps
        // 受限语言模式下仅使用方法调用，不做任何属性赋值，输出 ASCII 形式的 B64JSON
        let script = r#"
        # 受限语言模式兼容：仅调用方法，不修改 OutputEncoding
        try {
            $apps = Get-StartApps | Where-Object { $_.AppId -and $_.Name }
        } catch {
            Write-Output "RAW:Get-StartApps failed"
            exit 0
        }

        if ($apps -eq $null -or $apps.Count -eq 0) {
            $emptyBytes = [System.Text.Encoding]::UTF8.GetBytes("[]")
            $emptyB64 = [System.Convert]::ToBase64String($emptyBytes)
            Write-Output ("B64JSON:" + $emptyB64)
            exit 0
        }

        $json = @($apps | Select-Object Name, AppId) | ConvertTo-Json -Depth 3 -Compress
        try {
            $utf8Bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
            $b64 = [System.Convert]::ToBase64String($utf8Bytes)
            Write-Output ("B64JSON:" + $b64)
        } catch {
            # 若方法调用在受限语言模式被阻止，直接回落 RAW，保留原始 Unicode
            Write-Output ("RAW:" + $json)
        }
        "#;

        // 使用 PowerShell 扫描 UWP 应用
        // 通过 -OutputEncoding UTF8 强制 UTF-8 编码输出，避免 UTF-16LE 解码问题
        // 这样可以确保 "B64JSON:" 等前缀能被正确识别，不会出现 UNKNOWN 模式的乱码

        crate::log!("AppScan", "[UWP] 准备执行 PowerShell Get-StartApps 命令");
        let powershell_start = std::time::Instant::now();
        
        let output = Command::new("powershell")
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .arg("-NoLogo")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-OutputEncoding")
            .arg("UTF8")
            .arg("-Command")
            .arg(script)
            .output()
            .map_err(|e| {
                crate::log!("AppScan", "[UWP] PowerShell 执行失败: {}", e);
                format!("Failed to run PowerShell: {}", e)
            })?;
        
        let powershell_duration = powershell_start.elapsed();
        crate::log!("AppScan", "[UWP] PowerShell 执行完成 (耗时 {}ms, 退出码: {}, stdout: {} bytes, stderr: {} bytes)", 
            powershell_duration.as_millis(), 
            output.status.code().unwrap_or(-1),
            output.stdout.len(),
            output.stderr.len());


        crate::log!("AppScan", "[UWP] 开始解析 PowerShell 输出");

        // 先尝试解码 stdout（无论成功失败都先看看内容）
        let stdout_result = decode_powershell_output(&output.stdout);
        
        if !output.status.success() {
            // PowerShell 执行失败
            crate::log!("AppScan", "[UWP] PowerShell 执行失败，退出码: {}", output.status.code().unwrap_or(-1));
            
            // 尝试解码 stderr（可能包含错误信息）
            let stderr_str = String::from_utf8_lossy(&output.stderr);
            
            // 如果 stderr 为空，使用 stdout 作为错误信息
            let error_msg = if stderr_str.trim().is_empty() {
                match stdout_result {
                    Ok(s) if !s.trim().is_empty() => s,
                    _ => "PowerShell 执行失败，但未返回错误信息".to_string()
                }
            } else {
                stderr_str.to_string()
            };
            
            return Err(format!("PowerShell shell:AppsFolder enumeration failed: {}", error_msg));
        }

        // PowerShell 执行成功，解码 stdout
        crate::log!("AppScan", "[UWP] 开始解码 PowerShell 输出...");
        let decode_start = std::time::Instant::now();
        let stdout = stdout_result?;
        let stdout_trimmed = stdout.trim();
        crate::log!("AppScan", "[UWP] 输出解码完成 (耗时 {}ms, 长度 {} bytes)", decode_start.elapsed().as_millis(), stdout_trimmed.len());
        
        if stdout_trimmed.is_empty() {
            let stderr_str = String::from_utf8_lossy(&output.stderr);
            crate::log!("AppScan", "[UWP] PowerShell 返回空输出");
            // #region agent log - empty stdout
            agent_log(
                "H1",
                "app_search.rs:scan_uwp_apps_direct:empty_stdout",
                "powershell stdout empty",
                serde_json::json!({
                    "stderr_preview": stderr_str,
                }),
            );
            // #endregion
            return Err(format!("PowerShell Get-StartApps returned empty output, stderr: {}", stderr_str));
        }


        crate::log!("AppScan", "[UWP] 检测输出模式...");
        // 处理 B64JSON:/B64:/RAW: 前缀；如果没有前缀则保持原样
        let (payload_str, mode) = if stdout_trimmed.starts_with("B64JSON:") {
            (&stdout_trimmed["B64JSON:".len()..], "B64JSON")
        } else if stdout_trimmed.starts_with("B64:") {
            (&stdout_trimmed[4..], "B64")
        } else if stdout_trimmed.starts_with("RAW:") {
            (&stdout_trimmed[4..], "RAW")
        } else {
            (stdout_trimmed, "UNKNOWN")
        };

        crate::log!("AppScan", "[UWP] 输出模式: {}, payload 长度: {} bytes", mode, payload_str.len());
        
        // 如果是 UNKNOWN 模式，输出前 200 个字符以便调试
        if mode == "UNKNOWN" {
            let first_200: String = stdout_trimmed.chars().take(200).collect();
            crate::log!("AppScan", "[UWP] 警告: UNKNOWN 模式，输出前 200 字符: {}", first_200);
        }
        

        crate::log!("AppScan", "[UWP] 开始 Base64 解码...");
        let base64_start = std::time::Instant::now();
        // 如果是 B64 前缀，则尝试 Base64 解码；否则使用原始字符串
        let decoded_json = if mode == "B64JSON" || mode == "B64" {
            match base64::engine::general_purpose::STANDARD.decode(payload_str) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(s) => s,
                    Err(e) => {
                        agent_log(
                            "H2",
                            "app_search.rs:scan_uwp_apps_direct:b64_utf8_error",
                            "base64 decoded but utf8 failed",
                            serde_json::json!({"error": e.to_string()}),
                        );
                        return Err(format!("Failed to decode UTF-8 JSON from base64: {}", e));
                    }
                },
                Err(e) => {
                    agent_log(
                        "H2",
                        "app_search.rs:scan_uwp_apps_direct:b64_decode_error",
                        "base64 decode failed",
                        serde_json::json!({"error": e.to_string()}),
                    );
                    return Err(format!("Failed to decode Base64 payload: {}", e));
                }
            }
        } else {
            payload_str.to_string()
        };
        
        crate::log!("AppScan", "[UWP] Base64 解码完成 (耗时 {}ms)", base64_start.elapsed().as_millis());

        crate::log!("AppScan", "[UWP] 开始生成输出预览 (总长度: {} bytes)...", decoded_json.len());
        let preview_start = std::time::Instant::now();
        
        // 打印前 500 个字符用于调试
        let preview = if decoded_json.len() > 500 {
            format!("{}...", &decoded_json[..500])
        } else {
            decoded_json.clone()
        };
        
        let preview_duration = preview_start.elapsed();
        crate::log!("AppScan", "[UWP] 输出预览生成完成 (预览长度: {} chars, 耗时 {}ms)", preview.len(), preview_duration.as_millis());
        
        crate::log!("AppScan", "[UWP] 检查 Unicode 转义序列...");
        let unicode_check_start = std::time::Instant::now();
        
        // 检查是否包含 Unicode 转义序列（\uXXXX）
        let unicode_escape_count = preview.matches("\\u").count();
        
        let unicode_check_duration = unicode_check_start.elapsed();
        crate::log!("AppScan", "[UWP] Unicode 检查完成 (找到 {} 个转义序列, 耗时 {}ms)", unicode_escape_count, unicode_check_duration.as_millis());

        crate::log!("AppScan", "[UWP] 开始解析 JSON (长度 {} bytes)...", decoded_json.len());
        let json_parse_start = std::time::Instant::now();
        
        // Handle both array and single-object JSON outputs
        let entries: Vec<StartAppEntry> = match serde_json::from_str::<Vec<StartAppEntry>>(&decoded_json) {
            Ok(entries) => entries,
            Err(e) => {
                // #region agent log - json parse error
                agent_log(
                    "H2",
                    "app_search.rs:scan_uwp_apps_direct:json_parse_error",
                    "failed to parse JSON",
                    serde_json::json!({
                        "error": e.to_string(),
                        "stdout_preview": preview,
                    }),
                );
                // #endregion
                // Try parsing as single object
                match serde_json::from_str::<StartAppEntry>(&decoded_json) {
                    Ok(entry) => vec![entry],
                    Err(_) => {
                        return Err(format!("Failed to parse shell:AppsFolder JSON: {}", e));
                    }
                }
            }
        };

        let json_parse_duration = json_parse_start.elapsed();
        crate::log!("AppScan", "[UWP] JSON 解析成功，找到 {} 个条目 (耗时 {}ms)", entries.len(), json_parse_duration.as_millis());

        // #region agent log - json parsed
        let sample: Vec<_> = entries
            .iter()
            .take(5)
            .map(|e| serde_json::json!({"name": e.name, "app_id": e.app_id}))
            .collect();
        agent_log(
            "H2",
            "app_search.rs:scan_uwp_apps_direct:json_parsed",
            "parsed entries",
            serde_json::json!({
                "entries_len": entries.len(),
                "sample": sample,
            }),
        );
        // #endregion

        crate::log!("AppScan", "[UWP] 开始处理 {} 个应用条目...", entries.len());
        let mut apps = Vec::with_capacity(entries.len());
        let mut chinese_app_count = 0;
        let processing_start = std::time::Instant::now();
        
        for (idx, entry) in entries.iter().enumerate() {
            // 每处理10个应用记录一次进度
            if idx > 0 && idx % 10 == 0 {
                crate::log!("AppScan", "[UWP] 处理进度: {}/{} (已耗时 {}ms)", idx, entries.len(), processing_start.elapsed().as_millis());
            }
            
            let name = entry.name.trim();
            let app_id = entry.app_id.trim();
            
            // 检查是否包含替换字符（说明解码可能有问题）
            let replacement_count = name.chars().filter(|&c| c == '\u{FFFD}').count();
            
            // 检查是否包含中文
            let has_chinese = contains_chinese(name);
            if has_chinese {
                chinese_app_count += 1;
            }
            
            if name.is_empty() || app_id.is_empty() {
                continue;
            }

            // 判断 AppID 格式，决定使用哪种路径格式
            // UWP AppID 格式通常是：PackageFamilyName!ApplicationId 或 PackageFamilyName_数字!ApplicationId
            // 传统应用路径通常包含反斜杠或冒号，或者是完整路径
            let path = if app_id.contains('\\') || app_id.contains(':') || 
                         app_id.starts_with("http://") || app_id.starts_with("https://") ||
                         Path::new(app_id).exists() {
                // 传统应用路径，直接使用
                app_id.to_string()
            } else if app_id.contains('!') || app_id.contains('_') {
                // 看起来是 UWP AppID 格式（包含 ! 或 _），使用 shell:AppsFolder 格式
                format!("shell:AppsFolder\\{}", app_id)
            } else {
                // 其他格式，尝试作为 UWP AppID 处理
                format!("shell:AppsFolder\\{}", app_id)
            };
            let path = expand_known_folder_guid(&path);
            
            let name_string = name.to_string();
            
            // 优化：复用前面的 has_chinese 判断，避免重复调用 contains_chinese
            let (name_pinyin, name_pinyin_initials) = if has_chinese {
                let pinyin_start = std::time::Instant::now();
                let pinyin = Some(to_pinyin(name).to_lowercase());
                let pinyin_initials = Some(to_pinyin_initials(name).to_lowercase());
                let pinyin_duration = pinyin_start.elapsed();
                
                // 如果拼音转换超过50ms，记录警告
                if pinyin_duration.as_millis() > 50 {
                    crate::log!("AppScan", "[UWP] 警告: 应用 '{}' 的拼音转换耗时 {}ms", name, pinyin_duration.as_millis());
                }
                
                (pinyin, pinyin_initials)
            } else {
                (None, None)
            };

            apps.push(AppInfo {
                name: name_string,
                path,
                icon: None,
                description: None,
                name_pinyin,
                name_pinyin_initials,
            });
        }

        let processing_duration = processing_start.elapsed();
        crate::log!("AppScan", "[UWP] 应用条目处理完成 - 创建了 {} 个应用（其中 {} 个中文应用）(耗时 {}ms)", 
            apps.len(), chinese_app_count, processing_duration.as_millis());
        crate::log!("AppScan", "[UWP] 成功创建 {} 个应用（其中 {} 个中文名）", apps.len(), chinese_app_count);
        
        Ok(apps)
    }

    fn scan_directory(dir: &Path, apps: &mut Vec<AppInfo>, depth: usize) -> Result<(), String> {
        // Limit recursion depth to avoid scanning too deep (increased to 3 for better coverage)
        const MAX_DEPTH: usize = 3;
        if depth > MAX_DEPTH {
            return Ok(());
        }

        // Limit total number of apps to avoid memory issues (increased to 2000)
        if apps.len() >= MAX_APPS {
            return Ok(());
        }

        // Skip WindowsApps directory - UWP apps should be scanned via Get-StartApps instead
        // Skip Recent directory - contains temporary shortcuts that often get deleted
        let dir_str = dir.to_string_lossy();
        if is_windowsapps_path(&dir_str) || is_recent_path(&dir_str) {
            return Ok(());
        }

        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) => return Ok(()), // Skip directories we can't read
        };

        for entry in entries {
            if apps.len() >= MAX_APPS {
                break;
            }

            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue, // Skip entries we can't read
            };
            let path = entry.path();

            // Skip files in WindowsApps and Recent directories
            let path_str = path.to_string_lossy();
            if is_windowsapps_path(&path_str) || is_recent_path(&path_str) {
                continue;
            }

            if path.is_dir() {
                // Recursively scan subdirectories
                if let Err(_) = scan_directory(&path, apps, depth + 1) {
                    // Continue on error
                }
            } else {
                // Check if it's a .lnk or .exe file
                let ext = path.extension()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_lowercase());
                
                if ext == Some("lnk".to_string()) || ext == Some("exe".to_string()) {
                    // Fast path: use filename directly without parsing
                    // Don't extract icon during scan to keep it fast - extract in background later
                    if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                        let name_str = name.to_string();
                        // Pre-compute pinyin for faster search (only for Chinese names)
                        let (name_pinyin, name_pinyin_initials) = if contains_chinese(&name_str) {
                            (
                                Some(to_pinyin(&name_str).to_lowercase()),
                                Some(to_pinyin_initials(&name_str).to_lowercase()),
                            )
                        } else {
                            (None, None)
                        };
                        apps.push(AppInfo {
                            name: name_str,
                            path: path.to_string_lossy().to_string(),
                            icon: None, // Will be extracted in background
                            description: None,
                            name_pinyin,
                            name_pinyin_initials,
                        });
                    }
                }
            }
        }

        Ok(())
    }

    // Extract icon from UWP app (shell:AppsFolder path)
    // 使用 Windows API 直接提取图标，避免在约束语言模式下使用 COM 对象
    pub fn extract_uwp_app_icon_base64(app_path: &str) -> Option<String> {
        // Parse shell:AppsFolder\PackageFamilyName!ApplicationId format
        if !app_path.starts_with("shell:AppsFolder\\") {
            return None;
        }
        
        // 使用纯 Rust 实现，调用 Native Windows API
        if let Some(icon) = extract_uwp_app_icon_base64_native(app_path) {
            return Some(icon);
        }
        
        None
    }
    
    // 使用 IShellItemImageFactory 提取 UWP 应用图标（推荐方法）
    // 如果失败，回退到 SHGetFileInfoW 方法
    fn extract_uwp_app_icon_base64_native(app_path: &str) -> Option<String> {
        // 首先尝试使用 IShellItemImageFactory（更准确）
        if let Some(result) = extract_uwp_app_icon_via_image_factory(app_path) {
            return Some(result);
        }
        
        // 回退到 SHGetFileInfoW 方法
        extract_uwp_app_icon_via_shgetfileinfo(app_path)
    }
    
    // 使用 IShellItemImageFactory 提取图标（新方法）
    fn extract_uwp_app_icon_via_image_factory(app_path: &str) -> Option<String> {
        // 使用别名避免与 windows 模块冲突
        use ::windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF};
        use ::windows::Win32::Graphics::Gdi::{DeleteObject, HGDIOBJ};
        use ::windows::core::PCWSTR;
        
        unsafe {
            // 初始化 COM（如果尚未初始化）
            use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
            let _ = CoInitializeEx(std::ptr::null_mut(), COINIT_APARTMENTTHREADED as u32);
            
            let result = (|| -> Option<String> {
                // 将路径转换为 PCWSTR
                use std::ffi::OsStr;
                use std::os::windows::ffi::OsStrExt;
                let path_wide: Vec<u16> = OsStr::new(app_path)
                    .encode_wide()
                    .chain(Some(0))
                    .collect();
                let path_pcwstr = PCWSTR::from_raw(path_wide.as_ptr());
                
                // 使用 SHCreateItemFromParsingName 创建 IShellItem
                use ::windows::Win32::UI::Shell::IShellItem;
                let shell_item: IShellItem = match SHCreateItemFromParsingName(path_pcwstr, None) {
                    Ok(item) => item,
                    Err(_) => {
                        return None;
                    }
                };
                
                // QueryInterface 获取 IShellItemImageFactory
                use ::windows::core::Interface;
                let image_factory: IShellItemImageFactory = match shell_item.cast() {
                    Ok(factory) => factory,
                    Err(_) => {
                        return None;
                    }
                };
                
                // 定义图标尺寸
                let size = ::windows::Win32::Foundation::SIZE { cx: ICON_SIZE as i32, cy: ICON_SIZE as i32 };
                
                // 尝试不同的标志组合
                // 先尝试：只要图标，允许更大尺寸
                let flags_list = vec![
                    SIIGBF((0x00000010u32 | 0x00000001u32) as i32), // SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK
                    SIIGBF(0x00000010u32 as i32), // SIIGBF_ICONONLY
                    SIIGBF(0x00000000u32 as i32), // 默认标志
                ];
                
                for (_, flags) in flags_list.iter().enumerate() {
                    // 调用 GetImage 获取 HBITMAP
                    match image_factory.GetImage(size, *flags) {
                        Ok(hbitmap) => {
                            // 将 HBITMAP 转换为 PNG
                            let hbitmap_value = hbitmap.0 as isize;
                            let png_result = bitmap_to_png(hbitmap_value);
                            
                            // 清理 HBITMAP
                            let _ = DeleteObject(HGDIOBJ(hbitmap.0));
                            
                            if let Some(ref png_base64) = png_result {
                                // 返回纯 base64 字符串，不带 data:image/png;base64, 前缀
                                return Some(png_base64.clone());
                            }
                        },
                        Err(_) => {
                            continue; // 尝试下一个标志
                        }
                    }
                }
                
                None
            })();
            
            // 清理 COM
            CoUninitialize();
            
            result
        }
    }
    
    // 使用 SHGetFileInfoW 提取图标（回退方法）
    fn extract_uwp_app_icon_via_shgetfileinfo(app_path: &str) -> Option<String> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon;
        
        // 将路径转换为 UTF-16
        let path_wide: Vec<u16> = OsStr::new(app_path)
            .encode_wide()
            .chain(Some(0))
            .collect();
        
        unsafe {
            // 定义 SHFILEINFOW 结构体
            #[repr(C)]
            struct SHFILEINFOW {
                h_icon: isize,
                i_icon: i32,
                dw_attributes: u32,
                sz_display_name: [u16; 260],
                sz_type_name: [u16; 80],
            }
            
            // 定义 SHGetFileInfoW 函数签名
            #[link(name = "shell32")]
            extern "system" {
                fn SHGetFileInfoW(
                    psz_path: *const u16,
                    dw_file_attributes: u32,
                    psfi: *mut SHFILEINFOW,
                    cb_size_file_info: u32,
                    u_flags: u32,
                ) -> isize;
            }
            
            // 标志常量
            const SHGFI_ICON: u32 = 0x100;
            const SHGFI_LARGEICON: u32 = 0x0;
            const SHGFI_USEFILEATTRIBUTES: u32 = 0x10;
            
            let mut shfi = SHFILEINFOW {
                h_icon: 0,
                i_icon: 0,
                dw_attributes: 0,
                sz_display_name: [0; 260],
                sz_type_name: [0; 80],
            };
            
            // 调用 SHGetFileInfoW 获取图标
            let result = SHGetFileInfoW(
                path_wide.as_ptr(),
                0,
                &mut shfi,
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON | SHGFI_USEFILEATTRIBUTES,
            );
            
            
            if result == 0 || shfi.h_icon == 0 {
                return None;
            }
            
            // 使用现有的 icon_to_png 函数转换图标
            let icon_result = icon_to_png(shfi.h_icon);
            
            
            // 清理图标句柄
            DestroyIcon(shfi.h_icon);
            
            // 返回纯 base64 字符串，不带 data:image/png;base64, 前缀
            icon_result
        }
    }
    
    // 辅助函数：将 HBITMAP 转换为 PNG base64 字符串
    fn bitmap_to_png(hbitmap: isize) -> Option<String> {
        use windows_sys::Win32::Graphics::Gdi::{
            GetDIBits, CreateCompatibleDC, SelectObject, DeleteObject, DeleteDC,
            BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, BI_RGB, GetDC, ReleaseDC,
        };

        unsafe {
            let icon_size = ICON_SIZE;
            
            // 获取屏幕 DC
            let hdc_screen = GetDC(0);
            if hdc_screen == 0 {
                return None;
            }

            let hdc = CreateCompatibleDC(hdc_screen);
            if hdc == 0 {
                ReleaseDC(0, hdc_screen);
                return None;
            }

            // 获取位图信息
            let mut bitmap = BITMAP {
                bmType: 0,
                bmWidth: 0,
                bmHeight: 0,
                bmWidthBytes: 0,
                bmPlanes: 1,
                bmBitsPixel: 32,
                bmBits: std::ptr::null_mut(),
            };
            
            // 获取位图尺寸
            use windows_sys::Win32::Graphics::Gdi::GetObjectW;
            if GetObjectW(hbitmap, std::mem::size_of::<BITMAP>() as i32, &mut bitmap as *mut _ as *mut _) == 0 {
                DeleteDC(hdc);
                ReleaseDC(0, hdc_screen);
                return None;
            }
            
            let width = bitmap.bmWidth as u32;
            let height = bitmap.bmHeight.abs() as u32;
            
            // 创建新的 32x32 位图，使用透明背景
            use windows_sys::Win32::Graphics::Gdi::{CreateDIBSection, DIB_RGB_COLORS, SelectObject};
            
            let mut bitmap_info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: icon_size as i32,
                    biHeight: -(icon_size as i32), // 负值表示从上到下
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
                bmiColors: [windows_sys::Win32::Graphics::Gdi::RGBQUAD {
                    rgbBlue: 0,
                    rgbGreen: 0,
                    rgbRed: 0,
                    rgbReserved: 0,
                }; 1],
            };

            let mut bits_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
            let hbitmap_new = CreateDIBSection(
                hdc,
                &bitmap_info,
                DIB_RGB_COLORS,
                &mut bits_ptr,
                0,
                0,
            ) as isize;

            if hbitmap_new == 0 {
                DeleteDC(hdc);
                ReleaseDC(0, hdc_screen);
                return None;
            }

            let old_bitmap = SelectObject(hdc, hbitmap_new);

            // 将原始位图选入另一个 DC 以便复制
            let hdc_source = CreateCompatibleDC(hdc_screen);
            if hdc_source != 0 {
                let old_bitmap_source = SelectObject(hdc_source, hbitmap);
                
                // 将原始位图绘制到新位图上（如果需要缩放）
                use windows_sys::Win32::Graphics::Gdi::{StretchBlt, BitBlt, SRCCOPY};
                
                if width == icon_size && height == icon_size {
                    // 尺寸相同，直接复制
                    let _ = BitBlt(
                        hdc,                    // 目标 DC
                        0,                      // 目标 x
                        0,                      // 目标 y
                        icon_size as i32,       // 宽度
                        icon_size as i32,       // 高度
                        hdc_source,             // 源 DC
                        0,                      // 源 x
                        0,                      // 源 y
                        SRCCOPY,                // 光栅操作码
                    );
                } else {
                    // 需要缩放
                    let _ = StretchBlt(
                        hdc,                    // 目标 DC
                        0,                      // 目标 x
                        0,                      // 目标 y
                        icon_size as i32,       // 目标宽度
                        icon_size as i32,       // 目标高度
                        hdc_source,             // 源 DC
                        0,                      // 源 x
                        0,                      // 源 y
                        width as i32,           // 源宽度
                        height as i32,          // 源高度
                        SRCCOPY,                // 光栅操作码
                    );
                }
                
                SelectObject(hdc_source, old_bitmap_source);
                DeleteDC(hdc_source);
            }

            // 读取新位图的数据
            let mut bitmap_info_read = bitmap_info.clone();
            let mut dib_bits = vec![0u8; (icon_size * icon_size * 4) as usize];
            let lines_written = GetDIBits(
                hdc_screen,
                hbitmap_new,
                0,
                icon_size,
                dib_bits.as_mut_ptr() as *mut _,
                &mut bitmap_info_read,
                DIB_RGB_COLORS,
            );

            SelectObject(hdc, old_bitmap);
            DeleteObject(hbitmap_new);

            DeleteDC(hdc);
            ReleaseDC(0, hdc_screen);

            if lines_written == 0 {
                return None;
            }

            // 将 BGRA 转换为 RGBA，保持透明度
            // 注意：此时 dib_bits 已经是 32x32 的位图数据，透明区域保持透明
            for chunk in dib_bits.chunks_exact_mut(4) {
                // 只交换 B 和 R 通道，保持 G 和 A 不变
                chunk.swap(0, 2); // B <-> R
            }

            // 最终位图数据（已经是 32x32，透明背景）
            let final_bits = dib_bits;

            // 使用 png crate 编码为 PNG
            let mut png_data = Vec::new();
            {
                let mut encoder = png::Encoder::new(
                    std::io::Cursor::new(&mut png_data),
                    icon_size,
                    icon_size,
                );
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                let mut writer = encoder.write_header().ok()?;
                writer.write_image_data(&final_bits).ok()?;
            }

            // 编码为 base64
            Some(base64::engine::general_purpose::STANDARD.encode(&png_data))
        }
    }
    
    // Extract icon from .exe file using Native Windows API
    // This is more reliable than PowerShell method for some exe files (like v2rayN.exe)
    fn extract_exe_icon_base64_native(file_path: &Path) -> Option<String> {
        let file_path_str = file_path.to_string_lossy().to_string();
        
        // 展开 GUID 格式的路径（如 {1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\RecoveryDrive.exe）
        let expanded_path_str = expand_known_folder_guid(&file_path_str);
        let expanded_path = Path::new(&expanded_path_str);
        
        // 优先使用 IShellItemImageFactory（最可靠）
        if let Some(result) = extract_icon_png_via_shell(expanded_path, 32) {
            return Some(result);
        }
        
        // 回退方案: 使用 ExtractIconExW + icon_to_png
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
        use windows_sys::Win32::UI::Shell::ExtractIconExW;
        use windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon;

        // 初始化 COM（单线程模式，用于 COM 接口）
        unsafe {
            let hr = CoInitializeEx(std::ptr::null_mut(), COINIT_APARTMENTTHREADED as u32);
            if hr < 0 && hr != 0x00000001 {
                return None;
            }
        }

        let result = (|| -> Option<String> {
            // 使用 ExtractIconExW 从 exe 文件提取图标（使用展开后的路径）
            let file_path_wide: Vec<u16> = OsStr::new(expanded_path)
                .encode_wide()
                .chain(Some(0))
                .collect();

            unsafe {
                // 首先尝试索引 0（默认图标）
                let mut large_icons: [isize; 1] = [0; 1];
                let count = ExtractIconExW(
                    file_path_wide.as_ptr(),
                    0,
                    large_icons.as_mut_ptr(),
                    std::ptr::null_mut(),
                    1,
                );

                if count > 0 && large_icons[0] != 0 {
                    if let Some(png_data) = icon_to_png(large_icons[0]) {
                        DestroyIcon(large_icons[0]);
                        // 返回纯 base64 字符串，不带 data:image/png;base64, 前缀
                        return Some(png_data);
                    }
                    DestroyIcon(large_icons[0]);
                }
            }
            None
        })();

        // 清理 COM
        unsafe {
            CoUninitialize();
        }

        result
    }

    // Extract icon from file and convert to base64 PNG
    // Uses PowerShell with parameter passing to avoid encoding issues
    // Now tries Native API first, falls back to PowerShell if Native API fails
    pub fn extract_icon_base64(file_path: &Path) -> Option<String> {
        // 首先尝试 Native API 方法（更可靠，特别是对于某些 exe 文件如 v2rayN.exe）
        if let Some(result) = extract_exe_icon_base64_native(file_path) {
            return Some(result);
        }
        // 如果 Native API 失败，回退到 PowerShell 方法
        // Convert path to UTF-16 bytes for PowerShell parameter
        let path_utf16: Vec<u16> = file_path.to_string_lossy().encode_utf16().collect();
        let path_base64 = base64::engine::general_purpose::STANDARD.encode(
            path_utf16
                .iter()
                .flat_map(|&u| u.to_le_bytes())
                .collect::<Vec<u8>>(),
        );

        // PowerShell script that decodes UTF-16 path and extracts icon using WMI
        // This avoids System.Drawing.Icon mixed-mode assembly issues
        let ps_script = r#"
param([string]$PathBase64)

try {
    # Decode UTF-16 path from base64
    $bytes = [Convert]::FromBase64String($PathBase64)
    $path = [System.Text.Encoding]::Unicode.GetString($bytes)
    
    if (-not (Test-Path -LiteralPath $path)) {
        exit 1
    }
    
    # Use WMI to get file icon (avoids System.Drawing mixed-mode issues)
    $shell = New-Object -ComObject Shell.Application
    $folder = $shell.NameSpace((Split-Path -Parent $path))
    $item = $folder.ParseName((Split-Path -Leaf $path))
    
    if ($item -eq $null) {
        exit 1
    }
    
    # Extract icon using Shell32
    $iconPath = $item.ExtractIcon(0)
    if ($iconPath -eq $null) {
        exit 1
    }
    
    # Convert icon to PNG using GDI+ with transparency preserved
    Add-Type -AssemblyName System.Drawing
    $icon = [System.Drawing.Icon]::FromHandle($iconPath.Handle)
    $bitmap = $icon.ToBitmap()
    # 创建支持透明度的位图（Format32bppArgb 支持 alpha 通道）
    $resized = New-Object System.Drawing.Bitmap(32, 32, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($resized)
    # 清除为完全透明（alpha=0），确保位图被正确初始化
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($bitmap, 0, 0, 32, 32)
    $ms = New-Object System.IO.MemoryStream
    $resized.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $ms.Close()
    $graphics.Dispose()
    $resized.Dispose()
    $icon.Dispose()
    $bitmap.Dispose()
    
    [Convert]::ToBase64String($bytes)
} catch {
    exit 1
}
"#;

        // Write script to temp file to avoid command-line length limits
        let temp_script =
            std::env::temp_dir().join(format!("icon_extract_{}.ps1", std::process::id()));
        std::fs::write(&temp_script, ps_script).ok()?;

        let output = Command::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
            .args(&[
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                temp_script.to_str()?,
                "-PathBase64",
                &path_base64,
            ])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW - 隐藏 PowerShell 窗口
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .ok()?;

        // Clean up temp script
        let _ = std::fs::remove_file(&temp_script);

        if output.status.success() {
            let base64 = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !base64.is_empty() && base64.len() > 100 {
                // 返回纯 base64 字符串，不带 data:image/png;base64, 前缀
                // 前端会统一添加前缀
                return Some(base64);
            }
        }
        None
    }

    // 使用 IShellItemImageFactory 提取图标（优先方案）
    // 直接从 Shell 获取已合成的带 alpha 通道的位图
    pub fn extract_icon_png_via_shell(file_path: &Path, size: u32) -> Option<String> {
        use ::windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF};
        use ::windows::Win32::Graphics::Gdi::{DeleteObject, HGDIOBJ};
        use ::windows::core::PCWSTR;
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        
        unsafe {
            // 初始化 COM（单线程模式）
            use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
            let hr = CoInitializeEx(std::ptr::null_mut(), COINIT_APARTMENTTHREADED as u32);
            // 如果已经初始化，返回 S_FALSE (0x00000001)，这是正常的
            if hr < 0 && hr != 0x00000001 {
                return None;
            }
            
            let result = (|| -> Option<String> {
                // 规范化路径：统一使用反斜杠，移除 \\?\ 前缀（如果存在）
                let path_str = file_path.to_string_lossy().to_string();
                let mut normalized_path = path_str.replace("/", "\\");
                // 移除 \\?\ 前缀（如果存在），因为某些 Windows API 可能不支持
                if normalized_path.starts_with("\\\\?\\") {
                    normalized_path = normalized_path[4..].to_string();
                }
                // 展开 GUID 格式的路径（如 {1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\RecoveryDrive.exe）
                normalized_path = expand_known_folder_guid(&normalized_path);
                
                // 将规范化后的路径转换为 PCWSTR
                let path_wide: Vec<u16> = OsStr::new(&normalized_path)
                    .encode_wide()
                    .chain(Some(0))
                    .collect();
                let path_pcwstr = PCWSTR::from_raw(path_wide.as_ptr());
                
                // 使用 SHCreateItemFromParsingName 创建 IShellItem
                use ::windows::Win32::UI::Shell::IShellItem;
                let shell_item: IShellItem = match SHCreateItemFromParsingName(path_pcwstr, None) {
                    Ok(item) => item,
                    Err(_) => {
                        return None;
                    }
                };
                
                // QueryInterface 获取 IShellItemImageFactory
                use ::windows::core::Interface;
                let image_factory: IShellItemImageFactory = match shell_item.cast() {
                    Ok(factory) => factory,
                    Err(_) => {
                        return None;
                    }
                };
                
                // 定义图标尺寸
                let icon_size = ::windows::Win32::Foundation::SIZE { cx: size as i32, cy: size as i32 };
                
                // 尝试不同的标志组合
                // 优先使用默认标志（0x00000000），因为测试发现这个标志提取的图标是正确的
                // SIIGBF_ICONONLY (0x00000010): 只要图标，不要缩略图
                // SIIGBF_BIGGERSIZEOK (0x00000001): 允许返回更大的尺寸
                let flags_list = vec![
                    SIIGBF(0x00000000u32 as i32), // 默认（优先使用，确保与测试函数一致）
                    SIIGBF((0x00000010u32 | 0x00000001u32) as i32), // ICONONLY | BIGGERSIZEOK（回退）
                    SIIGBF(0x00000010u32 as i32), // ICONONLY（回退）
                ];
                
                for (idx, flags) in flags_list.iter().enumerate() {
                    // 调用 GetImage 获取 HBITMAP（已包含 alpha 通道）
                    match image_factory.GetImage(icon_size, *flags) {
                        Ok(hbitmap) => {
                            // 将 HBITMAP 转换为 PNG
                            let hbitmap_value = hbitmap.0 as isize;
                            let png_result = bitmap_to_png_direct(hbitmap_value, size);
                            
                            // 清理 HBITMAP（必须释放）
                            let _ = DeleteObject(HGDIOBJ(hbitmap.0));
                            
                            if let Some(png_base64) = png_result {
                                // 返回纯 base64 字符串，不带 data:image/png;base64, 前缀
                                return Some(png_base64);
                            }
                        },
                        Err(_) => {
                            continue; // 尝试下一个标志
                        }
                    }
                }
                
                None
            })();
            
            // 清理 COM（只有在成功初始化时才清理）
            if hr >= 0 || hr == 0x00000001 {
                CoUninitialize();
            }
            
            result
        }
    }
    
    // 直接从 HBITMAP 读取像素数据并转换为 PNG（改进版）
    // 不再创建新的 DIB 和复制，直接从源位图读取
    fn bitmap_to_png_direct(hbitmap: isize, target_size: u32) -> Option<String> {
        use windows_sys::Win32::Graphics::Gdi::{
            GetDIBits, CreateCompatibleDC, SelectObject, DeleteObject, DeleteDC,
            BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, BI_RGB, GetDC, ReleaseDC, GetObjectW,
        };
        
        unsafe {
            // 获取屏幕 DC
            let hdc_screen = GetDC(0);
            if hdc_screen == 0 {
                return None;
            }
            
            let hdc = CreateCompatibleDC(hdc_screen);
            if hdc == 0 {
                ReleaseDC(0, hdc_screen);
                return None;
            }
            
            // 获取位图信息
            let mut bitmap = BITMAP {
                bmType: 0,
                bmWidth: 0,
                bmHeight: 0,
                bmWidthBytes: 0,
                bmPlanes: 1,
                bmBitsPixel: 32,
                bmBits: std::ptr::null_mut(),
            };
            
            // 获取位图尺寸和格式
            if GetObjectW(hbitmap, std::mem::size_of::<BITMAP>() as i32, &mut bitmap as *mut _ as *mut _) == 0 {
                DeleteDC(hdc);
                ReleaseDC(0, hdc_screen);
                return None;
            }
            
            let width = bitmap.bmWidth as u32;
            let height = bitmap.bmHeight.abs() as u32; // 取绝对值，处理 top-down 位图
            
            // 验证位图格式（必须是 32 位）
            if bitmap.bmBitsPixel != 32 {
                DeleteDC(hdc);
                ReleaseDC(0, hdc_screen);
                return None;
            }
            
            // 创建 BITMAPINFO 用于 GetDIBits
            let mut bitmap_info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width as i32,
                    biHeight: -(height as i32), // 负值表示 top-down DIB
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
                bmiColors: [windows_sys::Win32::Graphics::Gdi::RGBQUAD {
                    rgbBlue: 0,
                    rgbGreen: 0,
                    rgbRed: 0,
                    rgbReserved: 0,
                }; 1],
            };
            
            // 分配缓冲区读取位图数据
            let buffer_size = (width * height * 4) as usize;
            let mut dib_bits = vec![0u8; buffer_size];
            
            // 将位图选入 DC（需要先选入才能用 GetDIBits）
            let old_bitmap = SelectObject(hdc, hbitmap);
            
            // 读取位图数据（BGRA 格式）
            let lines_written = GetDIBits(
                hdc_screen,
                hbitmap,
                0,
                height,
                dib_bits.as_mut_ptr() as *mut _,
                &mut bitmap_info,
                DIB_RGB_COLORS,
            );
            
            // 恢复 DC
            SelectObject(hdc, old_bitmap);
            DeleteDC(hdc);
            ReleaseDC(0, hdc_screen);
            
            if lines_written == 0 {
                return None;
            }
            
            // 检查位图数据是否包含有效内容
            let total_pixels = width * height;
            let non_zero_pixels = dib_bits.chunks_exact(4)
                .filter(|chunk| chunk.iter().any(|&b| b != 0))
                .count();
            
            // 如果所有像素都是 0，说明位图无效
            if non_zero_pixels == 0 {
                return None;
            }
            
            // 如果需要缩放，使用简单的最近邻插值
            let mut final_bits = if width != target_size || height != target_size {
                let mut scaled = vec![0u8; (target_size * target_size * 4) as usize];
                let scale_x = width as f32 / target_size as f32;
                let scale_y = height as f32 / target_size as f32;
                
                for y in 0..target_size {
                    for x in 0..target_size {
                        let src_x = (x as f32 * scale_x) as u32;
                        let src_y = (y as f32 * scale_y) as u32;
                        let src_idx = ((src_y * width + src_x) * 4) as usize;
                        let dst_idx = ((y * target_size + x) * 4) as usize;
                        
                        if src_idx + 3 < dib_bits.len() && dst_idx + 3 < scaled.len() {
                            scaled[dst_idx..dst_idx + 4].copy_from_slice(&dib_bits[src_idx..src_idx + 4]);
                        }
                    }
                }
                scaled
            } else {
                dib_bits
            };
            
            // 将 BGRA 转换为 RGBA
            for chunk in final_bits.chunks_exact_mut(4) {
                chunk.swap(0, 2); // B <-> R
            }
            
            // 使用 png crate 编码为 PNG
            let mut png_data = Vec::new();
            {
                let mut encoder = png::Encoder::new(
                    std::io::Cursor::new(&mut png_data),
                    target_size,
                    target_size,
                );
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                let mut writer = encoder.write_header().ok()?;
                writer.write_image_data(&final_bits).ok()?;
            }
            
            // 验证 PNG 数据长度
            if png_data.len() < 200 {
                return None;
            }
            
            // 编码为 base64
            Some(base64::engine::general_purpose::STANDARD.encode(&png_data))
        }
    }

    // Extract icon from .lnk file using Native Windows API
    // This is the new implementation using Rust + Windows API directly
    // Falls back to PowerShell method if Native API fails
    pub fn extract_lnk_icon_base64_native(lnk_path: &Path) -> Option<String> {
        // 方法 1: 优先直接从 .lnk 文件本身提取图标（与测试函数一致）
        // 测试发现：直接从 .lnk 文件提取的图标是正确的，特别是对于系统快捷方式和某些 .exe 快捷方式
        if let Some(result) = extract_icon_png_via_shell(lnk_path, 32) {
            return Some(result);
        }
        
        // 方法 2: 如果直接从 .lnk 文件提取失败，解析 .lnk 文件获取 TargetPath 作为回退方案
        let (icon_source_path, icon_index) = match get_lnk_icon_location(lnk_path) {
            Some(result) => result,
            None => return None,
        };

        let icon_source_path_str = icon_source_path.to_string_lossy().to_string();
        
        // 检查是否是 shell:AppsFolder 路径（UWP 应用）
        if icon_source_path_str.to_lowercase().starts_with("shell:appsfolder\\") {
            if let Some(result) = extract_uwp_app_icon_base64(&icon_source_path_str) {
                return Some(result);
            }
        }
        
        let result = (|| -> Option<String> {
            // 回退方案: 从目标文件提取
            if let Some(result) = extract_icon_png_via_shell(&icon_source_path, 32) {
                return Some(result);
            }
            
            // 回退方案: 使用 ExtractIconExW + icon_to_png
            use std::ffi::OsStr;
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
            use windows_sys::Win32::UI::Shell::ExtractIconExW;
            use windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon;
            
            // 初始化 COM（用于 ExtractIconExW）
            unsafe {
                let hr = CoInitializeEx(std::ptr::null_mut(), COINIT_APARTMENTTHREADED as u32);
                if hr < 0 && hr != 0x00000001 {
                    return None;
                }
            }
            
            // 使用 ExtractIconExW 提取图标
            let icon_source_wide: Vec<u16> = OsStr::new(&icon_source_path)
                .encode_wide()
                .chain(Some(0))
                .collect();
            
            // 尝试使用指定索引提取图标
            let mut fallback_result = unsafe {
                let mut large_icons: [isize; 1] = [0; 1];
                let count = ExtractIconExW(
                    icon_source_wide.as_ptr(),
                    icon_index as i32,
                    large_icons.as_mut_ptr(),
                    std::ptr::null_mut(),
                    1,
                );

                if count > 0 && large_icons[0] != 0 {
                    if let Some(png_data) = icon_to_png(large_icons[0]) {
                        DestroyIcon(large_icons[0]);
                        // 返回纯 base64 字符串，不带 data:image/png;base64, 前缀
                        Some(png_data)
                    } else {
                        DestroyIcon(large_icons[0]);
                        None
                    }
                } else {
                    None
                }
            };
            
            // 如果指定索引失败，尝试索引 0
            if fallback_result.is_none() && icon_index != 0 {
                fallback_result = unsafe {
                    let mut large_icons: [isize; 1] = [0; 1];
                    let count = ExtractIconExW(
                        icon_source_wide.as_ptr(),
                        0,
                        large_icons.as_mut_ptr(),
                        std::ptr::null_mut(),
                        1,
                    );

                    if count > 0 && large_icons[0] != 0 {
                        if let Some(png_data) = icon_to_png(large_icons[0]) {
                            DestroyIcon(large_icons[0]);
                            // 返回纯 base64 字符串，不带 data:image/png;base64, 前缀
                            Some(png_data)
                        } else {
                            DestroyIcon(large_icons[0]);
                            None
                        }
                    } else {
                        None
                    }
                };
            }
            
            // 清理 COM
            unsafe {
                CoUninitialize();
            }
            
            fallback_result
        })();

        result
    }
    
    /// 获取 .lnk 文件的所有路径信息（IconLocation 和 TargetPath）
    fn get_lnk_all_paths(lnk_path: &Path) -> Option<(Option<(PathBuf, i32)>, Option<String>)> {
        use std::fs::File;
        use std::io::{Read, Seek, SeekFrom};
        
        let mut file = match File::open(lnk_path) {
            Ok(f) => f,
            Err(_) => return None,
        };
        
        // 读取 Shell Link Header (76 bytes)
        let mut header = [0u8; 76];
        if file.read_exact(&mut header).is_err() {
            return None;
        }
        
        // 验证 Shell Link Header Signature (0x0000004C)
        if u32::from_le_bytes([header[0], header[1], header[2], header[3]]) != 0x0000004C {
            return None;
        }
        
        // LinkFlags (offset 0x14, 4 bytes)
        let link_flags = u32::from_le_bytes([header[20], header[21], header[22], header[23]]);
        
        // 读取 LinkTargetIDList (如果存在)
        let mut offset: u64 = 76;
        if link_flags & 0x01 != 0 {
            let mut idlist_size_buf = [0u8; 2];
            if file.seek(SeekFrom::Start(offset)).is_err() || file.read_exact(&mut idlist_size_buf).is_err() {
                return None;
            }
            let idlist_size = u16::from_le_bytes(idlist_size_buf) as u64;
            offset += 2 + idlist_size;
        }
        
        // 读取并解析 LinkInfo (如果存在)
        let mut linkinfo_path: Option<String> = None;
        if link_flags & 0x02 != 0 {
            if file.seek(SeekFrom::Start(offset)).is_err() {
                return None;
            }
            let mut linkinfo_size_buf = [0u8; 4];
            if file.read_exact(&mut linkinfo_size_buf).is_err() {
                return None;
            }
            let linkinfo_size = u32::from_le_bytes(linkinfo_size_buf) as u64;
            offset += linkinfo_size;
        }
        
        // 读取 StringData 部分
        let mut target_path: Option<String> = linkinfo_path;
        let mut icon_location: Option<String> = None;
        let mut icon_index: i32 = 0;
        
        let stringdata_start = offset;
        if file.seek(SeekFrom::Start(offset)).is_err() {
            return None;
        }
        
        // 读取 IconLocation (如果存在，HasIconLocation = 0x20)
        if link_flags & 0x20 != 0 {
            let icon_location_str = read_length_prefixed_string_utf16(&mut file);
            if let Some(mut icon_loc) = icon_location_str {
                icon_loc = icon_loc.chars()
                    .filter(|c| !c.is_control() || *c == '\n' || *c == '\r')
                    .collect::<String>();
                
                // IconLocation 格式通常是 "path,index"
                if let Some(comma_pos) = icon_loc.rfind(',') {
                    let (path_part, index_part) = icon_loc.split_at(comma_pos);
                    let clean_path = path_part.trim().to_string();
                    if let Ok(idx) = index_part[1..].trim().parse::<i32>() {
                        icon_index = idx;
                        icon_location = Some(clean_path);
                    } else {
                        icon_location = Some(icon_loc);
                    }
                } else {
                    icon_location = Some(icon_loc);
                }
            }
        }
        
        // 读取 WorkingDir (如果存在，HasWorkingDir = 0x10)
        if link_flags & 0x10 != 0 {
            let _ = read_length_prefixed_string_utf16(&mut file);
        }
        
        // 读取 TargetPath (如果 LinkInfo 不存在，或者作为备用)
        if link_flags & 0x02 == 0 {
            let current_pos = file.seek(SeekFrom::Current(0)).ok();
            if let Some(pos) = current_pos {
                if file.seek(SeekFrom::Start(pos)).is_ok() {
                    let target_path_str = read_length_prefixed_string_utf16(&mut file);
                    if target_path.is_none() {
                        target_path = target_path_str;
                    }
                }
            }
        }
        
        // 处理 IconLocation
        let icon_location_result = if let Some(ref icon_path_str) = icon_location {
            let expanded_path = expand_env_path(icon_path_str);
            let icon_path = PathBuf::from(&expanded_path);
            if icon_path.exists() {
                Some((icon_path, icon_index))
            } else {
                None
            }
        } else {
            None
        };
        
        // 处理 TargetPath
        let target_path_str = target_path.map(|s| expand_env_path(&s));
        
        Some((icon_location_result, target_path_str))
    }
    
    /// 测试所有图标提取方法，返回每种方法的结果
    /// 用于调试和比较不同提取方法的效果
    pub fn test_all_icon_extraction_methods(lnk_path: &Path) -> Vec<(String, Option<String>)> {
        let mut results: Vec<(String, Option<String>)> = Vec::new();
        // 1. 解析 .lnk 文件获取 IconLocation 和 TargetPath
        let (icon_location_info, target_path_str) = match get_lnk_all_paths(lnk_path) {
            Some(result) => result,
            None => {
                results.push(("解析LNK文件".to_string(), None));
                return results;
            }
        };
        
        // 2. 测试从 IconLocation 提取（如果存在）
        if let Some((icon_path, icon_index)) = &icon_location_info {
            
            // 2.1 Shell API
            if let Some(result) = extract_icon_png_via_shell(icon_path, 32) {
                results.push((format!("IconLocation -> Shell API (索引 {})", icon_index), Some(result)));
            } else {
                results.push((format!("IconLocation -> Shell API (索引 {})", icon_index), None));
            }
            
            // 2.2 ExtractIconExW
            use std::ffi::OsStr;
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
            use windows_sys::Win32::UI::Shell::ExtractIconExW;
            use windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon;
            
            unsafe {
                let hr = CoInitializeEx(std::ptr::null_mut(), COINIT_APARTMENTTHREADED as u32);
                if hr >= 0 || hr == 0x00000001 {
                    let icon_source_wide: Vec<u16> = OsStr::new(icon_path)
                        .encode_wide()
                        .chain(Some(0))
                        .collect();
                    
                    let mut large_icons: [isize; 1] = [0; 1];
                    let count = ExtractIconExW(
                        icon_source_wide.as_ptr(),
                        *icon_index as i32,
                        large_icons.as_mut_ptr(),
                        std::ptr::null_mut(),
                        1,
                    );
                    
                    if count > 0 && large_icons[0] != 0 {
                        if let Some(png_data) = icon_to_png(large_icons[0]) {
                            // 返回纯 base64 字符串，不带 data:image/png;base64, 前缀
                            results.push((format!("IconLocation -> ExtractIconExW (索引 {})", icon_index), Some(png_data)));
                            DestroyIcon(large_icons[0]);
                        } else {
                            results.push((format!("IconLocation -> ExtractIconExW (索引 {})", icon_index), None));
                            DestroyIcon(large_icons[0]);
                        }
                    } else {
                        results.push((format!("IconLocation -> ExtractIconExW (索引 {})", icon_index), None));
                    }
                    
                    CoUninitialize();
                }
            }
        }
        
        // 3. 测试从 TargetPath 提取（如果存在）
        if let Some(ref target_path_str) = target_path_str {
            // 3.1 测试 UWP 方法（如果 TargetPath 是 shell:AppsFolder）
            if target_path_str.to_lowercase().starts_with("shell:appsfolder\\") {
                if let Some(result) = extract_uwp_app_icon_base64(target_path_str) {
                    results.push(("TargetPath -> UWP方法 (shell:AppsFolder)".to_string(), Some(result)));
                } else {
                    results.push(("TargetPath -> UWP方法 (shell:AppsFolder)".to_string(), None));
                }
            }
            
            // 3.2 测试 Shell API（如果 TargetPath 是文件路径）
            let target_path_buf = PathBuf::from(target_path_str);
            if target_path_buf.exists() {
                if let Some(result) = extract_icon_png_via_shell(&target_path_buf, 32) {
                    results.push(("TargetPath -> Shell API".to_string(), Some(result)));
                } else {
                    results.push(("TargetPath -> Shell API".to_string(), None));
                }
            }
        }
        
        // 4. 测试直接从 .lnk 文件本身提取（使用 Shell API）
        let direct_lnk_result = extract_icon_png_via_shell(lnk_path, 32);
        results.push(("直接从 .lnk 文件 -> Shell API".to_string(), direct_lnk_result));
        
        // 5. 测试 SHGetFileInfoW 方法（如果 TargetPath 存在）
        if let Some(ref target_path_str) = target_path_str {
            if !target_path_str.to_lowercase().starts_with("shell:appsfolder\\") {
                let target_path_buf = PathBuf::from(target_path_str);
                if target_path_buf.exists() {
                    if let Some(result) = extract_icon_via_shgetfileinfo(&target_path_buf) {
                        results.push(("TargetPath -> SHGetFileInfoW".to_string(), Some(result)));
                    } else {
                        results.push(("TargetPath -> SHGetFileInfoW".to_string(), None));
                    }
                }
            }
        }
        
        // 6. 测试 SHGetFileInfoW 方法（如果 IconLocation 存在）
        if let Some((icon_path, _)) = &icon_location_info {
            if let Some(result) = extract_icon_via_shgetfileinfo(icon_path) {
                results.push(("IconLocation -> SHGetFileInfoW".to_string(), Some(result)));
            } else {
                results.push(("IconLocation -> SHGetFileInfoW".to_string(), None));
            }
        }
        
        // 7. 测试 PowerShell 方法（作为参考）
        let ps_result = extract_lnk_icon_base64(lnk_path);
        results.push(("PowerShell方法 (fallback)".to_string(), ps_result));
        results
    }
    
    /// 使用 SHGetFileInfoW 提取图标
    fn extract_icon_via_shgetfileinfo(file_path: &Path) -> Option<String> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon;
        
        let path_wide: Vec<u16> = OsStr::new(file_path)
            .encode_wide()
            .chain(Some(0))
            .collect();
        
        unsafe {
            // 定义 SHFILEINFOW 结构体
            #[repr(C)]
            struct SHFILEINFOW {
                h_icon: isize,
                i_icon: i32,
                dw_attributes: u32,
                sz_display_name: [u16; 260],
                sz_type_name: [u16; 80],
            }
            
            // 定义 SHGetFileInfoW 函数签名
            #[link(name = "shell32")]
            extern "system" {
                fn SHGetFileInfoW(
                    psz_path: *const u16,
                    dw_file_attributes: u32,
                    psfi: *mut SHFILEINFOW,
                    cb_size_file_info: u32,
                    u_flags: u32,
                ) -> isize;
            }
            
            // 标志常量
            const SHGFI_ICON: u32 = 0x100;
            const SHGFI_LARGEICON: u32 = 0x0;
            
            let mut shfi = SHFILEINFOW {
                h_icon: 0,
                i_icon: 0,
                dw_attributes: 0,
                sz_display_name: [0; 260],
                sz_type_name: [0; 80],
            };
            
            // 调用 SHGetFileInfoW 获取图标
            let result = SHGetFileInfoW(
                path_wide.as_ptr(),
                0,
                &mut shfi,
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON,
            );
            
            if result != 0 && shfi.h_icon != 0 {
                if let Some(png_data) = icon_to_png(shfi.h_icon) {
                    DestroyIcon(shfi.h_icon);
                    Some(png_data)
                } else {
                    DestroyIcon(shfi.h_icon);
                    None
                }
            } else {
                None
            }
        }
    }
    
    // 测试函数：验证图标提取功能
    // 输入 .lnk 路径与 .exe 路径各一个，输出 base64 PNG，校验：PNG byte length > 1000 且非零像素数 > 0
    #[cfg(test)]
    pub fn test_icon_extraction(lnk_path: &str, exe_path: &str) -> Result<(bool, bool), String> {
        use std::path::Path;
        
        let lnk_result = Path::new(lnk_path)
            .try_exists()
            .map_err(|e| format!("无法访问 .lnk 文件: {}", e))?;
        
        if !lnk_result {
            return Err(format!(".lnk 文件不存在: {}", lnk_path));
        }
        
        let exe_result = Path::new(exe_path)
            .try_exists()
            .map_err(|e| format!("无法访问 .exe 文件: {}", e))?;
        
        if !exe_result {
            return Err(format!(".exe 文件不存在: {}", exe_path));
        }
        
        // 测试 .lnk 文件图标提取
        let lnk_icon = extract_lnk_icon_base64_native(Path::new(lnk_path));
        let lnk_success = if let Some(icon_data) = lnk_icon {
            // 解码 base64 获取 PNG 数据
            let png_bytes = base64::engine::general_purpose::STANDARD
                .decode(icon_data.strip_prefix("data:image/png;base64,").unwrap_or(&icon_data))
                .map_err(|e| format!("解码 base64 失败: {}", e))?;
            
            // 验证 PNG 数据长度
            if png_bytes.len() < 1000 {
                false
            } else {
                // 解析 PNG 检查非零像素
                let decoder = png::Decoder::new(png_bytes.as_slice());
                let mut reader = decoder.read_info().map_err(|e| format!("解析 PNG 失败: {}", e))?;
                let mut buf = vec![0; reader.output_buffer_size()];
                let info = reader.next_frame(&mut buf).map_err(|e| format!("读取 PNG 帧失败: {}", e))?;
                
                let non_zero_pixels = buf.chunks_exact(4)
                    .filter(|chunk| chunk.iter().any(|&b| b != 0))
                    .count();
                
                non_zero_pixels > 0
            }
        } else {
            false
        };
        
        // 测试 .exe 文件图标提取
        let exe_icon = extract_exe_icon_base64_native(Path::new(exe_path));
        let exe_success = if let Some(icon_data) = exe_icon {
            // 解码 base64 获取 PNG 数据
            let png_bytes = base64::engine::general_purpose::STANDARD
                .decode(icon_data.strip_prefix("data:image/png;base64,").unwrap_or(&icon_data))
                .map_err(|e| format!("解码 base64 失败: {}", e))?;
            
            // 验证 PNG 数据长度
            if png_bytes.len() < 1000 {
                false
            } else {
                // 解析 PNG 检查非零像素
                let decoder = png::Decoder::new(png_bytes.as_slice());
                let mut reader = decoder.read_info().map_err(|e| format!("解析 PNG 失败: {}", e))?;
                let mut buf = vec![0; reader.output_buffer_size()];
                let info = reader.next_frame(&mut buf).map_err(|e| format!("读取 PNG 帧失败: {}", e))?;
                
                let non_zero_pixels = buf.chunks_exact(4)
                    .filter(|chunk| chunk.iter().any(|&b| b != 0))
                    .count();
                
                non_zero_pixels > 0
            }
        } else {
            false
        };
        
        Ok((lnk_success, exe_success))
    }

    // 辅助函数：将位图句柄转换为 PNG base64 字符串（暂时未使用）
    #[allow(dead_code)]
    // 辅助函数：将图标句柄转换为 PNG base64 字符串
    fn icon_to_png(icon_handle: isize) -> Option<String> {
        use windows_sys::Win32::Graphics::Gdi::{
            GetDIBits, CreateCompatibleDC, SelectObject, DeleteObject, DeleteDC,
            BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, BI_RGB, CreateDIBSection, GetDC, ReleaseDC,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{DrawIconEx, DI_NORMAL};

        unsafe {
            // 获取图标尺寸
            let icon_size = ICON_SIZE;
            
            // 创建兼容的 DC
            let hdc_screen = GetDC(0);
            if hdc_screen == 0 {
                return None;
            }

            let hdc = CreateCompatibleDC(hdc_screen);
            if hdc == 0 {
                ReleaseDC(0, hdc_screen);
                return None;
            }

            // 创建位图
            let mut bitmap_info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: icon_size as i32,
                    biHeight: -(icon_size as i32), // 负值表示从上到下的位图
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
                bmiColors: [windows_sys::Win32::Graphics::Gdi::RGBQUAD {
                    rgbBlue: 0,
                    rgbGreen: 0,
                    rgbRed: 0,
                    rgbReserved: 0,
                }; 1],
            };

            let mut bits_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
            let hbitmap = CreateDIBSection(
                hdc,
                &bitmap_info,
                DIB_RGB_COLORS,
                &mut bits_ptr,
                0, // 文件映射对象句柄，NULL 时使用 0
                0,
            ) as isize;

            if hbitmap == 0 {
                DeleteDC(hdc);
                ReleaseDC(0, hdc_screen);
                return None;
            }

            let old_bitmap = SelectObject(hdc, hbitmap);

            // 初始化位图数据为完全透明（alpha=0）
            // 这确保 DrawIconEx 能够正确绘制到透明背景上
            if !bits_ptr.is_null() {
                let size = (icon_size * icon_size * 4) as usize;
                unsafe {
                    std::ptr::write_bytes(bits_ptr, 0, size);
                }
            }

            // 绘制图标到位图
            let icon_size_i32 = icon_size as i32;
            let draw_result = DrawIconEx(
                hdc,
                0,
                0,
                icon_handle,
                icon_size_i32,
                icon_size_i32,
                0,
                0, // 可选的图标句柄，NULL 时使用 0
                DI_NORMAL,
            );
            
            // 读取位图数据
            let mut bitmap = BITMAP {
                bmType: 0,
                bmWidth: icon_size_i32,
                bmHeight: icon_size_i32,
                bmWidthBytes: (icon_size * 4) as i32, // 32位 = 4字节每像素
                bmPlanes: 1,
                bmBitsPixel: 32,
                bmBits: std::ptr::null_mut(),
            };

            let mut dib_bits = vec![0u8; (icon_size * icon_size * 4) as usize];
            let lines_written = GetDIBits(
                hdc_screen,
                hbitmap as isize,
                0,
                icon_size as u32,
                dib_bits.as_mut_ptr() as *mut _,
                &mut bitmap_info,
                DIB_RGB_COLORS,
            );

            SelectObject(hdc, old_bitmap);
            DeleteObject(hbitmap as isize);
            DeleteDC(hdc);
            ReleaseDC(0, hdc_screen);

            if lines_written == 0 {
                return None;
            }

            // 检查位图数据是否包含有效内容（不全为 0）
            let total_pixels = icon_size * icon_size;
            let non_zero_pixels = dib_bits.chunks_exact(4)
                .filter(|chunk| chunk.iter().any(|&b| b != 0))
                .count();

            // 如果所有像素都是 0，说明图标没有正确绘制
            if non_zero_pixels == 0 {
                return None;
            }

            // 将 BGRA 转换为 RGBA，保持透明度
            // 不再强制设置 alpha 通道，保持图标的原始透明度
            for chunk in dib_bits.chunks_exact_mut(4) {
                chunk.swap(0, 2); // B <-> R
                // 保持原始的 alpha 通道值，不强制设置为 255
            }

            // 使用 png crate 编码为 PNG
            let mut png_data = Vec::new();
            {
                let mut encoder = png::Encoder::new(
                    std::io::Cursor::new(&mut png_data),
                    icon_size as u32,
                    icon_size as u32,
                );
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                let mut writer = encoder.write_header().ok()?;
                writer.write_image_data(&dib_bits).ok()?;
            }

            // 验证 PNG 数据长度（一个有效的 32x32 RGBA PNG 应该至少有几百字节）
            if png_data.len() < 200 {
                return None;
            }

            // 编码为 base64
            Some(base64::engine::general_purpose::STANDARD.encode(&png_data))
        }
    }

    // 辅助函数：展开环境变量路径（使用 Rust 实现，不依赖 PowerShell）
    fn expand_env_path(path: &str) -> String {
        use std::env;
        
        // 简单的环境变量展开实现
        let mut result = path.to_string();
        
        // 展开常见环境变量
        let common_vars = [
            ("%windir%", env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".to_string())),
            ("%SystemRoot%", env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string())),
            ("%ProgramFiles%", env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string())),
            ("%ProgramFiles(x86)%", env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".to_string())),
            ("%ProgramData%", env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".to_string())),
            ("%USERPROFILE%", env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\User".to_string())),
            ("%APPDATA%", env::var("APPDATA").unwrap_or_else(|_| "C:\\Users\\User\\AppData\\Roaming".to_string())),
            ("%LOCALAPPDATA%", env::var("LOCALAPPDATA").unwrap_or_else(|_| "C:\\Users\\User\\AppData\\Local".to_string())),
        ];
        
        for (var, value) in &common_vars {
            result = result.replace(var, value);
            result = result.replace(&var.to_lowercase(), value);
        }
        
        // 尝试展开其他环境变量（使用正则表达式匹配 %VAR% 格式）
        // 这里使用简单的字符串替换，对于复杂情况可能需要更完整的实现
        result
    }

    // 辅助函数：将 Known Folder GUID 前缀展开为物理路径（解决 {GUID}\xxx 形式）
    fn expand_known_folder_guid(path: &str) -> String {
        use std::env;

        // 常见 ProgramFiles/Windows GUID 映射
        let mappings = [
            (
                "{6d809377-6af0-444b-8957-a3773f02200e}", // FOLDERID_ProgramFiles (64-bit)
                env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string()),
            ),
            (
                "{7c5a40ef-a0fb-4bfc-874a-c0f2e0b9fa8e}", // FOLDERID_ProgramFilesX86
                env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".to_string()),
            ),
            (
                "{f38bf404-1d43-42f2-9305-67de0b28fc23}", // FOLDERID_Windows
                env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".to_string()),
            ),
            (
                "{1ac14e77-02e7-4e5d-b744-2eb1ae5198b7}", // FOLDERID_System (System32)
                env::var("WINDIR").map(|w| format!("{}\\System32", w)).unwrap_or_else(|_| "C:\\Windows\\System32".to_string()),
            ),
            (
                "{d65231b0-b2f1-4857-a4ce-a8e7c6ea7d27}", // FOLDERID_SystemX86 (SysWOW64)
                env::var("WINDIR").map(|w| format!("{}\\SysWOW64", w)).unwrap_or_else(|_| "C:\\Windows\\SysWOW64".to_string()),
            ),
        ];

        let lower = path.to_ascii_lowercase();
        for (guid, physical) in mappings {
            if lower.starts_with(guid) {
                // 去掉 GUID 前缀，保留后续子路径（通常是 \filename.exe 格式）
                let suffix = &path[guid.len()..];
                // 规范化路径分隔符并拼接
                let suffix = suffix.trim_start_matches('\\').trim_start_matches('/');
                return format!("{}\\{}", physical.trim_end_matches('\\'), suffix);
            }
        }

        path.to_string()
    }

    // 辅助函数：直接解析 .lnk 文件二进制格式获取 IconLocation 和 TargetPath
    // 由于 PowerShell 在约束语言模式下无法工作，我们直接解析 .lnk 文件的二进制格式
    fn get_lnk_icon_location(lnk_path: &Path) -> Option<(PathBuf, i32)> {
        use std::fs::File;
        use std::io::{Read, Seek, SeekFrom};        let mut file = match File::open(lnk_path) {
            Ok(f) => f,
            Err(e) => {                return None;
            }
        };
        
        // 读取 Shell Link Header (76 bytes)
        let mut header = [0u8; 76];
        if file.read_exact(&mut header).is_err() {
            return None;
        }
        
        // 验证 Shell Link Header Signature (0x0000004C)
        if u32::from_le_bytes([header[0], header[1], header[2], header[3]]) != 0x0000004C {            return None;
        }
        
        // LinkFlags (offset 0x14, 4 bytes)
        let link_flags = u32::from_le_bytes([header[20], header[21], header[22], header[23]]);        // 读取 LinkTargetIDList (如果存在)
        let mut offset: u64 = 76;
        if link_flags & 0x01 != 0 {
            // IDListSize (2 bytes)
            let mut idlist_size_buf = [0u8; 2];
            if file.seek(SeekFrom::Start(offset)).is_err() || file.read_exact(&mut idlist_size_buf).is_err() {
                return None;
            }
            let idlist_size = u16::from_le_bytes(idlist_size_buf) as u64;            offset += 2 + idlist_size;
        }
        
        // 读取并解析 LinkInfo (如果存在)
        let mut linkinfo_path: Option<String> = None;
        let linkinfo_start_offset = offset;
        if link_flags & 0x02 != 0 {
            if file.seek(SeekFrom::Start(offset)).is_err() {
                return None;
            }
            let mut linkinfo_size_buf = [0u8; 4];
            if file.read_exact(&mut linkinfo_size_buf).is_err() {
                return None;
            }
            let linkinfo_size = u32::from_le_bytes(linkinfo_size_buf) as u64;            // 解析 LinkInfo 结构
            // LinkInfo 结构：
            // - LinkInfoSize (4 bytes) - 已读取
            // - LinkInfoHeaderSize (4 bytes)
            // - LinkInfoFlags (4 bytes)
            // - VolumeIDOffset (4 bytes)
            // - LocalBasePathOffset (4 bytes)
            // - CommonNetworkRelativeLinkOffset (4 bytes)
            // - CommonPathSuffixOffset (4 bytes)
            // - LocalBasePath (可变长度，UTF-16 字符串)
            // - CommonPathSuffix (可变长度，UTF-16 字符串)
            
            if linkinfo_size >= 28 {
                let mut linkinfo_header = [0u8; 24]; // 读取头部剩余部分（24 bytes）
                if file.read_exact(&mut linkinfo_header).is_ok() {
                    let linkinfo_header_size = u32::from_le_bytes([
                        linkinfo_header[0], linkinfo_header[1], linkinfo_header[2], linkinfo_header[3]
                    ]);
                    let linkinfo_flags = u32::from_le_bytes([
                        linkinfo_header[4], linkinfo_header[5], linkinfo_header[6], linkinfo_header[7]
                    ]);
                    let local_base_path_offset = u32::from_le_bytes([
                        linkinfo_header[12], linkinfo_header[13], linkinfo_header[14], linkinfo_header[15]
                    ]);
                    let common_path_suffix_offset = u32::from_le_bytes([
                        linkinfo_header[20], linkinfo_header[21], linkinfo_header[22], linkinfo_header[23]
                    ]);                    // 读取 LocalBasePath（如果存在）
                    // 注意：偏移量是相对于 LinkInfo 结构开始位置的
                    if local_base_path_offset > 0 && local_base_path_offset < linkinfo_size as u32 {
                        let path_offset = linkinfo_start_offset + local_base_path_offset as u64;                        if file.seek(SeekFrom::Start(path_offset)).is_ok() {
                            // 读取前几个字节用于诊断
                            let mut peek_buf = [0u8; 32];
                            let peek_result = file.read_exact(&mut peek_buf);
                            if peek_result.is_ok() {                            }
                            
                            // 重新定位到路径开始位置
                            // LinkInfo 中的路径是 ANSI 编码，不是 UTF-16
                            if file.seek(SeekFrom::Start(path_offset)).is_ok() {
                                if let Some(local_path) = read_null_terminated_string_ansi(&mut file) {
                                    // 读取 CommonPathSuffix（如果存在）
                                    let mut full_path = local_path.clone();
                                    if common_path_suffix_offset > 0 && common_path_suffix_offset < linkinfo_size as u32 {
                                        let suffix_offset = linkinfo_start_offset + common_path_suffix_offset as u64;                                        if file.seek(SeekFrom::Start(suffix_offset)).is_ok() {
                                            // CommonPathSuffix 也是 ANSI 编码
                                            if let Some(suffix) = read_null_terminated_string_ansi(&mut file) {
                                                full_path = format!("{}{}", full_path, suffix);
                                            }
                                        }
                                    }
                                    
                                    linkinfo_path = Some(full_path.clone());                                } else {                                }
                            }
                        }
                    }
                }
            }
            
            offset += linkinfo_size;
        }
        
        // 读取 StringData
        // StringData 的顺序取决于 LinkFlags，但通常是：
        // 1. CommandLineArguments (如果 HasArguments 0x20 在 LinkFlags 中，但这是错误的，应该是 0x04)
        // 实际上，StringData 的顺序是：
        // - CommandLineArguments (如果 HasArguments 0x04)
        // - IconLocation (如果 HasIconLocation 0x20)
        // - WorkingDir (如果 HasWorkingDir 0x10)
        // - TargetPath (如果 HasLinkInfo 0x02 未设置，或者作为备用)
        
        // 先尝试从 LinkInfo 中获取路径（如果存在）
        // 如果 LinkInfo 存在，它可能包含路径信息
        
        // 读取 StringData 部分
        let mut target_path: Option<String> = None;
        let mut icon_location: Option<String> = None;
        let mut icon_index: i32 = 0;
        
        // 如果从 LinkInfo 中获取了路径，优先使用它作为 target_path
        if let Some(ref linkinfo_path) = linkinfo_path {
            target_path = Some(linkinfo_path.clone());
        }
        
        // 确保在正确的位置读取 StringData
        let stringdata_start = offset;
        if file.seek(SeekFrom::Start(offset)).is_err() {
            return None;
        }        // 读取 CommandLineArguments (如果存在，HasArguments = 0x04)
        if link_flags & 0x04 != 0 {
            let current_pos = file.seek(SeekFrom::Current(0)).ok();
            
            // 诊断：读取 CommandLineArguments 的前几个字节
            let mut peek_buf = [0u8; 32];
            let peek_result = file.read_exact(&mut peek_buf);
            if peek_result.is_ok() {
                use std::os::windows::ffi::OsStringExt;
                
                // 尝试作为 UTF-16 解析
                let mut utf16_chars = Vec::new();
                for i in (0..peek_buf.len()).step_by(2) {
                    if i + 1 < peek_buf.len() {
                        let code_unit = u16::from_le_bytes([peek_buf[i], peek_buf[i + 1]]);
                        if code_unit == 0 {
                            break;
                        }
                        utf16_chars.push(code_unit);
                    }
                }
                let utf16_str = if !utf16_chars.is_empty() {
                    Some(std::ffi::OsString::from_wide(&utf16_chars).to_string_lossy().to_string())
                } else {
                    None
                };            }
            
            // 重新定位到 CommandLineArguments 开始位置
            if let Some(pos) = current_pos {
                if file.seek(SeekFrom::Start(pos)).is_ok() {
                    let _ = read_length_prefixed_string_utf16(&mut file);
                }
            }        }
        
        // 读取 IconLocation (如果存在，HasIconLocation = 0x20)
        if link_flags & 0x20 != 0 {
            let current_pos = file.seek(SeekFrom::Current(0)).ok();
            let icon_location_str = read_length_prefixed_string_utf16(&mut file);            if let Some(mut icon_loc) = icon_location_str {
                // 清理字符串：移除控制字符和无效字符
                let original_len = icon_loc.len();
                icon_loc = icon_loc.chars()
                    .filter(|c| !c.is_control() || *c == '\n' || *c == '\r')
                    .collect::<String>()
                    .trim()
                    .to_string();                // IconLocation 格式通常是 "path,index"
                if let Some(comma_pos) = icon_loc.rfind(',') {
                    let (path_part, index_part) = icon_loc.split_at(comma_pos);
                    let clean_path = path_part.trim().to_string();
                    if !clean_path.is_empty() && clean_path.len() < 260 && !clean_path.chars().any(|c| c.is_control()) {
                        icon_location = Some(clean_path);
                        icon_index = index_part[1..].trim().parse::<i32>().unwrap_or(0);
                    }
                } else {
                    let clean_path = icon_loc.trim().to_string();
                    if !clean_path.is_empty() && clean_path.len() < 260 && !clean_path.chars().any(|c| c.is_control()) {
                        icon_location = Some(clean_path);
                    }
                }
            }
        }
        
        // 读取 WorkingDir (如果存在，HasWorkingDir = 0x10)
        if link_flags & 0x10 != 0 {
            let current_pos = file.seek(SeekFrom::Current(0)).ok();
            let _ = read_length_prefixed_string_utf16(&mut file);        }
        
        // 读取 TargetPath (如果 LinkInfo 不存在，或者作为备用)
        // 注意：如果 LinkInfo 存在，TargetPath 通常在 LinkInfo 中，而不是在 StringData 中
        if link_flags & 0x02 == 0 {
            // 如果没有 LinkInfo，尝试读取 TargetPath
            let current_pos = file.seek(SeekFrom::Current(0)).ok();
            
            // 诊断：读取前几个字节看看内容
            let mut peek_buf = [0u8; 64];
            let peek_result = file.read_exact(&mut peek_buf);
            if peek_result.is_ok() {
                use std::os::windows::ffi::OsStringExt;
                
                // 尝试作为 UTF-16 解析
                let mut utf16_chars = Vec::new();
                for i in (0..peek_buf.len()).step_by(2) {
                    if i + 1 < peek_buf.len() {
                        let code_unit = u16::from_le_bytes([peek_buf[i], peek_buf[i + 1]]);
                        if code_unit == 0 {
                            break;
                        }
                        utf16_chars.push(code_unit);
                    }
                }
                let utf16_str = if !utf16_chars.is_empty() {
                    Some(std::ffi::OsString::from_wide(&utf16_chars).to_string_lossy().to_string())
                } else {
                    None
                };            }
            
            // 重新定位到 TargetPath 开始位置
            if let Some(pos) = current_pos {
                if file.seek(SeekFrom::Start(pos)).is_ok() {
                    let target_path_str = read_length_prefixed_string_utf16(&mut file);                    if target_path.is_none() {
                        target_path = target_path_str;
                    }
                }
            }
        }        
        // 优先使用 IconLocation（如果存在），因为它通常指向正确的图标源文件
        // 对于系统文件夹快捷方式（如 Administrative Tools），IconLocation 通常指向 imageres.dll 或 shell32.dll
        if let Some(ref icon_path_str) = icon_location {
            let expanded_path = expand_env_path(icon_path_str);
            let expanded_path = expand_known_folder_guid(&expanded_path);
            let icon_path = PathBuf::from(&expanded_path);
            // 如果 IconLocation 指向的文件存在，优先使用它
            if icon_path.exists() {
                return Some((icon_path, icon_index));
            }
        }
        
        // 如果 IconLocation 不存在或无效，尝试使用 TargetPath
        if let Some(ref target_path_str) = target_path {
            // 检查是否是 shell:AppsFolder 路径（UWP 应用）
            // 这种路径不需要检查文件是否存在，直接返回即可
            if target_path_str.to_lowercase().starts_with("shell:appsfolder\\") {
                return Some((PathBuf::from(target_path_str), 0));
            }
            
            let expanded_path = expand_env_path(target_path_str);
            let expanded_path = expand_known_folder_guid(&expanded_path);
            let target_path_buf = PathBuf::from(&expanded_path);
            // 只有当 TargetPath 是文件时才使用它（避免使用系统文件夹路径）
            if target_path_buf.exists() && target_path_buf.is_file() {
                return Some((target_path_buf, 0));
            }
        }
        
        None
    }
    
    // 辅助函数：从文件中读取带长度前缀的 UTF-16 字符串（StringData 格式）
    // StringData 格式：CountCharacters (2 bytes) + String (CountCharacters * 2 bytes)
    fn read_length_prefixed_string_utf16(file: &mut std::fs::File) -> Option<String> {
        use std::io::Read;
        use std::os::windows::ffi::OsStringExt;
        
        // 读取字符数量（2 bytes）
        let mut count_buf = [0u8; 2];
        if file.read_exact(&mut count_buf).is_err() {
            return None;
        }
        
        let char_count = u16::from_le_bytes(count_buf) as usize;
        if char_count == 0 {
            return None;
        }
        
        // 读取字符串（CountCharacters * 2 bytes）
        let mut buffer = vec![0u16; char_count];
        for i in 0..char_count {
            let mut pair = [0u8; 2];
            if file.read_exact(&mut pair).is_err() {
                return None;
            }
            buffer[i] = u16::from_le_bytes(pair);
        }
        
        Some(std::ffi::OsString::from_wide(&buffer).to_string_lossy().to_string())
    }
    
    // 辅助函数：从文件中读取以 null 结尾的 UTF-16 字符串（旧版本，保留用于兼容）
    #[allow(dead_code)]
    fn read_null_terminated_string_utf16(file: &mut std::fs::File) -> Option<String> {
        use std::io::Read;
        use std::os::windows::ffi::OsStringExt;
        
        let mut buffer = Vec::new();
        let mut pair = [0u8; 2];
        
        loop {
            if file.read_exact(&mut pair).is_err() {
                return None;
            }
            
            let code_unit = u16::from_le_bytes(pair);
            if code_unit == 0 {
                break;
            }
            buffer.push(code_unit);
        }
        
        if buffer.is_empty() {
            return None;
        }
        
        Some(std::ffi::OsString::from_wide(&buffer).to_string_lossy().to_string())
    }
    
    // 辅助函数：从文件中读取以 null 结尾的 ANSI 字符串（用于 LinkInfo 中的路径）
    fn read_null_terminated_string_ansi(file: &mut std::fs::File) -> Option<String> {
        use std::io::Read;
        
        let mut buffer = Vec::new();
        let mut byte = [0u8; 1];
        
        loop {
            if file.read_exact(&mut byte).is_err() {
                return None;
            }
            
            if byte[0] == 0 {
                break;
            }
            buffer.push(byte[0]);
        }
        
        if buffer.is_empty() {
            return None;
        }
        
        // 将 ANSI 字节转换为字符串（Windows-1252 或 Latin-1 编码）
        // 对于 ASCII 范围（0-127），直接转换即可
        Some(String::from_utf8_lossy(&buffer).to_string())
    }

    // Extract icon from .lnk file target
    // Uses PowerShell with parameter passing to avoid encoding issues
    // Tries IconLocation first, then falls back to TargetPath
    // This is the fallback method - kept for compatibility
    // 提取 .url 文件的图标
    pub fn extract_url_icon_base64(url_path: &Path) -> Option<String> {
        // 解析 .url 文件
        let (target_path, icon_file, icon_index) = match parse_url_file(url_path) {
            Ok(result) => result,
            Err(_) => {
                return None;
            }
        };
        
        // 优先使用 IconFile（如果存在且有效）
        if let Some(icon_path) = &icon_file {
            if icon_path.exists() {
                // 尝试使用 Shell API 提取图标
                if let Some(result) = extract_icon_png_via_shell(icon_path, 32) {
                    return Some(result);
                }
                
                // 回退：使用 ExtractIconExW
                use std::ffi::OsStr;
                use std::os::windows::ffi::OsStrExt;
                use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
                use windows_sys::Win32::UI::Shell::ExtractIconExW;
                use windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon;
                
                unsafe {
                    let hr = CoInitializeEx(std::ptr::null_mut(), COINIT_APARTMENTTHREADED as u32);
                    if hr < 0 && hr != 0x00000001 {
                        return None;
                    }
                }
                
                let icon_path_wide: Vec<u16> = OsStr::new(icon_path)
                    .encode_wide()
                    .chain(Some(0))
                    .collect();
                
                unsafe {
                    let mut large_icons: [isize; 1] = [0; 1];
                    let count = ExtractIconExW(
                        icon_path_wide.as_ptr(),
                        icon_index,
                        large_icons.as_mut_ptr(),
                        std::ptr::null_mut(),
                        1,
                    );
                    
                    if count > 0 && large_icons[0] != 0 {
                        if let Some(png_data) = icon_to_png(large_icons[0]) {
                            DestroyIcon(large_icons[0]);
                            CoUninitialize();
                            return Some(png_data);
                        }
                        DestroyIcon(large_icons[0]);
                    }
                    CoUninitialize();
                }
            }
        }
        
        // 回退：从目标路径提取图标
        if target_path.exists() {
            // 尝试使用 Shell API
            if let Some(result) = extract_icon_png_via_shell(&target_path, 32) {
                return Some(result);
            }
            
            // 回退：根据文件类型使用相应的提取方法
            if let Some(ext) = target_path.extension().and_then(|s| s.to_str()) {
                let ext_lower = ext.to_lowercase();
                if ext_lower == "exe" {
                    if let Some(result) = extract_icon_base64(&target_path) {
                        return Some(result);
                    }
                } else if ext_lower == "lnk" {
                    if let Some(result) = extract_lnk_icon_base64(&target_path) {
                        return Some(result);
                    }
                }
            }
        }
        None
    }

    pub fn extract_lnk_icon_base64(lnk_path: &Path) -> Option<String> {
        // 首先尝试 Native API 方法
        if let Some(result) = extract_lnk_icon_base64_native(lnk_path) {
            return Some(result);
        }

        // 如果 Native API 失败，回退到 PowerShell 方法
        // Convert path to UTF-16 bytes for PowerShell parameter
        let path_utf16: Vec<u16> = lnk_path.to_string_lossy().encode_utf16().collect();
        let path_base64 = base64::engine::general_purpose::STANDARD.encode(
            path_utf16
                .iter()
                .flat_map(|&u| u.to_le_bytes())
                .collect::<Vec<u8>>(),
        );

        // PowerShell script that decodes UTF-16 path and extracts icon from .lnk
        // Uses Shell32 COM object to avoid System.Drawing mixed-mode issues
        let ps_script = r#"
param([string]$LnkPathBase64)

try {
    # Decode UTF-16 path from base64
    $bytes = [Convert]::FromBase64String($LnkPathBase64)
    $lnkPath = [System.Text.Encoding]::Unicode.GetString($bytes)
    
    if (-not (Test-Path -LiteralPath $lnkPath)) {
        exit 1
    }
    
    # Read .lnk file using WScript.Shell COM object
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($lnkPath)
    
    $iconPath = $shortcut.IconLocation
    $targetPath = $shortcut.TargetPath
    
    # Determine which path to use for icon extraction
    $iconSourcePath = $null
    $iconIndex = 0
    
    # Try IconLocation first (custom icon)
    if ($iconPath -and $iconPath -ne '') {
        $iconParts = $iconPath -split ','
        $iconSourcePath = $iconParts[0]
        if ($iconParts.Length -gt 1) {
            $iconIndex = [int]$iconParts[1]
        }
    }
    
    # Fallback to TargetPath if IconLocation is invalid
    if (-not $iconSourcePath -or -not (Test-Path -LiteralPath $iconSourcePath)) {
        if ($targetPath -and (Test-Path -LiteralPath $targetPath)) {
            $iconSourcePath = $targetPath
            $iconIndex = 0
        } else {
            exit 1
        }
    }
    
    # Use Shell32 to extract icon and save to temp ICO file
    # This completely avoids System.Drawing mixed-mode assembly issues
    $tempIco = [System.IO.Path]::GetTempFileName() -replace '\.tmp$', '.ico'
    
    try {
        # Use Shell32 COM to extract icon
        $shellApp = New-Object -ComObject Shell.Application
        $folder = $shellApp.NameSpace((Split-Path -Parent $iconSourcePath))
        $item = $folder.ParseName((Split-Path -Leaf $iconSourcePath))
        
        if ($item -eq $null) {
            exit 1
        }
        
        # Extract icon to temp file using Shell32
        # Note: ExtractIcon method may not be available in all PowerShell versions
        # Fallback: Use WScript.Shell to get icon and save via file system
        
        # Alternative approach: Use ExtractIconEx via P/Invoke or COM
        # For PowerShell 5.1, we'll use a workaround:
        # Get the icon via file association and read it
        
        # Read icon from file using Shell32's GetDetailsOf or similar
        # Since direct icon extraction is complex, we'll use a simpler method:
        # Read the icon resource directly from the file
        
        # Use .NET's Icon class but load from file instead of ExtractAssociatedIcon
        # This avoids the mixed-mode assembly issue
        Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;

public class IconExtractor {
    [DllImport("shell32.dll", CharSet = CharSet.Auto)]
    public static extern int ExtractIconEx(string lpszFile, int nIconIndex, IntPtr[] phiconLarge, IntPtr[] phiconSmall, int nIcons);
    
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool DestroyIcon(IntPtr hIcon);
    
    public static byte[] ExtractIconToPng(string filePath, int iconIndex) {
        IntPtr[] largeIcons = new IntPtr[1];
        int count = ExtractIconEx(filePath, iconIndex, largeIcons, null, 1);
        if (count <= 0 || largeIcons[0] == IntPtr.Zero) {
            return null;
        }
        
        try {
            Icon icon = Icon.FromHandle(largeIcons[0]);
            Bitmap bitmap = icon.ToBitmap();
            // 创建支持透明度的位图（Format32bppArgb 支持 alpha 通道）
            Bitmap resized = new Bitmap(32, 32, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(resized)) {
                // 清除为完全透明（alpha=0），确保位图被正确初始化
                g.Clear(Color.Transparent);
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.DrawImage(bitmap, 0, 0, 32, 32);
            }
            
            using (MemoryStream ms = new MemoryStream()) {
                resized.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
                return ms.ToArray();
            }
        } finally {
            DestroyIcon(largeIcons[0]);
        }
    }
}
"@ -ReferencedAssemblies System.Drawing.dll
        
        $pngBytes = [IconExtractor]::ExtractIconToPng($iconSourcePath, $iconIndex)
        if ($pngBytes -eq $null) {
            # 如果使用指定索引失败，尝试使用索引 0
            if ($iconIndex -ne 0) {
                $pngBytes = [IconExtractor]::ExtractIconToPng($iconSourcePath, 0)
            }
            if ($pngBytes -eq $null) {
                exit 1
            }
        }
        
        [Convert]::ToBase64String($pngBytes)
    } catch {
        exit 1
    } finally {
        if (Test-Path $tempIco) {
            Remove-Item $tempIco -ErrorAction SilentlyContinue
        }
    }
} catch {
    exit 1
}
"#;

        // Write script to temp file
        let temp_script =
            std::env::temp_dir().join(format!("lnk_icon_extract_{}.ps1", std::process::id()));
        std::fs::write(&temp_script, ps_script).ok()?;

        let output = Command::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
            .args(&[
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                temp_script.to_str()?,
                "-LnkPathBase64",
                &path_base64,
            ])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW - 隐藏 PowerShell 窗口
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .ok()?;

        // Clean up temp script
        let _ = std::fs::remove_file(&temp_script);

        if output.status.success() {
            let base64 = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !base64.is_empty() && base64.len() > 100 {
                // 返回纯 base64 字符串，不带 data:image/png;base64, 前缀
                // 前端会统一添加前缀
                return Some(base64);
            }
        }
        None
    }

    // 解析 .url 文件（Internet Shortcut）
    // .url 文件格式类似 INI 文件：
    // [InternetShortcut]
    // URL=file:///C:/path/to/file
    // IconFile=C:\path\to\icon.ico
    // IconIndex=0
    pub fn parse_url_file(url_path: &Path) -> Result<(PathBuf, Option<PathBuf>, i32), String> {
        use std::fs;
        use std::io::BufRead;
        
        let content = fs::read_to_string(url_path)
            .map_err(|e| format!("无法读取 .url 文件: {}", e))?;
        
        let mut url: Option<String> = None;
        let mut icon_file: Option<String> = None;
        let mut icon_index: i32 = 0;
        let mut in_internet_shortcut = false;
        
        for line in content.lines() {
            let line = line.trim();
            
            // 检查是否进入 [InternetShortcut] 部分
            if line == "[InternetShortcut]" {
                in_internet_shortcut = true;
                continue;
            }
            
            // 如果遇到新的部分，停止解析
            if line.starts_with('[') && line.ends_with(']') {
                if in_internet_shortcut {
                    break;
                }
                continue;
            }
            
            if !in_internet_shortcut {
                continue;
            }
            
            // 解析键值对
            if let Some(equal_pos) = line.find('=') {
                let key = line[..equal_pos].trim();
                let value = line[equal_pos + 1..].trim();
                
                match key {
                    "URL" => {
                        url = Some(value.to_string());
                    }
                    "IconFile" => {
                        icon_file = Some(value.to_string());
                    }
                    "IconIndex" => {
                        icon_index = value.parse::<i32>().unwrap_or(0);
                    }
                    _ => {}
                }
            }
        }
        
        // 解析 URL 字段，提取目标路径
        let target_path = if let Some(url_str) = url {
            // 处理 file:/// 协议
            if url_str.starts_with("file:///") {
                // file:///C:/path/to/file -> C:\path\to\file
                let path_part = &url_str[8..]; // 跳过 "file:///"
                let path = path_part.replace('/', "\\");
                PathBuf::from(path)
            } else if url_str.starts_with("file://") {
                // file://C:/path/to/file -> C:\path\to\file
                let path_part = &url_str[7..]; // 跳过 "file://"
                let path = path_part.replace('/', "\\");
                PathBuf::from(path)
            } else {
                // 直接路径
                PathBuf::from(url_str)
            }
        } else {
            return Err("未找到 URL 字段".to_string());
        };
        
        // 解析图标文件路径
        let icon_path = icon_file.map(|p| {
            // 展开环境变量
            let expanded = expand_env_path(&p);
            PathBuf::from(expanded)
        });
        
        Ok((target_path, icon_path, icon_index))
    }

    pub fn parse_lnk_file(lnk_path: &Path) -> Result<AppInfo, String> {
        // Use PowerShell to resolve .lnk file target
        let path_str = lnk_path.to_string_lossy().replace('\'', "''"); // Escape single quotes for PowerShell
        let ps_command = format!(
            r#"$shell = New-Object -ComObject WScript.Shell; $shortcut = $shell.CreateShortcut('{}'); $shortcut.TargetPath"#,
            path_str
        );

        // Add timeout to PowerShell command to avoid hanging
        let output = Command::new("powershell")
            .args(&[
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &ps_command,
            ])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW - 隐藏 PowerShell 窗口
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| format!("Failed to execute PowerShell: {}", e))?;

        if !output.status.success() {
            return Err(format!(
                "Failed to parse .lnk file: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }

        let target_path = String::from_utf8_lossy(&output.stdout).trim().to_string();

        if target_path.is_empty() {
            return Err("Empty target path".to_string());
        }

        // Check if target exists (it might be a relative path)
        let target = if Path::new(&target_path).exists() {
            target_path
        } else {
            // Try to resolve relative to the .lnk file's directory
            if let Some(parent) = lnk_path.parent() {
                let resolved = parent.join(&target_path);
                if resolved.exists() {
                    resolved.to_string_lossy().to_string()
                } else {
                    target_path // Return as-is, might be a system path
                }
            } else {
                target_path
            }
        };

        let name = lnk_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Unknown")
            .to_string();

        // Pre-compute pinyin for faster search (only for Chinese names)
        let (name_pinyin, name_pinyin_initials) = if contains_chinese(&name) {
            (
                Some(to_pinyin(&name).to_lowercase()),
                Some(to_pinyin_initials(&name).to_lowercase()),
            )
        } else {
            (None, None)
        };

        Ok(AppInfo {
            name,
            path: target,
            icon: None,
            description: None,
            name_pinyin,
            name_pinyin_initials,
        })
    }

    // Convert Chinese characters to pinyin (full pinyin)
    fn to_pinyin(text: &str) -> String {
        text.to_pinyin()
            .filter_map(|p| p.map(|p| p.plain()))
            .collect::<Vec<_>>()
            .join("")
    }

    // Convert Chinese characters to pinyin initials (first letter of each pinyin)
    fn to_pinyin_initials(text: &str) -> String {
        text.to_pinyin()
            .filter_map(|p| p.map(|p| p.plain().chars().next()))
            .flatten()
            .collect::<String>()
    }

    // Check if text contains Chinese characters
    fn contains_chinese(text: &str) -> bool {
        text.chars().any(|c| {
            matches!(c as u32,
                0x4E00..=0x9FFF |  // CJK Unified Ideographs
                0x3400..=0x4DBF |  // CJK Extension A
                0x20000..=0x2A6DF | // CJK Extension B
                0x2A700..=0x2B73F | // CJK Extension C
                0x2B740..=0x2B81F | // CJK Extension D
                0xF900..=0xFAFF |  // CJK Compatibility Ideographs
                0x2F800..=0x2FA1F   // CJK Compatibility Ideographs Supplement
            )
        })
    }

    pub fn search_apps(query: &str, apps: &[AppInfo]) -> Vec<AppInfo> {
        if query.is_empty() {
            return apps.iter().take(10).cloned().collect();
        }

        let query_lower = query.to_lowercase();
        let query_is_pinyin = !contains_chinese(&query_lower);

        // Pre-allocate with capacity estimate to reduce allocations
        let mut results: Vec<(usize, i32)> = Vec::with_capacity(MAX_SEARCH_RESULTS);
        
        // Track perfect matches for early exit optimization
        let mut perfect_matches = 0;
        
        // Use indices instead of cloning to avoid expensive clones
        for (idx, app) in apps.iter().enumerate() {
            let mut score = 0;

            // Direct text match (highest priority) - use case-insensitive comparison
            // Optimize: compute to_lowercase once per app name
            let name_lower = app.name.to_lowercase();
            
            if name_lower == query_lower {
                score += 1000;
                perfect_matches += 1;
                results.push((idx, score));
                if perfect_matches >= MAX_PERFECT_MATCHES {
                    break;
                }
            } else if name_lower.starts_with(&query_lower) {
                score += 500;
            } else if name_lower.contains(&query_lower) {
                score += 100;
            }

            // Pinyin matching (if query is pinyin) - use cached pinyin if available
            if query_is_pinyin {
                // Use cached pinyin if available (much faster than computing on the fly)
                if let (Some(ref name_pinyin), Some(ref name_pinyin_initials)) =
                    (&app.name_pinyin, &app.name_pinyin_initials)
                {
                    // Full pinyin match
                    if name_pinyin.as_str() == query_lower {
                        score += 800; // High score for full pinyin match
                        perfect_matches += 1;
                        // Early exit if we have enough perfect matches
                        if perfect_matches >= MAX_PERFECT_MATCHES {
                            results.push((idx, score));
                            break;
                        }
                    } else if name_pinyin.starts_with(&query_lower) {
                        score += 400;
                    } else if name_pinyin.contains(&query_lower) {
                        score += 150;
                    }

                    // Pinyin initials match
                    if name_pinyin_initials.as_str() == query_lower {
                        score += 600; // High score for initials match
                    } else if name_pinyin_initials.starts_with(&query_lower) {
                        score += 300;
                    } else if name_pinyin_initials.contains(&query_lower) {
                        score += 120;
                    }
                }
            }

            // Description match (check if query matches description, e.g., "系统设置" matches "Windows 系统设置")
            if score == 0 {
                if let Some(ref description) = app.description {
                    let desc_lower = description.to_lowercase();
                    if desc_lower.contains(&query_lower) {
                        score += 150; // Description match gets higher score than path match
                    }
                }
            }
            
            // Path match gets lower score (only check if no name or description match to save time)
            // Use case-insensitive comparison without allocating new string
            if score == 0 && app.path.len() >= query.len() {
                if app.path.to_lowercase().contains(&query_lower) {
                    score += 10;
                }
            }

            if score > 0 {
                results.push((idx, score));
            }
        }

        // If we have perfect matches and early exited, return them immediately without sorting
        let final_results: Vec<AppInfo> = if perfect_matches >= MAX_PERFECT_MATCHES && results.len() <= MAX_PERFECT_MATCHES {
            results
                .into_iter()
                .map(|(idx, _)| apps[idx].clone())
                .collect()
        } else {
            // Sort by score (descending) only if we need to
            results.sort_by(|a, b| b.1.cmp(&a.1));

            // Limit to top results for performance, clone only the selected apps
            results
                .into_iter()
                .take(MAX_SEARCH_RESULTS)
                .map(|(idx, _)| apps[idx].clone())
                .collect()
        };
        
        final_results
    }

    /// 与索引中已有条目的路径比较（不区分大小写、统一斜杠）。
    pub fn normalize_path_for_index(path: &str) -> String {
        path.trim().to_lowercase().replace('\\', "/")
    }

    /// 根据用户输入的路径构建 `AppInfo`：校验本地路径存在，或为 `ms-settings:` / `shell:AppsFolder\` 等特殊启动串。
    pub fn app_info_for_manual_entry(path: &str, display_name: Option<&str>) -> Result<AppInfo, String> {
        let path_str = path.trim();
        if path_str.is_empty() {
            return Err("路径不能为空".to_string());
        }
        let path_lower = path_str.to_lowercase();

        if path_lower.starts_with("ms-settings:") || path_lower.starts_with("shell:appsfolder\\") {
            let name = display_name
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .ok_or_else(|| "此类路径需要填写显示名称".to_string())?;
            let (name_pinyin, name_pinyin_initials) = if contains_chinese(&name) {
                (
                    Some(to_pinyin(&name).to_lowercase()),
                    Some(to_pinyin_initials(&name).to_lowercase()),
                )
            } else {
                (None, None)
            };
            return Ok(AppInfo {
                name,
                path: path_str.to_string(),
                icon: None,
                description: None,
                name_pinyin,
                name_pinyin_initials,
            });
        }

        let p = Path::new(path_str);
        if !p.exists() {
            return Err(format!("路径不存在或无法访问: {}", path_str));
        }

        let name = if let Some(dn) = display_name.map(str::trim).filter(|s| !s.is_empty()) {
            dn.to_string()
        } else {
            p.file_stem()
                .and_then(|s| s.to_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .ok_or_else(|| "无法从路径推断显示名称，请手动填写".to_string())?
        };

        let (name_pinyin, name_pinyin_initials) = if contains_chinese(&name) {
            (
                Some(to_pinyin(&name).to_lowercase()),
                Some(to_pinyin_initials(&name).to_lowercase()),
            )
        } else {
            (None, None)
        };

        Ok(AppInfo {
            name,
            path: path_str.to_string(),
            icon: None,
            description: None,
            name_pinyin,
            name_pinyin_initials,
        })
    }

    pub fn launch_app(app: &AppInfo) -> Result<(), String> {
        use std::process::Command;
        use std::os::windows::process::CommandExt;

        let path_str = app.path.trim();
        let path_lower = path_str.to_lowercase();
        
        // Special handling for ms-settings: URI (Windows Settings app)
        if path_lower.starts_with("ms-settings:") {
            Command::new("cmd")
                .args(&["/c", "start", "", path_str])
                .creation_flags(0x08000000) // CREATE_NO_WINDOW - 不显示控制台窗口
                .spawn()
                .map_err(|e| format!("Failed to open Windows Settings: {}", e))?;
            
            return Ok(());
        }
        
        // Special handling for shell:AppsFolder URIs
        if path_lower.starts_with("shell:appsfolder") {
            // Use cmd /c start to ensure proper environment variables are inherited
            let result = Command::new("cmd")
                .args(&["/c", "start", "", path_str])
                .creation_flags(0x08000000)
                .spawn();
            
            match result {
                Ok(_) => return Ok(()),
                Err(_) => {
                    // If cmd /c start fails, try fallback to ms-settings: for Windows Settings
                    if path_str.contains("Microsoft.Windows.Settings") {
                        Command::new("cmd")
                            .args(&["/c", "start", "", "ms-settings:"])
                            .creation_flags(0x08000000)
                            .spawn()
                            .map_err(|e| format!("Failed to open Windows Settings (fallback): {}", e))?;
                        
                        return Ok(());
                    } else {
                        return Err(format!("Failed to launch application: {}", app.path));
                    }
                }
            }
        }
        
        let path = Path::new(path_str);
        // 检查是否为快捷方式文件（不区分大小写）
        let is_lnk = path.extension()
            .and_then(|s| s.to_str())
            .map(|ext| ext.to_lowercase() == "lnk")
            .unwrap_or(false);
        
        // 对于快捷方式，验证目标是否存在
        let mut parse_error: Option<String> = None;
        if is_lnk {
            // 检查快捷方式文件是否存在
            if !path.exists() {
                return Err(format!("快捷方式文件不存在: {}", app.path));
            }
            
            // 解析快捷方式，检查目标是否存在
            match parse_lnk_file(path) {
                Ok(target_info) => {
                    let target_path = Path::new(&target_info.path);
                    if !target_path.exists() {
                        return Err(format!(
                            "快捷方式目标不存在: 快捷方式 '{}' 指向的目标 '{}' 已移动或删除。请更新或重新创建该快捷方式。",
                            app.path, target_info.path
                        ));
                    }
                }
                Err(e) => {
                    parse_error = Some(e.clone());
                    // 继续尝试直接启动
                }
            }
        } else if !path.exists() {
            return Err(format!("应用程序未找到: {}", app.path));
        }

        // 批处理默认工作目录为「本软件进程」的 CWD，与同目录下相对路径（如 start "" "某.exe"）不匹配；
        // 资源管理器双击 bat 时 CWD 为 bat 所在目录。用 start /D 指定启动目录以对齐该行为。
        let is_batch = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|ext| {
                let e = ext.to_lowercase();
                e == "bat" || e == "cmd"
            })
            .unwrap_or(false);

        // Use cmd /c start to launch application with proper environment variables
        // This ensures that launched applications (like Cursor) inherit the full user environment
        // variables (including PATH with cargo), matching the behavior of launching from Start Menu
        let spawn_result = if is_batch {
            match path.parent().and_then(|p| p.to_str()) {
                Some(work_dir) => Command::new("cmd")
                    .args(&["/c", "start", "", "/D", work_dir, path_str])
                    .creation_flags(0x08000000) // CREATE_NO_WINDOW - 不显示控制台窗口
                    .spawn(),
                None => {
                    return Err(format!(
                        "无法确定批处理文件所在目录: {}",
                        app.path
                    ));
                }
            }
        } else {
            Command::new("cmd")
                .args(&["/c", "start", "", path_str])
                .creation_flags(0x08000000) // CREATE_NO_WINDOW - 不显示控制台窗口
                .spawn()
        };

        match spawn_result {
            Ok(_) => Ok(()),
            Err(e) => {
                // 构建详细的错误信息
                let error_msg = if is_lnk {
                    let additional_info = if let Some(parse_err) = parse_error {
                        format!(" (无法解析快捷方式: {})", parse_err)
                    } else {
                        match parse_lnk_file(path) {
                            Ok(target_info) => {
                                format!(" (目标路径: {})", target_info.path)
                            }
                            Err(parse_e) => {
                                format!(" (无法解析快捷方式: {})", parse_e)
                            }
                        }
                    };
                    
                    format!(
                        "启动应用程序失败: {} - {}\n\n这通常意味着快捷方式指向的目标文件不存在或已移动。{}\n\n建议：请检查快捷方式属性，确认目标路径是否正确，或重新创建该快捷方式。",
                        app.path, e, additional_info
                    )
                } else {
                    format!("启动应用程序失败: {} - {}", app.path, e)
                };
                
                Err(error_msg)
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub mod windows {
    use super::*;

    pub fn scan_start_menu() -> Result<Vec<AppInfo>, String> {
        Err("App search is only supported on Windows".to_string())
    }

    pub fn search_apps(_query: &str, _apps: &[AppInfo]) -> Vec<AppInfo> {
        vec![]
    }

    pub fn launch_app(_app: &AppInfo) -> Result<(), String> {
        Err("App launch is only supported on Windows".to_string())
    }

    pub fn normalize_path_for_index(path: &str) -> String {
        path.trim().to_lowercase().replace('\\', "/")
    }

    pub fn app_info_for_manual_entry(_path: &str, _display_name: Option<&str>) -> Result<AppInfo, String> {
        Err("App search is only supported on Windows".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_contains_chinese() {
        assert!(windows::contains_chinese("你好"));
        assert!(windows::contains_chinese("Hello 世界"));
        assert!(!windows::contains_chinese("Hello"));
        assert!(!windows::contains_chinese("123"));
    }

    #[test]
    fn test_search_apps_exact_match() {
        let apps = vec![
            AppInfo {
                name: "微信".to_string(),
                path: "C:\\WeChat.exe".to_string(),
                icon: None,
                description: None,
                name_pinyin: Some("weixin".to_string()),
                name_pinyin_initials: Some("wx".to_string()),
            },
            AppInfo {
                name: "QQ".to_string(),
                path: "C:\\QQ.exe".to_string(),
                icon: None,
                description: None,
                name_pinyin: None,
                name_pinyin_initials: None,
            },
        ];

        let results = windows::search_apps("微信", &apps);
        assert!(!results.is_empty());
        assert_eq!(results[0].name, "微信");
    }

    #[test]
    fn test_search_apps_pinyin_match() {
        let apps = vec![
            AppInfo {
                name: "微信".to_string(),
                path: "C:\\WeChat.exe".to_string(),
                icon: None,
                description: None,
                name_pinyin: Some("weixin".to_string()),
                name_pinyin_initials: Some("wx".to_string()),
            },
        ];

        let results = windows::search_apps("weixin", &apps);
        assert!(!results.is_empty());
        assert_eq!(results[0].name, "微信");
    }

    #[test]
    fn test_search_apps_pinyin_initials_match() {
        let apps = vec![
            AppInfo {
                name: "微信".to_string(),
                path: "C:\\WeChat.exe".to_string(),
                icon: None,
                description: None,
                name_pinyin: Some("weixin".to_string()),
                name_pinyin_initials: Some("wx".to_string()),
            },
        ];

        let results = windows::search_apps("wx", &apps);
        assert!(!results.is_empty());
        assert_eq!(results[0].name, "微信");
    }

    #[test]
    fn test_search_apps_partial_match() {
        let apps = vec![
            AppInfo {
                name: "Chrome Browser".to_string(),
                path: "C:\\Chrome.exe".to_string(),
                icon: None,
                description: None,
                name_pinyin: None,
                name_pinyin_initials: None,
            },
        ];

        let results = windows::search_apps("Chrome", &apps);
        assert!(!results.is_empty());
        assert!(results[0].name.contains("Chrome"));
    }

    #[test]
    fn test_search_apps_empty_query() {
        let apps = vec![
            AppInfo {
                name: "App1".to_string(),
                path: "C:\\App1.exe".to_string(),
                icon: None,
                description: None,
                name_pinyin: None,
                name_pinyin_initials: None,
            },
            AppInfo {
                name: "App2".to_string(),
                path: "C:\\App2.exe".to_string(),
                icon: None,
                description: None,
                name_pinyin: None,
                name_pinyin_initials: None,
            },
        ];

        let results = windows::search_apps("", &apps);
        assert_eq!(results.len(), 2.min(10)); // Should return up to 10 apps
    }

    #[test]
    fn test_search_apps_no_match() {
        let apps = vec![
            AppInfo {
                name: "App1".to_string(),
                path: "C:\\App1.exe".to_string(),
                icon: None,
                description: None,
                name_pinyin: None,
                name_pinyin_initials: None,
            },
        ];

        let results = windows::search_apps("NonExistent", &apps);
        assert!(results.is_empty());
    }

    #[test]
    fn test_search_apps_prioritizes_exact_match() {
        let apps = vec![
            AppInfo {
                name: "Chrome Browser".to_string(),
                path: "C:\\Chrome.exe".to_string(),
                icon: None,
                description: None,
                name_pinyin: None,
                name_pinyin_initials: None,
            },
            AppInfo {
                name: "Chrome".to_string(),
                path: "C:\\ChromeShort.exe".to_string(),
                icon: None,
                description: None,
                name_pinyin: None,
                name_pinyin_initials: None,
            },
        ];

        let results = windows::search_apps("Chrome", &apps);
        assert!(!results.is_empty());
        // Exact match should be prioritized
        assert_eq!(results[0].name, "Chrome");
    }
}