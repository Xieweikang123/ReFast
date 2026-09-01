use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FileHistoryItem {
    pub path: String,
    pub name: String,
    pub last_used: u64, // Unix timestamp
    pub use_count: u64,
    #[serde(default)]
    pub is_folder: Option<bool>, // 是否为文件夹
    #[serde(default)]
    pub source: Option<String>, // 数据来源: "file_history" 或 "open_history"
}

pub fn launch_file(path: &str) -> Result<(), String> {
    let trimmed = path.trim();
    
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::{
            ShellExecuteExW, SHELLEXECUTEINFOW, SHELLEXECUTEINFOW_0,
        };
        
        // 启动器内置：环境变量等（路径为 rf-builtin:…，无法用单一路径 ShellExecute）
        if let Some(rest) = trimmed.strip_prefix("rf-builtin:") {
            use std::process::Command;
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            match rest {
                "environment-variables" => {
                    Command::new("rundll32.exe")
                        .arg("sysdm.cpl,EditEnvironmentVariables")
                        .creation_flags(CREATE_NO_WINDOW)
                        .spawn()
                        .map_err(|e| {
                            format!("Failed to open environment variables dialog: {}", e)
                        })?;
                    return Ok(());
                }
                "system-properties-advanced" => {
                    use std::env;
                    let windir = env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".to_string());
                    let exe = format!(r"{}\System32\SystemPropertiesAdvanced.exe", windir);
                    Command::new(exe)
                        .creation_flags(CREATE_NO_WINDOW)
                        .spawn()
                        .map_err(|e| format!("Failed to open System Properties (Advanced): {}", e))?;
                    return Ok(());
                }
                _ => {
                    return Err(format!("Unknown builtin action: {}", trimmed));
                }
            }
        }

        // Special handling for control command (traditional Control Panel)
        if trimmed == "control" {
            use std::process::Command;
            use std::os::windows::process::CommandExt;
            
            eprintln!("[DEBUG] launch_file: executing control command");
            
            Command::new("control.exe")
                .creation_flags(0x08000000) // CREATE_NO_WINDOW - 不显示控制台窗口
                .spawn()
                .map_err(|e| format!("Failed to open Control Panel: {}", e))?;
            
            return Ok(());
        }
        
        // Special handling for ms-settings: URI (Windows 10/11 Settings app)
        if trimmed.starts_with("ms-settings:") {
            use std::process::Command;
            use std::os::windows::process::CommandExt;
            
            eprintln!("[DEBUG] launch_file: executing ms-settings URI: {}", trimmed);
            
            Command::new("cmd")
                .args(&["/c", "start", "", trimmed])
                .creation_flags(0x08000000) // CREATE_NO_WINDOW - 不显示控制台窗口
                .spawn()
                .map_err(|e| format!("Failed to open Windows Settings: {}", e))?;
            
            return Ok(());
        }
        
        // Check if this is a CLSID path (virtual folder like Recycle Bin)
        // CLSID paths start with "::"
        let is_clsid_path = trimmed.starts_with("::");
        
        let path_str = if is_clsid_path {
            // For CLSID paths, use as-is (don't normalize)
            trimmed.to_string()
        } else {
            // For normal paths, normalize: remove trailing backslashes/slashes and convert to backslashes
            let normalized = trimmed.trim_end_matches(|c| c == '\\' || c == '/');
            normalized.replace("/", "\\")
        };
        
        // Directories need a trailing `\`: ShellExecute on a bare folder name can
        // prefer a sibling `name.bat` / `.cmd` / `.exe` / `.lnk` over the directory.
        let path_str = if !is_clsid_path {
            let path_buf = PathBuf::from(&path_str);
            if !path_buf.exists() {
                return Err(format!("Path not found: {}", path_str));
            }
            if path_buf.is_dir() && !path_str.ends_with('\\') {
                format!("{}\\", path_str)
            } else {
                path_str
            }
        } else {
            path_str
        };
        
        eprintln!("[DEBUG] launch_file: opening path '{}' (is_clsid: {})", path_str, is_clsid_path);
        
        // Convert string to wide string (UTF-16) for Windows API
        let path_wide: Vec<u16> = OsStr::new(&path_str)
            .encode_wide()
            .chain(Some(0))
            .collect();

        // 与资源管理器双击一致：批处理 CWD 为脚本目录；exe/com 的「起始位置」为可执行文件所在目录（影响部分程序相对路径）
        let directory_wide: Option<Vec<u16>> = if !is_clsid_path {
            let pb = PathBuf::from(&path_str);
            if let (Some(ext), Some(parent)) = (
                pb.extension().and_then(|s| s.to_str()),
                pb.parent(),
            ) {
                let e = ext.to_lowercase();
                if e == "bat" || e == "cmd" || e == "exe" || e == "com" {
                    Some(
                        parent
                            .as_os_str()
                            .encode_wide()
                            .chain(Some(0))
                            .collect(),
                    )
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };
        let lp_directory = directory_wide
            .as_ref()
            .map_or(std::ptr::null(), |v| v.as_ptr());
        
        // SEE_MASK_ASYNCOK: 避免个别 shell 扩展/DDE 同步等待拖住启动器
        const SEE_MASK_ASYNCOK: u32 = 0x0010_0000;

        // Use ShellExecuteExW for better error handling and control
        // This provides more detailed error information than ShellExecuteW
        let mut exec_info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_ASYNCOK,
            hwnd: 0, // No parent window
            lpVerb: std::ptr::null(), // NULL means "open"
            lpFile: path_wide.as_ptr(),
            lpParameters: std::ptr::null(),
            lpDirectory: lp_directory,
            nShow: 1, // SW_SHOWNORMAL
            hInstApp: 0,
            lpIDList: std::ptr::null_mut(),
            lpClass: std::ptr::null(),
            hkeyClass: 0,
            dwHotKey: 0,
            Anonymous: SHELLEXECUTEINFOW_0 { hIcon: 0 },
            hProcess: 0,
        };
        
        let result = unsafe {
            ShellExecuteExW(&mut exec_info)
        };
        
        // ShellExecuteExW returns non-zero (TRUE) on success
        if result == 0 {
            // Get last error for more detailed error message
            use windows_sys::Win32::Foundation::GetLastError;
            let error_code = unsafe { GetLastError() };
            return Err(format!(
                "Failed to open path: {} (error code: {})",
                path_str, error_code
            ));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        use std::process::Command;
        // On Unix-like systems, use xdg-open
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to launch file: {}", e))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_file_history_item_serialization() {
        let item = FileHistoryItem {
            path: "C:\\test\\file.txt".to_string(),
            name: "file.txt".to_string(),
            last_used: 1234567890,
            use_count: 5,
            is_folder: Some(false),
            source: Some("file_history".to_string()),
        };

        let json = serde_json::to_string(&item).unwrap();
        let deserialized: FileHistoryItem = serde_json::from_str(&json).unwrap();

        assert_eq!(item.path, deserialized.path);
        assert_eq!(item.name, deserialized.name);
        assert_eq!(item.last_used, deserialized.last_used);
        assert_eq!(item.use_count, deserialized.use_count);
    }

    #[test]
    fn test_file_history_item_defaults() {
        let item = FileHistoryItem {
            path: "C:\\test\\file.txt".to_string(),
            name: "file.txt".to_string(),
            last_used: 1234567890,
            use_count: 1,
            is_folder: None,
            source: None,
        };

        // Test that optional fields can be None
        assert!(item.is_folder.is_none());
        assert!(item.source.is_none());
    }

    #[test]
    fn test_file_history_item_folder_flag() {
        let file_item = FileHistoryItem {
            path: "C:\\test\\file.txt".to_string(),
            name: "file.txt".to_string(),
            last_used: 1234567890,
            use_count: 1,
            is_folder: Some(false),
            source: None,
        };

        let folder_item = FileHistoryItem {
            path: "C:\\test\\folder".to_string(),
            name: "folder".to_string(),
            last_used: 1234567890,
            use_count: 1,
            is_folder: Some(true),
            source: None,
        };

        assert_eq!(file_item.is_folder, Some(false));
        assert_eq!(folder_item.is_folder, Some(true));
    }
}
