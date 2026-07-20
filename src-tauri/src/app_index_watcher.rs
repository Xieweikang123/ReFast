//! 监听开始菜单 / 桌面变更，防抖后静默重扫应用索引，使新装软件尽快可搜。

use std::env;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

use crate::app_search;
use crate::commands::{get_app_data_dir, APP_CACHE};

static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);
/// 手动重扫与静默重扫互斥，避免并发写缓存
static RESCAN_BUSY: AtomicBool = AtomicBool::new(false);

const DEBOUNCE: Duration = Duration::from_secs(4);
const MIN_RESCAN_INTERVAL: Duration = Duration::from_secs(30);

/// 尝试占用重扫锁；失败表示已有扫描在进行
pub fn try_acquire_rescan() -> bool {
    RESCAN_BUSY
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

pub fn release_rescan() {
    RESCAN_BUSY.store(false, Ordering::SeqCst);
}

fn collect_watch_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let candidates = [
        env::var("APPDATA")
            .ok()
            .map(|p| PathBuf::from(p).join("Microsoft/Windows/Start Menu/Programs")),
        env::var("LOCALAPPDATA")
            .ok()
            .map(|p| PathBuf::from(p).join("Microsoft/Windows/Start Menu/Programs")),
        env::var("PROGRAMDATA")
            .ok()
            .map(|p| PathBuf::from(p).join("Microsoft/Windows/Start Menu/Programs")),
        env::var("LOCALAPPDATA")
            .ok()
            .map(|p| PathBuf::from(p).join("Programs")),
        env::var("USERPROFILE")
            .ok()
            .map(|p| PathBuf::from(p).join("Desktop")),
        env::var("PUBLIC")
            .ok()
            .map(|p| PathBuf::from(p).join("Desktop")),
    ];
    for path in candidates.into_iter().flatten() {
        if path.exists() {
            roots.push(path);
        }
    }
    roots
}

fn is_relevant_app_path(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|ext| {
            let e = ext.to_lowercase();
            e == "lnk" || e == "exe"
        })
        .unwrap_or(false)
}

fn event_looks_like_app_change(event: &Event) -> bool {
    match event.kind {
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_) => {}
        _ => return false,
    }
    if event.paths.is_empty() {
        // 部分系统只给目录事件，仍触发防抖重扫
        return true;
    }
    event.paths.iter().any(|p| {
        is_relevant_app_path(p)
            || p.is_dir()
            || p.extension().is_none() // 新建开始菜单子目录时常无扩展名
    })
}

#[derive(PartialEq, Eq)]
enum QuietRescanOutcome {
    Done,
    Busy,
    Failed,
}

fn quiet_rescan_and_notify(app: &AppHandle) -> QuietRescanOutcome {
    if !try_acquire_rescan() {
        eprintln!("[AppIndexWatcher] 已有重扫进行中，稍后重试");
        return QuietRescanOutcome::Busy;
    }

    let result = (|| {
        let app_data_dir = get_app_data_dir(app)?;
        let apps = app_search::windows::scan_start_menu(None)?;

        {
            if let Ok(mut guard) = APP_CACHE.lock() {
                *guard = Some(std::sync::Arc::new(apps.clone()));
            }
        }
        let _ = app_search::windows::save_cache(&app_data_dir, &apps);

        let event_data = serde_json::json!({ "apps": apps });
        for label in ["launcher", "plugin-list-window", "main"] {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.emit("app-rescan-complete", &event_data);
            }
        }
        eprintln!(
            "[AppIndexWatcher] 静默重扫完成，共 {} 个应用",
            event_data["apps"].as_array().map(|a| a.len()).unwrap_or(0)
        );
        Ok::<(), String>(())
    })();

    release_rescan();

    match result {
        Ok(()) => QuietRescanOutcome::Done,
        Err(e) => {
            eprintln!("[AppIndexWatcher] 静默重扫失败: {}", e);
            QuietRescanOutcome::Failed
        }
    }
}

/// 启动开始菜单/桌面监听（进程内只启动一次）
pub fn start(app: AppHandle) {
    if WATCHER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    let roots = collect_watch_roots();
    if roots.is_empty() {
        eprintln!("[AppIndexWatcher] 无可监听目录，跳过");
        return;
    }

    let pending = Arc::new(Mutex::new(None::<Instant>));
    let last_rescan = Arc::new(Mutex::new(None::<Instant>));
    let pending_clone = Arc::clone(&pending);
    let app_for_callback = app.clone();

    let mut watcher = match RecommendedWatcher::new(
        move |result: Result<Event, notify::Error>| match result {
            Ok(event) => {
                if !event_looks_like_app_change(&event) {
                    return;
                }
                if let Ok(mut slot) = pending_clone.lock() {
                    *slot = Some(Instant::now());
                }
            }
            Err(e) => eprintln!("[AppIndexWatcher] 监听错误: {}", e),
        },
        notify::Config::default(),
    ) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[AppIndexWatcher] 创建监听器失败: {}", e);
            WATCHER_STARTED.store(false, Ordering::SeqCst);
            return;
        }
    };

    for root in &roots {
        if let Err(e) = watcher.watch(root, RecursiveMode::Recursive) {
            eprintln!(
                "[AppIndexWatcher] 监听失败 {}: {}",
                root.display(),
                e
            );
        } else {
            eprintln!("[AppIndexWatcher] 已监听 {}", root.display());
        }
    }

    // 持有 watcher，并在后台线程做防抖重扫
    std::thread::spawn(move || {
        let _watcher = watcher; // keep alive
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let due = {
                let slot = match pending.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                match *slot {
                    Some(t) if t.elapsed() >= DEBOUNCE => true,
                    _ => false,
                }
            };
            if !due {
                continue;
            }

            // 最短间隔未到：保留 pending，下一轮再试（避免漏掉安装事件）
            {
                if let Ok(last) = last_rescan.lock() {
                    if let Some(t) = *last {
                        if t.elapsed() < MIN_RESCAN_INTERVAL {
                            continue;
                        }
                    }
                }
            }

            match quiet_rescan_and_notify(&app_for_callback) {
                QuietRescanOutcome::Busy => {
                    // 手动重扫中：保留 pending，稍后再试
                    continue;
                }
                QuietRescanOutcome::Done | QuietRescanOutcome::Failed => {
                    // 失败也清 pending + 记间隔，避免 tight loop 狂扫
                    if let Ok(mut slot) = pending.lock() {
                        *slot = None;
                    }
                    if let Ok(mut last) = last_rescan.lock() {
                        *last = Some(Instant::now());
                    }
                }
            }
        }
    });
}
