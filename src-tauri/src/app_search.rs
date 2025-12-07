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
    use std::os::windows::process::CommandExt;    // Cache file name
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
    pub fn scan_start_menu(tx: Option<std::sync::mpsc::Sender<(u8, String)>>) -> Result<Vec<AppInfo>, String> {
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

        if let Some(ref tx) = tx {
            let _ = tx.send((5, "开始扫描应用...".to_string()));
        }

        // Scan start menu paths
        let start_menu_count = start_menu_paths.len();
        for (idx, start_menu_path) in start_menu_paths.into_iter().flatten().enumerate() {
            if start_menu_path.exists() {
                if let Some(ref tx) = tx {
                    let path_name = start_menu_path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("开始菜单")
                        .to_string();
                    let _ = tx.send((10 + (idx as u8 * 15), format!("正在扫描: {}", path_name)));
                }
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
        if let Some(ref tx) = tx {
            let _ = tx.send((60, "正在扫描桌面...".to_string()));
        }
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
        if let Some(ref tx) = tx {
            let _ = tx.send((70, "正在扫描 Microsoft Store 应用...".to_string()));
        }
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

        if let Some(ref tx) = tx {
            let _ = tx.send((80, format!("找到 {} 个应用，正在去重...", apps.len())));
        }

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
        
        if let Some(ref tx) = tx {
            let _ = tx.send((95, format!("去重完成，共 {} 个应用", apps.len())));
        }
        
        // Debug: Check if Cursor is in the list
        if let Some(cursor_app) = apps.iter().find(|a| a.name.to_lowercase().contains("cursor")) {
            eprintln!("[DEBUG] Found Cursor: name={}, path={}", cursor_app.name, cursor_app.path);
        } else {
            eprintln!("[DEBUG] Cursor not found in scanned apps");
        }

        if let Some(ref tx) = tx {
            let _ = tx.send((100, "扫描完成".to_string()));
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

    // Extract icon from .lnk file using Native Windows API
    // This is the new implementation using Rust + Windows API directly
    // Falls back to PowerShell method if Native API fails
    pub fn extract_lnk_icon_base64_native(lnk_path: &Path) -> Option<String> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
        use windows_sys::Win32::UI::Shell::ExtractIconExW;
        use windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon;

        // 初始化 COM（单线程模式，用于 COM 接口）
        unsafe {
            let hr = CoInitializeEx(std::ptr::null_mut(), COINIT_APARTMENTTHREADED as u32);
            if hr < 0 {
                eprintln!("[Native API] COM 初始化失败: {}", hr);
                return None;
            }
        }

        let result = (|| -> Option<String> {            // 方法 1: 尝试解析 .lnk 文件获取 IconLocation
            // 使用 PowerShell 快速获取 IconLocation 和 TargetPath（这部分很快，只是读取元数据）
            let (icon_source_path, icon_index) = match get_lnk_icon_location(lnk_path) {
                Some(result) => result,
                None => {
                    eprintln!("[图标提取] 无法获取 IconLocation: {:?}", lnk_path);                    return None;
                }
            };

            eprintln!("[图标提取] 尝试从路径提取图标: {:?}, 索引: {}", icon_source_path, icon_index);            // 使用 ExtractIconExW 从目标文件提取图标
            let icon_source_wide: Vec<u16> = OsStr::new(&icon_source_path)
                .encode_wide()
                .chain(Some(0))
                .collect();            unsafe {
                let mut large_icons: [isize; 1] = [0; 1];
                let count = ExtractIconExW(
                    icon_source_wide.as_ptr(),
                    icon_index as i32,
                    large_icons.as_mut_ptr(),
                    std::ptr::null_mut(),
                    1,
                );

                eprintln!("[图标提取] ExtractIconExW 返回: count={}, handle={:?}", count, large_icons[0]);                if count > 0 && large_icons[0] != 0 {
                    if let Some(png_data) = icon_to_png(large_icons[0]) {
                        // 清理图标句柄
                        DestroyIcon(large_icons[0]);
                        eprintln!("[图标提取] 成功提取图标: {:?}", icon_source_path);                        return Some(format!("data:image/png;base64,{}", png_data));
                    } else {
                        eprintln!("[图标提取] icon_to_png 失败: {:?}", icon_source_path);                    }
                    // 清理图标句柄
                    DestroyIcon(large_icons[0]);
                } else {
                    eprintln!("[图标提取] ExtractIconExW 失败: count={}, handle={:?}", count, large_icons[0]);                }

                // 如果指定索引失败，尝试索引 0
                if icon_index != 0 {
                    eprintln!("[图标提取] 尝试使用索引 0: {:?}", icon_source_path);
                    let mut large_icons: [isize; 1] = [0; 1];
                    let count = ExtractIconExW(
                        icon_source_wide.as_ptr(),
                        0,
                        large_icons.as_mut_ptr(),
                        std::ptr::null_mut(),
                        1,
                    );

                    eprintln!("[图标提取] ExtractIconExW (索引 0) 返回: count={}, handle={:?}", count, large_icons[0]);

                    if count > 0 && large_icons[0] != 0 {
                        if let Some(png_data) = icon_to_png(large_icons[0]) {
                            DestroyIcon(large_icons[0]);
                            eprintln!("[图标提取] 成功提取图标 (索引 0): {:?}", icon_source_path);
                            return Some(format!("data:image/png;base64,{}", png_data));
                        } else {
                            eprintln!("[图标提取] icon_to_png 失败 (索引 0): {:?}", icon_source_path);
                        }
                        DestroyIcon(large_icons[0]);
                    }
                }
            }

            eprintln!("[图标提取] 所有方法都失败: {:?}", icon_source_path);            None
        })();

        // 清理 COM
        unsafe {
            CoUninitialize();
        }

        result
    }

    // 辅助函数：将图标句柄转换为 PNG base64 字符串
    fn icon_to_png(icon_handle: isize) -> Option<String> {
        use windows_sys::Win32::Graphics::Gdi::{
            GetDIBits, CreateCompatibleDC, SelectObject, DeleteObject, DeleteDC,
            BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, BI_RGB, CreateDIBSection, GetDC, ReleaseDC,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{DrawIconEx, DI_NORMAL};

        unsafe {
            // 获取图标尺寸（通常为 32x32 或系统默认）
            let icon_size = 32;
            
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

            // 绘制图标到位图
            DrawIconEx(
                hdc,
                0,
                0,
                icon_handle,
                icon_size,
                icon_size,
                0,
                0, // 可选的图标句柄，NULL 时使用 0
                DI_NORMAL,
            );

            // 读取位图数据
            let mut bitmap = BITMAP {
                bmType: 0,
                bmWidth: icon_size,
                bmHeight: icon_size,
                bmWidthBytes: icon_size * 4, // 32位 = 4字节每像素
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

            // 将 BGRA 转换为 RGBA
            for chunk in dib_bits.chunks_exact_mut(4) {
                chunk.swap(0, 2); // B <-> R
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
        }        // 优先使用 TargetPath（如果存在且有效），否则使用 IconLocation
        if let Some(ref target_path_str) = target_path {
            let expanded_path = expand_env_path(target_path_str);
            let target_path_buf = PathBuf::from(&expanded_path);            // 如果 TargetPath 存在且是文件，优先使用它
            if target_path_buf.exists() && target_path_buf.is_file() {
                return Some((target_path_buf, 0));
            }
        }
        
        // 如果 TargetPath 不存在或无效，尝试使用 IconLocation
        if let Some(ref icon_path_str) = icon_location {
            let expanded_path = expand_env_path(icon_path_str);
            let icon_path = PathBuf::from(&expanded_path);            return Some((icon_path, icon_index));
        }
        
        // 如果 IconLocation 也不存在，但 TargetPath 存在（即使是目录），也返回它
        if let Some(ref target_path_str) = target_path {
            let expanded_path = expand_env_path(target_path_str);
            let target_path_buf = PathBuf::from(&expanded_path);
            
            if target_path_buf.exists() {
                return Some((target_path_buf, 0));
            }
        }        None
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
        const MAX_PERFECT_MATCHES: usize = 3; // Early exit if we find 3 perfect matches (reduced from 5 for faster response)
        
        // For single character queries, limit the search to avoid slow performance
        // Single characters match too many apps, so we limit the search scope
        let MAX_RESULTS_TO_CHECK: usize = if query_lower.len() == 1 {
            50 // For single character queries, only check first 50 apps for faster response
        } else {
            300 // For longer queries, check up to 300 apps
        };

        // Use indices instead of cloning to avoid expensive clones
        for (idx, app) in apps.iter().enumerate().take(MAX_RESULTS_TO_CHECK) {
            let mut score = 0;

            // Direct text match (highest priority) - use case-insensitive comparison
            // Optimize: compute to_lowercase once per app name
            let name_lower = app.name.to_lowercase();
            if name_lower == query_lower {
                score += 1000;
                perfect_matches += 1;
                // For short queries (like "qq"), exit immediately on first perfect match
                // This ensures fast response for specific app searches
                if query_lower.len() <= 3 && perfect_matches >= 1 {
                    results.push((idx, score));
                    break;
                }
                // Early exit if we have enough perfect matches (reduced threshold for faster response)
                if perfect_matches >= MAX_PERFECT_MATCHES {
                    // If we have perfect matches, prioritize them and return early
                    results.push((idx, score));
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

        // If we have perfect matches and early exited, return them immediately without sorting
        if perfect_matches >= MAX_PERFECT_MATCHES && results.len() <= MAX_PERFECT_MATCHES {
            return results
                .into_iter()
                .map(|(idx, _)| apps[idx].clone())
                .collect();
        }

        // Sort by score (descending) only if we need to
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
