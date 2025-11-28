// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_search;
mod commands;
mod error;
mod hooks;
mod hotkey;
mod hotkey_handler;
mod recording;
mod replay;

use commands::*;
use tauri::{Manager, menu::{Menu, MenuItem}};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Create system tray menu
            let show_launcher = MenuItem::with_id(app, "show_launcher", "显示启动器", true, None::<&str>)?;
            let show_main = MenuItem::with_id(app, "show_main", "显示主窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            
            let menu = Menu::with_items(app, &[
                &show_launcher,
                &show_main,
                &quit,
            ])?;

            // Create tray icon
            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("ReFast")
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

