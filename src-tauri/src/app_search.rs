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
    use std::os::windows::process::CommandExt;

    // Cache file name
    pub fn get_cache_file_path(app_data_dir: &Path) -> PathBuf {
        app_data_dir.join("app_cache.json")
    }

    // Load cached apps from disk
    pub fn load_cache(app_data_dir: &Path) -> Result<Vec<AppInfo>, String> {
        let cache_file = get_cache_file_path(app_data_dir);

        if !cache_file.exists() {
            return Ok(Vec::new());
        }

        let content = fs::read_to_string(&cache_file)
            .map_err(|e| format!("Failed to read cache file: {}", e))?;

        let apps: Vec<AppInfo> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse cache file: {}", e))?;

        Ok(apps)
    }

    // Save apps cache to disk
    pub fn save_cache(app_data_dir: &Path, apps: &[AppInfo]) -> Result<(), String> {
        // Create directory if it doesn't exist
        if !app_data_dir.exists() {
            fs::create_dir_all(app_data_dir)
                .map_err(|e| format!("Failed to create app data directory: {}", e))?;
        }

        let cache_file = get_cache_file_path(app_data_dir);
        let json_string = serde_json::to_string_pretty(apps)
            .map_err(|e| format!("Failed to serialize cache: {}", e))?;

        fs::write(&cache_file, json_string)
            .map_err(|e| format!("Failed to write cache file: {}", e))?;

        Ok(())
    }

    // Windows-specific implementation
    pub fn scan_start_menu() -> Result<Vec<AppInfo>, String> {
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

        // Scan start menu paths
        for start_menu_path in start_menu_paths.into_iter().flatten() {
            if start_menu_path.exists() {
                // Start scanning from depth 0, limit to 3 levels for better coverage
                if let Err(e) = scan_directory(&start_menu_path, &mut apps, 0) {
                    eprintln!("[DEBUG] Error scanning {:?}: {}", start_menu_path, e);
                    // Continue on error
                } else {
                    eprintln!("[DEBUG] Scanned {:?}, found {} apps so far", start_menu_path, apps.len());
                }
            } else {
                eprintln!("[DEBUG] Path does not exist: {:?}", start_menu_path);
            }
        }

        // Scan desktop paths (only scan depth 0 for desktop, no recursion)
        for desktop_path in desktop_paths.into_iter().flatten() {
            if desktop_path.exists() {
                if let Err(e) = scan_directory(&desktop_path, &mut apps, 0) {
                    eprintln!("[DEBUG] Error scanning desktop {:?}: {}", desktop_path, e);
                    // Continue on error
                } else {
                    eprintln!("[DEBUG] Scanned desktop {:?}, found {} apps so far", desktop_path, apps.len());
                }
            } else {
                eprintln!("[DEBUG] Desktop path does not exist: {:?}", desktop_path);
            }
        }

        // Scan Microsoft Store / UWP apps via Get-StartApps (shell:AppsFolder targets)
        match scan_uwp_apps() {
            Ok(mut uwp_apps) => {
                let before = apps.len();
                apps.append(&mut uwp_apps);
                eprintln!(
                    "[DEBUG] Added {} UWP apps from Get-StartApps, total so far {}",
                    apps.len().saturating_sub(before),
                    apps.len()
                );
            }
            Err(e) => {
                eprintln!("[DEBUG] Failed to scan UWP apps: {}", e);
            }
        }

        eprintln!("[DEBUG] Total apps found before dedup: {}", apps.len());

        // Remove duplicates based on path (more accurate than name)
        apps.sort_by(|a, b| a.path.cmp(&b.path));
        apps.dedup_by(|a, b| a.path == b.path);

        // If still duplicates by name, keep the one with better launch target
        // Prefer real executables/shortcuts (with icons) over shell:AppsFolder URIs
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
        apps.dedup_by(|a, b| a.name == b.name);

        eprintln!("[DEBUG] Total apps after dedup: {}", apps.len());
        
        // Debug: Check if Cursor is in the list
        if let Some(cursor_app) = apps.iter().find(|a| a.name.to_lowercase().contains("cursor")) {
            eprintln!("[DEBUG] Found Cursor: name={}, path={}", cursor_app.name, cursor_app.path);
        } else {
            eprintln!("[DEBUG] Cursor not found in scanned apps");
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

    /// Enumerate Microsoft Store / UWP apps using PowerShell Get-StartApps.
    /// Produces shell:AppsFolder targets so they can be launched via ShellExecute.
    fn scan_uwp_apps() -> Result<Vec<AppInfo>, String> {
        fn decode_powershell_output(bytes: &[u8]) -> Result<String, String> {
            if bytes.is_empty() {
                return Ok(String::new());
            }

            // PowerShell 5 默认 UTF-16LE，无 BOM 时也尝试按 UTF-16LE 解析
            if bytes.len() % 2 == 0 {
                let has_bom = bytes.starts_with(&[0xFF, 0xFE]);
                let utf16_units: Vec<u16> = bytes
                    .chunks(2)
                    .skip(if has_bom { 1 } else { 0 })
                    .map(|c| u16::from_le_bytes([c[0], c.get(1).copied().unwrap_or(0)]))
                    .collect();

                if let Ok(s) = String::from_utf16(&utf16_units) {
                    return Ok(s);
                }
            }

            String::from_utf8(bytes.to_vec())
                .map_err(|e| format!("Failed to decode PowerShell output: {}", e))
        }

        // PowerShell script: list Name/AppID and convert to JSON
        let script = r#"
        try {
            $apps = Get-StartApps | Where-Object { $_.AppId -and $_.Name }
            $apps | Select-Object Name, AppId | ConvertTo-Json -Depth 3
        } catch {
            Write-Error $_
        }
        "#;

        let output = Command::new("powershell")
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .arg("-NoLogo")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-Command")
            .arg(script)
            .output()
            .map_err(|e| format!("Failed to run PowerShell: {}", e))?;

        if !output.status.success() {
            let stderr = decode_powershell_output(&output.stderr)?;
            return Err(format!("PowerShell Get-StartApps failed: {}", stderr));
        }

        let stdout = decode_powershell_output(&output.stdout)?;
        let stdout_trimmed = stdout.trim();
        if stdout_trimmed.is_empty() {
            return Ok(Vec::new());
        }

        // Handle both array and single-object JSON outputs
        let entries: Vec<StartAppEntry> = serde_json::from_str(stdout_trimmed)
            .or_else(|_| serde_json::from_str::<StartAppEntry>(stdout_trimmed).map(|e| vec![e]))
            .map_err(|e| format!("Failed to parse Get-StartApps JSON: {}", e))?;

        let mut apps = Vec::with_capacity(entries.len());
        for entry in entries {
            let name = entry.name.trim();
            let app_id = entry.app_id.trim();
            if name.is_empty() || app_id.is_empty() {
                continue;
            }

            let path = format!("shell:AppsFolder\\{}", app_id);
            let name_string = name.to_string();
            let (name_pinyin, name_pinyin_initials) = if contains_chinese(name) {
                (
                    Some(to_pinyin(name).to_lowercase()),
                    Some(to_pinyin_initials(name).to_lowercase()),
                )
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

        Ok(apps)
    }

    fn scan_directory(dir: &Path, apps: &mut Vec<AppInfo>, depth: usize) -> Result<(), String> {
        // Limit recursion depth to avoid scanning too deep (increased to 3 for better coverage)
        const MAX_DEPTH: usize = 3;
        if depth > MAX_DEPTH {
            return Ok(());
        }

        // Limit total number of apps to avoid memory issues (increased to 2000)
        const MAX_APPS: usize = 2000;
        if apps.len() >= MAX_APPS {
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

            if path.is_dir() {
                // Recursively scan subdirectories
                if let Err(_) = scan_directory(&path, apps, depth + 1) {
                    // Continue on error
                }
            } else if path
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_lowercase())
                == Some("lnk".to_string())
            {
                // Fast path: use .lnk filename directly without parsing
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
            } else if path
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_lowercase())
                == Some("exe".to_string())
            {
                // Direct executable - don't extract icon during scan to keep it fast
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

        Ok(())
    }

    // Extract icon from file and convert to base64 PNG
    // Uses PowerShell with parameter passing to avoid encoding issues
    pub fn extract_icon_base64(file_path: &Path) -> Option<String> {
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
    
    # Convert icon to PNG using GDI+
    Add-Type -AssemblyName System.Drawing
    $icon = [System.Drawing.Icon]::FromHandle($iconPath.Handle)
    $bitmap = $icon.ToBitmap()
    $ms = New-Object System.IO.MemoryStream
    $bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $ms.Close()
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
                return Some(format!("data:image/png;base64,{}", base64));
            }
        } else {
            // Log error details for debugging
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            eprintln!(
                "[图标提取失败] .exe 文件: {:?}, 退出码: {:?}, stderr: {}, stdout: {}",
                file_path,
                output.status.code(),
                stderr,
                stdout
            );
        }
        None
    }

    // Extract icon from .lnk file target
    // Uses PowerShell with parameter passing to avoid encoding issues
    // Tries IconLocation first, then falls back to TargetPath
    pub fn extract_lnk_icon_base64(lnk_path: &Path) -> Option<String> {
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
            Bitmap resized = new Bitmap(32, 32);
            using (Graphics g = Graphics.FromImage(resized)) {
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
                return Some(format!("data:image/png;base64,{}", base64));
            }
        } else {
            // Log error details for debugging
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            eprintln!(
                "[图标提取失败] .lnk 文件: {:?}, 退出码: {:?}, stderr: {}, stdout: {}",
                lnk_path,
                output.status.code(),
                stderr,
                stdout
            );
        }
        None
    }

    fn parse_lnk_file(lnk_path: &Path) -> Result<AppInfo, String> {
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
        let mut results: Vec<(usize, i32)> = Vec::with_capacity(20);
        
        // Track perfect matches for early exit optimization
        let mut perfect_matches = 0;
        const MAX_PERFECT_MATCHES: usize = 5; // Early exit if we find 5 perfect matches
        const MAX_RESULTS_TO_CHECK: usize = 500; // Limit the number of apps to check

        // Use indices instead of cloning to avoid expensive clones
        for (idx, app) in apps.iter().enumerate().take(MAX_RESULTS_TO_CHECK) {
            let mut score = 0;

            // Direct text match (highest priority) - use case-insensitive comparison
            let name_lower = app.name.to_lowercase();
            if name_lower == query_lower {
                score += 1000;
                perfect_matches += 1;
                // Early exit if we have enough perfect matches and already have enough results
                if perfect_matches >= MAX_PERFECT_MATCHES && results.len() >= 10 {
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
                        if perfect_matches >= MAX_PERFECT_MATCHES && results.len() >= 10 {
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
                // If no cached pinyin, skip pinyin matching (app name likely doesn't contain Chinese)
            }

            // Path match gets lower score (only check if no name match to save time)
            if score == 0 {
                let path_lower = app.path.to_lowercase();
                if path_lower.contains(&query_lower) {
                    score += 10;
                }
            }

            if score > 0 {
                results.push((idx, score));
            }
        }

        // Sort by score (descending)
        results.sort_by(|a, b| b.1.cmp(&a.1));

        // Limit to top 20 results for performance, clone only the selected apps
        results
            .into_iter()
            .take(20)
            .map(|(idx, _)| apps[idx].clone())
            .collect()
    }

    pub fn launch_app(app: &AppInfo) -> Result<(), String> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;

        let path_str = app.path.trim();
        let path = Path::new(path_str);
        let is_shell_uri = path_str.to_lowercase().starts_with("shell:appsfolder");

        // For shell:AppsFolder URIs, skip filesystem existence checks
        if !is_shell_uri {
            let is_lnk = path.extension().and_then(|s| s.to_str()) == Some("lnk");
            if !is_lnk && !path.exists() {
                return Err(format!("Application not found: {}", app.path));
            }
        }

        // Convert path (or shell URI) to wide string (UTF-16) for Windows API
        let path_wide: Vec<u16> = OsStr::new(path_str)
            .encode_wide()
            .chain(Some(0))
            .collect();

        // Use ShellExecuteW to open application without showing command prompt
        // This works for .exe, .lnk, shell:AppsFolder URIs, and other executable types
        let result = unsafe {
            ShellExecuteW(
                0, // hwnd - no parent window
                std::ptr::null(), // lpOperation - NULL means "open"
                path_wide.as_ptr(), // lpFile
                std::ptr::null(), // lpParameters
                std::ptr::null(), // lpDirectory
                1, // nShowCmd - SW_SHOWNORMAL (1)
            )
        };
        
        // ShellExecuteW returns a value > 32 on success
        if result as i32 <= 32 {
            return Err(format!("Failed to launch application: {} (error code: {})", app.path, result as i32));
        }

        Ok(())
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
}
