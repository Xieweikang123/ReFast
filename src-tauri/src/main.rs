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
mod recording;
mod replay;

use commands::*;
use crate::commands::get_app_data_dir;
use tauri::{Manager, menu::{Menu, MenuItem}};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Create system tray menu
            let show_launcher = MenuItem::with_id(app, "show_launcher", "显示启动器", true, None::<&str>)?;
            let show_main = MenuItem::with_id(app, "show_main", "显示主窗口", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "重启程序", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            
            let menu = Menu::with_items(app, &[
                &show_launcher,
                &show_main,
                &restart,
                &quit,
            ])?;

            // Create tray icon - use default window icon (which loads from tauri.conf.json)
            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("ReFast");
            
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
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            });
                        }
                    }
                })
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show_launcher" => {
                            if let Some(window) = app.get_webview_window("launcher") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "show_main" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "restart" => {
                            app.restart();
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
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
                                
                                if let Some(window) = app_handle_clone.get_webview_window("launcher") {
                                    let _ = window.is_visible().map(|visible| {
                                        if visible {
                                            let _ = window.hide();
                                        } else {
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

