// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_search;
mod commands;
mod error;
mod everything_search;
mod file_history;
mod hooks;
mod hotkey;
mod hotkey_handler;
mod memos;
mod open_history;
mod recording;
mod replay;
mod shortcuts;
mod system_folders_search;

use crate::commands::get_app_data_dir;
use commands::*;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    menu::{Menu, MenuItem},
    Manager,
};
use std::sync::{Arc, Mutex};

// 全局锁文件句柄，确保文件在程序运行期间保持打开
static LOCK_FILE: Mutex<Option<Arc<std::fs::File>>> = Mutex::new(None);

/// 检查是否已经有实例在运行
/// 返回 true 表示这是第一个实例，可以继续运行
/// 返回 false 表示已有实例在运行，应该退出
fn check_single_instance() -> bool {
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::path::PathBuf;
    
    // 获取锁文件路径
    let lock_file_path = get_lock_file_path();
    
    // 确保目录存在
    if let Some(parent) = lock_file_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    
    // 检查文件是否存在且包含有效的进程 ID
    if lock_file_path.exists() {
        if let Ok(contents) = std::fs::read_to_string(&lock_file_path) {
            if let Ok(pid) = contents.trim().parse::<u32>() {
                // 检查进程是否还在运行
                #[cfg(target_os = "windows")]
                {
                    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION};
                    use windows_sys::Win32::Foundation::CloseHandle;
                    
                    unsafe {
                        let handle = OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid);
                        if handle != 0 {
                            CloseHandle(handle);
                            // 进程还在运行
                            eprintln!("Another instance of ReFast is already running (PID: {}).", pid);
                            return false;
                        }
                    }
                }
            }
        }
        // 文件存在但内容无效，可能是之前的实例异常退出，删除旧文件
        let _ = std::fs::remove_file(&lock_file_path);
    }
    
    // 尝试创建锁文件（独占模式）
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_file_path)
    {
        Ok(mut file) => {
            // 写入当前进程 ID
            let _ = writeln!(file, "{}", std::process::id());
            let _ = file.flush();
            // 保存文件句柄，确保它在程序运行期间保持打开
            if let Ok(mut lock_guard) = LOCK_FILE.lock() {
                *lock_guard = Some(Arc::new(file));
            }
            true
        }
        Err(_) => {
            // 无法创建文件，可能是另一个实例正在运行
            eprintln!("Another instance of ReFast is already running.");
            false
        }
    }
}

fn get_lock_file_path() -> std::path::PathBuf {
    use std::env;
    use std::path::PathBuf;
    
    // 使用临时目录或应用数据目录
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = env::var("APPDATA") {
            return PathBuf::from(appdata).join("ReFast").join("re-fast.lock");
        }
    }
    
    // 回退到临时目录
    env::temp_dir().join("re-fast.lock")
}

/// 清理锁文件
fn cleanup_lock_file() {
    // 释放文件句柄
    if let Ok(mut lock_guard) = LOCK_FILE.lock() {
        *lock_guard = None;
    }
    // 删除锁文件
    let lock_file_path = get_lock_file_path();
    let _ = std::fs::remove_file(&lock_file_path);
}

/// 设置 launcher 窗口位置（居中但稍微偏上）
fn set_launcher_window_position(window: &tauri::WebviewWindow) {
    use tauri::PhysicalPosition;
    
    // 获取窗口大小
    if let Ok(size) = window.outer_size() {
        let window_width = size.width as f64;
        let window_height = size.height as f64;
        
        // 获取主显示器尺寸
        if let Ok(monitor) = window.primary_monitor() {
            if let Some(monitor) = monitor {
                let monitor_size = monitor.size();
                let monitor_width = monitor_size.width as f64;
                let monitor_height = monitor_size.height as f64;
                
                // 计算居中位置，但向上偏移半个窗口高度
                let x = (monitor_width - window_width) / 2.0;
                let center_y = (monitor_height - window_height) / 2.0; // 居中位置
                let y = center_y - window_height / 2.0; // 向上移动半个窗口高度
                
                // 设置窗口位置
                let _ = window.set_position(PhysicalPosition::new(x as i32, y as i32));
            }
        }
    }
}

fn main() {
    // 检查单实例
    if !check_single_instance() {
        // 已有实例在运行，退出
        std::process::exit(0);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Create system tray menu
            let show_launcher =
                MenuItem::with_id(app, "show_launcher", "显示启动器", true, None::<&str>)?;
            let open_logs = MenuItem::with_id(app, "open_logs", "打开日志文件夹", true, None::<&str>)?;
            let about = MenuItem::with_id(app, "about", "关于", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "重启程序", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

            let menu = Menu::with_items(app, &[&show_launcher, &open_logs, &restart, &about, &quit])?;

            // Create tray icon - use default window icon (which loads from tauri.conf.json)
            // 禁用左键点击显示菜单，左键只用于切换启动器窗口
            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("ReFast")
                .show_menu_on_left_click(false);

            // Use default window icon (loaded from tauri.conf.json icons/icon.ico)
            // This is the simplest and most reliable way to load the icon
            if let Some(default_icon) = app.default_window_icon() {
                eprintln!("Using default window icon for tray (from tauri.conf.json)");
                tray_builder = tray_builder.icon(default_icon.clone());
            } else {
                // Fallback: create a simple colored square as fallback
                eprintln!("Warning: No default window icon found, using fallback icon");
                use tauri::image::Image;
                let mut rgba = Vec::with_capacity(16 * 16 * 4);
                for _ in 0..(16 * 16) {
                    rgba.extend_from_slice(&[255, 100, 100, 255]); // Red color
                }
                let fallback_icon = Image::new_owned(rgba, 16, 16);
                tray_builder = tray_builder.icon(fallback_icon);
            }

            let _tray = tray_builder
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        // Left click - toggle launcher window
                        if let Some(window) = tray.app_handle().get_webview_window("launcher") {
                            let _ = window.is_visible().map(|visible| {
                                if visible {
                                    let _ = window.hide();
                                } else {
                                    set_launcher_window_position(&window);
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            });
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show_launcher" => {
                        if let Some(window) = app.get_webview_window("launcher") {
                            set_launcher_window_position(&window);
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "open_logs" => {
                        #[cfg(target_os = "windows")]
                        {
                            use crate::everything_search::windows;
                            let log_dir = windows::get_log_dir();
                            
                            // 确保日志目录存在
                            if let Err(e) = std::fs::create_dir_all(&log_dir) {
                                eprintln!("Failed to create log directory: {}", e);
                            }
                            
                            // 使用 explorer 打开文件夹
                            if let Some(log_dir_str) = log_dir.to_str() {
                                let _ = std::process::Command::new("explorer")
                                    .arg(log_dir_str)
                                    .spawn();
                            }
                        }
                        #[cfg(not(target_os = "windows"))]
                        {
                            // 其他平台：使用临时目录下的日志文件夹
                            use std::path::PathBuf;
                            let log_dir = std::env::temp_dir().join("re-fast-logs");
                            
                            // 确保日志目录存在
                            if let Err(e) = std::fs::create_dir_all(&log_dir) {
                                eprintln!("Failed to create log directory: {}", e);
                            }
                            
                            if let Some(log_dir_str) = log_dir.to_str() {
                                #[cfg(target_os = "macos")]
                                {
                                    let _ = std::process::Command::new("open")
                                        .arg(log_dir_str)
                                        .spawn();
                                }
                                #[cfg(target_os = "linux")]
                                {
                                    let _ = std::process::Command::new("xdg-open")
                                        .arg(log_dir_str)
                                        .spawn();
                                }
                            }
                        }
                    }
                    "about" => {
                        #[cfg(target_os = "windows")]
                        {
                            use windows_sys::Win32::UI::WindowsAndMessaging::{
                                MessageBoxW, MB_ICONINFORMATION, MB_OK,
                            };
                            use std::ffi::OsStr;
                            use std::os::windows::ffi::OsStrExt;

                            // 将字符串转换为宽字符
                            fn to_wide_string(s: &str) -> Vec<u16> {
                                OsStr::new(s)
                                    .encode_wide()
                                    .chain(std::iter::once(0))
                                    .collect()
                            }

                            let title = to_wide_string("关于 ReFast");
                            let message = to_wide_string("ReFast\n\n一个快速启动器和输入宏录制工具\n\n版本: 0.1.0");

                            unsafe {
                                MessageBoxW(
                                    0,
                                    message.as_ptr(),
                                    title.as_ptr(),
                                    MB_OK | MB_ICONINFORMATION,
                                );
                            }
                        }
                        #[cfg(not(target_os = "windows"))]
                        {
                            // 其他平台可以使用其他方式显示关于对话框
                            eprintln!("ReFast - 一个快速启动器和输入宏录制工具\n版本: 0.1.0");
                        }
                    }
                    "restart" => {
                        app.restart();
                    }
                    "quit" => {
                        // 清理锁文件
                        cleanup_lock_file();
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // Ensure launcher window has no decorations
            if let Some(window) = app.get_webview_window("launcher") {
                let _ = window.set_decorations(false);
            }

            // Register global hotkey for launcher window
            #[cfg(target_os = "windows")]
            {
                use std::sync::mpsc;
                use std::time::Duration;

                let app_handle = app.handle().clone();
                let (tx, rx) = mpsc::channel();

                // Start hotkey listener thread in background
                match hotkey_handler::windows::start_hotkey_listener(tx) {
                    Ok(_handle) => {
                        // Listen for hotkey events in separate thread
                        let app_handle_clone = app_handle.clone();
                        std::thread::spawn(move || {
                            while let Ok(_) = rx.recv() {
                                // Hotkey pressed - toggle launcher window
                                // Small delay to ensure window operations are ready
                                std::thread::sleep(Duration::from_millis(50));

                                if let Some(window) =
                                    app_handle_clone.get_webview_window("launcher")
                                {
                                    let _ = window.is_visible().map(|visible| {
                                        if visible {
                                            let _ = window.hide();
                                        } else {
                                            set_launcher_window_position(&window);
                                            let _ = window.show();
                                            let _ = window.set_focus();
                                        }
                                    });
                                }
                            }
                        });
                    }
                    Err(e) => {
                        eprintln!("Failed to start hotkey listener: {}", e);
                    }
                }
            }

            // Load file history on startup
            let app_data_dir = get_app_data_dir(app.handle())?;
            file_history::load_history(&app_data_dir).ok(); // Ignore errors if file doesn't exist
            open_history::load_history(&app_data_dir).ok(); // Ignore errors if file doesn't exist
            shortcuts::load_shortcuts(&app_data_dir).ok(); // Ignore errors if file doesn't exist

            // Initialize Everything log file on startup to ensure path is displayed
            #[cfg(target_os = "windows")]
            {
                use crate::everything_search::windows;
                // Force initialization by calling log_debug with a startup message
                // This will create the log file and display its path
                windows::init_log_file_early();
            }

            // Load app cache on startup and start background scan
            let app_data_dir_clone = app_data_dir.clone();
            std::thread::spawn(move || {
                use crate::commands::APP_CACHE;
                // Load from disk cache first (fast)
                if let Ok(disk_cache) = app_search::windows::load_cache(&app_data_dir_clone) {
                    if !disk_cache.is_empty() {
                        if let Ok(mut cache_guard) = APP_CACHE.lock() {
                            *cache_guard = Some(disk_cache);
                        }
                    }
                }
                // No background icon extraction on startup - icons will be extracted on-demand during search
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_recording_status,
            start_recording,
            stop_recording,
            list_recordings,
            delete_recording,
            play_recording,
            stop_playback,
            get_playback_status,
            get_playback_progress,
            scan_applications,
            search_applications,
            launch_application,
            toggle_launcher,
            hide_launcher,
            add_file_to_history,
            search_file_history,
            search_everything,
            is_everything_available,
            get_everything_status,
            get_everything_path,
            get_everything_version,
            get_everything_log_file_path,
            start_everything,
            open_everything_download,
            download_everything,
            download_es_exe,
            launch_file,
            check_path_exists,
            get_clipboard_file_path,
            reveal_in_folder,
            get_all_shortcuts,
            add_shortcut,
            update_shortcut,
            delete_shortcut,
            get_all_file_history,
            delete_file_history,
            update_file_history_name,
            get_all_memos,
            add_memo,
            update_memo,
            delete_memo,
            search_memos,
            show_shortcuts_config,
            show_main_window,
            open_url,
            record_open_history,
            get_open_history,
            show_memo_window,
            show_plugin_list_window,
            get_plugin_directory,
            scan_plugin_directory,
            read_plugin_manifest,
            search_system_folders,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
