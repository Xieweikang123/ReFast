// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_search;
mod commands;
mod error;
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

            // Create tray icon - try to load icon from file or use default
            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("ReFast");
            
            // Try to set icon from default window icon first
            if let Some(default_icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(default_icon.clone());
            } else {
                // Fallback: try to load icon from resource directory
                if let Ok(resource_dir) = app.path().resource_dir() {
                    let icon_path = resource_dir.join("icons").join("icon.ico");
                    if icon_path.exists() {
                        // Try to read and load the icon file
                        if std::fs::read(&icon_path).is_ok() {
                            // Icon file exists but ICO parsing would require additional library
                            // For now, we'll use the fallback icon below
                            eprintln!("Found icon file at: {:?}, using fallback icon", icon_path);
                        }
                    }
                }
                // If still no icon, create a simple colored square as fallback
                use tauri::image::Image;
                // Create a simple 16x16 red square icon
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
            launch_file,
            check_path_exists,
            get_clipboard_file_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

