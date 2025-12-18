// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_search;
mod commands;
mod error;
mod everything_search;
mod everything_filters;
mod file_history;
mod hooks;
mod hotkey;
mod hotkey_handler;
// mod keyboard_hook; // 已不再需要，hotkey_handler 已支持双击修饰键
mod db;
mod logger;
mod plugin_usage;
mod memos;
mod open_history;
mod recording;
mod replay;
mod settings;
mod shortcuts;
mod system_folders_search;
mod window_config;
mod clipboard;

use crate::commands::get_app_data_dir;
use commands::*;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    menu::{Menu, MenuItem},
    Manager,
    Emitter,
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
                    use windows_sys::Win32::System::Threading::{
                        OpenProcess, GetExitCodeProcess, PROCESS_QUERY_INFORMATION
                    };
                    use windows_sys::Win32::Foundation::CloseHandle;
                    
                    unsafe {
                        let handle = OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid);
                        if handle != 0 {
                            let mut exit_code: u32 = 0;
                            if GetExitCodeProcess(handle, &mut exit_code) != 0 {
                                // STILL_ACTIVE 的值是 259 (0x103)，如果退出码是这个值，说明进程还在运行
                                const STILL_ACTIVE: u32 = 259;
                                if exit_code == STILL_ACTIVE {
                                    CloseHandle(handle);
                                    // 进程还在运行
                                    eprintln!("Another instance of ReFast is already running (PID: {}).", pid);
                                    return false;
                                }
                            }
                            // 进程已退出，关闭句柄并删除锁文件
                            CloseHandle(handle);
                            eprintln!("Previous instance (PID: {}) has exited, cleaning up lock file.", pid);
                            let _ = std::fs::remove_file(&lock_file_path);
                        } else {
                            // 无法打开进程，可能进程不存在，删除锁文件
                            eprintln!("Cannot open process (PID: {}), assuming it doesn't exist, cleaning up lock file.", pid);
                            let _ = std::fs::remove_file(&lock_file_path);
                        }
                    }
                }
                #[cfg(not(target_os = "windows"))]
                {
                    // 非 Windows 平台：尝试向进程发送信号 0（不实际发送信号，只检查进程是否存在）
                    use std::process::Command;
                    let output = Command::new("kill")
                        .args(&["-0", &pid.to_string()])
                        .output();
                    if let Ok(output) = output {
                        if output.status.success() {
                            // 进程还在运行
                            eprintln!("Another instance of ReFast is already running (PID: {}).", pid);
                            return false;
                        }
                    }
                    // 进程不存在，删除锁文件
                    let _ = std::fs::remove_file(&lock_file_path);
                }
            } else {
                // PID 无效，删除锁文件
                eprintln!("Invalid PID in lock file, cleaning up.");
                let _ = std::fs::remove_file(&lock_file_path);
            }
        } else {
            // 无法读取锁文件，删除它
            eprintln!("Cannot read lock file, cleaning up.");
            let _ = std::fs::remove_file(&lock_file_path);
        }
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
/// 优先使用保存的位置，如果没有保存的位置则计算默认位置
fn set_launcher_window_position(window: &tauri::WebviewWindow, app_data_dir: &std::path::Path) {
    use tauri::PhysicalPosition;
    
    // 首先尝试加载保存的位置
    if let Some(saved_pos) = window_config::get_launcher_position(app_data_dir) {
        // 验证保存的位置是否仍然有效（在屏幕范围内）
        if let Ok(monitor) = window.primary_monitor() {
            if let Some(monitor) = monitor {
                let monitor_size = monitor.size();
                let monitor_width = monitor_size.width as i32;
                let monitor_height = monitor_size.height as i32;
                
                // 检查位置是否在屏幕范围内（允许窗口稍微超出屏幕边界）
                if saved_pos.x >= -100 && saved_pos.x <= monitor_width + 100
                    && saved_pos.y >= -100 && saved_pos.y <= monitor_height + 100
                {
                    let _ = window.set_position(PhysicalPosition::new(saved_pos.x, saved_pos.y));
                    return;
                }
            }
        }
    }
    
    // 如果没有保存的位置或位置无效，则计算默认位置（居中但稍微偏上）
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
                let pos = PhysicalPosition::new(x as i32, y as i32);
                let _ = window.set_position(pos);
                
                // 保存这个计算出的位置作为默认位置
                let _ = window_config::save_launcher_position(app_data_dir, pos.x, pos.y);
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
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Create system tray menu
            let app_center = MenuItem::with_id(app, "app_center", "应用中心", true, None::<&str>)?;
            let open_logs = MenuItem::with_id(app, "open_logs", "打开日志文件夹", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "重启程序", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

            let menu = Menu::with_items(app, &[&app_center, &open_logs, &restart, &quit])?;

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

            // Get app_data_dir early for use in closures
            let app_data_dir = get_app_data_dir(app.handle())?;

            let app_data_dir_clone1 = app_data_dir.clone();

            let _tray = tray_builder
                .on_tray_icon_event(move |tray, event| {
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
                                    set_launcher_window_position(&window, &app_data_dir_clone1);
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            });
                        }
                    }
                })
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "app_center" => {
                        // 调用应用中心窗口命令
                        let app_handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = show_plugin_list_window(app_handle).await {
                                eprintln!("Failed to show app center: {}", e);
                            }
                        });
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
                    "restart" => {
                        // 清理锁文件，以便重启后新实例可以正常启动
                        cleanup_lock_file();
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
                let app_data_dir_hotkey = app_data_dir.clone();
                let (tx, rx) = mpsc::channel();

                // Load hotkey config from settings
                let hotkey_config = settings::load_settings(&app_data_dir)
                    .ok()
                    .and_then(|s| s.hotkey);

                // Initialize hotkey log file
                if let Some(log_path) = hotkey_handler::windows::init_hotkey_log() {
                    eprintln!("[Main] Hotkey log file: {}", log_path.display());
                }
                
                // Start hotkey listener thread in background
                match hotkey_handler::windows::start_hotkey_listener(tx, hotkey_config) {
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
                                            set_launcher_window_position(&window, &app_data_dir_hotkey);
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

                // 注意：keyboard_hook 模块已不再需要，因为 hotkey_handler 已经支持双击修饰键
                // 如果保留此代码，会导致双击 Ctrl 和 Alt 都会触发，造成冲突
            }

            // 启动插件快捷键监听器
            #[cfg(target_os = "windows")]
            {
                use std::sync::mpsc;
                
                let app_handle_plugin = app.handle().clone();
                let (tx_plugin, rx_plugin) = mpsc::channel();
                
                // 启动多快捷键监听器
                match hotkey_handler::windows::start_multi_hotkey_listener(tx_plugin) {
                    Ok(_handle) => {
                        // 在后台线程中监听插件和应用快捷键事件
                        let app_data_dir_hotkey = app_data_dir.clone();
                        std::thread::spawn(move || {
                            while let Ok(hotkey_id) = rx_plugin.recv() {
                                // 检查是否是应用中心快捷键
                                if hotkey_id == "app_center" {
                                    // 打开应用中心窗口
                                    use crate::commands;
                                    let app_handle_center = app_handle_plugin.clone();
                                    tauri::async_runtime::spawn(async move {
                                        if let Err(e) = commands::show_plugin_list_window(app_handle_center).await {
                                            eprintln!("[Main] Failed to show app center via hotkey: {}", e);
                                        }
                                    });
                                } else if hotkey_id.starts_with("app:") {
                                    // 提取应用路径
                                    let app_path = hotkey_id.strip_prefix("app:").unwrap_or(&hotkey_id);
                                    // 启动应用
                                    use crate::app_search;
                                    if let Ok(apps) = app_search::windows::load_cache(&app_data_dir_hotkey) {
                                        if let Some(app) = apps.iter().find(|a| a.path == app_path) {
                                            if let Err(e) = app_search::windows::launch_app(app) {
                                                eprintln!("[Main] Failed to launch app via hotkey: {}", e);
                                            }
                                        }
                                    }
                                } else {
                                    // 插件快捷键，发送事件到前端
                                    if let Err(e) = app_handle_plugin.emit("plugin-hotkey-triggered", hotkey_id) {
                                        eprintln!("[Main] Failed to emit plugin-hotkey-triggered event: {}", e);
                                    }
                                }
                            }
                        });
                        
                        // 加载并注册所有插件和应用快捷键
                        let app_data_dir_plugin = app_data_dir.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(500)); // 等待监听器完全启动
                            if let Ok(settings) = settings::load_settings(&app_data_dir_plugin) {
                                // 注册插件快捷键
                                let plugin_hotkeys = settings.plugin_hotkeys.clone();
                                if !plugin_hotkeys.is_empty() {
                                    if let Err(e) = hotkey_handler::windows::update_plugin_hotkeys(plugin_hotkeys) {
                                        eprintln!("[Main] Failed to register plugin hotkeys: {}", e);
                                    }
                                }
                                
                                // 注册应用中心快捷键
                                if let Some(ref app_center_hotkey) = settings.app_center_hotkey {
                                    if let Err(e) = hotkey_handler::windows::register_plugin_hotkey("app_center".to_string(), app_center_hotkey.clone()) {
                                        eprintln!("[Main] Failed to register app center hotkey: {}", e);
                                    } else {
                                        eprintln!("[Main] Registered app center hotkey");
                                    }
                                }
                                
                                // 注册应用快捷键（使用 "app:" 前缀）
                                let mut all_hotkeys = std::collections::HashMap::new();
                                for (app_path, hotkey) in settings.app_hotkeys.iter() {
                                    let hotkey_id = format!("app:{}", app_path);
                                    all_hotkeys.insert(hotkey_id, hotkey.clone());
                                }
                                let app_hotkey_count = all_hotkeys.len();
                                if !all_hotkeys.is_empty() {
                                    if let Err(e) = hotkey_handler::windows::update_plugin_hotkeys(all_hotkeys) {
                                        eprintln!("[Main] Failed to register app hotkeys: {}", e);
                                    } else {
                                        eprintln!("[Main] Registered {} app hotkeys", app_hotkey_count);
                                    }
                                }
                            }
                        });
                    }
                    Err(e) => {
                        eprintln!("[Main] Failed to start multi-hotkey listener: {}", e);
                    }
                }
            }

            // 性能优化：异步预加载文件历史缓存，避免首次搜索时访问 SQLite
            // 不阻塞应用启动，在后台加载
            let app_data_dir_clone = app_data_dir.clone();
            std::thread::spawn(move || {
                file_history::load_history(&app_data_dir_clone).ok(); // Ignore errors if file doesn't exist
            });
            open_history::load_history(&app_data_dir).ok(); // Ignore errors if file doesn't exist
            shortcuts::load_shortcuts(&app_data_dir).ok(); // Ignore errors if file doesn't exist

            // Sync startup setting on Windows
            #[cfg(target_os = "windows")]
            {
                use crate::commands;
                use crate::settings;
                // Load settings and sync startup state
                if let Ok(settings) = settings::load_settings(&app_data_dir) {
                    commands::sync_startup_setting(settings.startup_enabled).ok();
                }
            }

            // Initialize Everything log file on startup to ensure path is displayed
            #[cfg(target_os = "windows")]
            {
                use crate::everything_search::windows;
                // Force initialization by calling log_debug with a startup message
                // This will create the log file and display its path
                windows::init_log_file_early();
            }

            // Initialize logger module on startup to ensure log file is created
            #[cfg(target_os = "windows")]
            {
                use crate::logger;
                logger::init_log_file_early();
            }

            // Load app cache on startup and start background scan
            let app_data_dir_clone = app_data_dir.clone();
            std::thread::spawn(move || {
                use crate::commands::APP_CACHE;
                // Load from disk cache first (fast)
                if let Ok(disk_cache) = app_search::windows::load_cache(&app_data_dir_clone) {
                    if !disk_cache.is_empty() {
                        if let Ok(mut cache_guard) = APP_CACHE.lock() {
                            *cache_guard = Some(std::sync::Arc::new(disk_cache));
                        }
                    }
                }
                // No background icon extraction on startup - icons will be extracted on-demand during search
            });

            // Show launcher window on startup after a short delay to ensure frontend is loaded
            let app_handle = app.handle().clone();
            let app_data_dir_startup = app_data_dir.clone();
            std::thread::spawn(move || {
                use std::time::Duration;
                // Wait for frontend to load (500ms should be enough)
                std::thread::sleep(Duration::from_millis(500));
                
                if let Some(window) = app_handle.get_webview_window("launcher") {
                    set_launcher_window_position(&window, &app_data_dir_startup);
                    if let Err(e) = window.show() {
                        eprintln!("Failed to show launcher window on startup: {}", e);
                    }
                    if let Err(e) = window.set_focus() {
                        eprintln!("Failed to focus launcher window on startup: {}", e);
                    }
                }
            });

            // Start clipboard monitor on Windows
            #[cfg(target_os = "windows")]
            {
                let app_data_dir_clipboard = app_data_dir.clone();
                if let Err(e) = clipboard::monitor::start_clipboard_monitor(app_data_dir_clipboard) {
                    eprintln!("[Main] Failed to start clipboard monitor: {}", e);
                } else {
                    eprintln!("[Main] Clipboard monitor started");
                }
            }

            // 预热拾色器资源（后台线程，避免阻塞启动）
            // commands::color_picker::warmup_color_picker();  // 暂时屏蔽，待优化

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
            rescan_applications,
            test_uwp_apps_scan,
            search_applications,
            search_system_folders,
            populate_app_icons,
            launch_application,
            remove_app_from_index,
            debug_app_icon,
            extract_icon_from_path,
            test_all_icon_extraction_methods,
            toggle_launcher,
            hide_launcher,
            add_file_to_history,
            search_file_history,
            search_everything,
            cancel_everything_search,
            start_everything_search_session,
            get_everything_search_range,
            close_everything_search_session,
            is_everything_available,
            get_everything_status,
            get_everything_path,
            get_everything_version,
            get_everything_log_file_path,
            get_file_preview,
            purge_file_history,
            delete_file_history_by_range,
            backup_database,
            delete_backup,
            restore_backup,
            list_backups,
            get_index_status,
            check_database_health,
            start_everything,
            open_everything_download,
            download_everything,
            launch_file,
            check_path_exists,
            get_clipboard_file_path,
            get_clipboard_text,
            save_clipboard_image,
            paste_text_to_cursor,
            write_debug_log,
            get_downloads_folder,
            copy_file_to_downloads,
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
            record_plugin_usage,
            get_plugin_usage,
            show_memo_window,
            show_plugin_list_window,
            show_json_formatter_window,
            show_translation_window,
            show_hex_converter_window,
            // show_color_picker_window,  // 暂时屏蔽，待优化
            // pick_color_from_screen,     // 暂时屏蔽，待优化
            show_file_toolbox_window,
            show_calculator_pad_window,
            show_everything_search_window,
            preview_file_replace,
            execute_file_replace,
            select_folder,
            get_plugin_directory,
            scan_plugin_directory,
            read_plugin_manifest,
            get_settings,
            save_settings,
            show_settings_window,
            get_everything_custom_filters,
            save_everything_custom_filters,
            is_startup_enabled,
            set_startup_enabled,
            get_hotkey_config,
            save_hotkey_config,
            get_plugin_hotkeys,
            save_plugin_hotkeys,
            save_plugin_hotkey,
            get_app_hotkeys,
            save_app_hotkey,
            get_app_center_hotkey,
            save_app_center_hotkey,
            show_hotkey_settings,
            restart_app,
            get_app_version,
            check_update,
            download_update,
            install_update,
            quit_app,
            get_all_clipboard_items,
            add_clipboard_item,
            update_clipboard_item,
            toggle_favorite_clipboard_item,
            delete_clipboard_item,
            clear_clipboard_history,
            search_clipboard_items,
            show_clipboard_window,
            get_clipboard_image_data,
            copy_image_to_clipboard,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
