//! 监听开始菜单 / 桌面变更，防抖后静默重扫应用索引，使新装软件尽快可搜。

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

use crate::app_search;
use crate::commands::{get_app_data_dir, APP_CACHE};

static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);
/// 手动重扫与静默重扫互斥，避免并发写缓存
static RESCAN_BUSY: AtomicBool = AtomicBool::new(false);

const DEBOUNCE: Duration = Duration::from_secs(4);
const MIN_RESCAN_INTERVAL: Duration = Duration::from_secs(8);
/// 安装器常先写 exe/目录，稍后再写开始菜单 .lnk；延迟二次重扫兜住晚到的快捷方式
const FOLLOW_UP_DELAY: Duration = Duration::from_secs(8);
/// 启动后稍等再做新鲜度检查，让磁盘缓存先服务首次搜索
const STARTUP_FRESHNESS_DELAY: Duration = Duration::from_millis(1500);
const STALE_CHECK_MAX_DEPTH: usize = 3;

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

fn is_lnk_path(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("lnk"))
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

/// 是否涉及 .lnk（含空 paths 的目录级事件，按可能含快捷方式处理）
fn event_suggests_lnk_change(event: &Event) -> bool {
    match event.kind {
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_) => {}
        _ => return false,
    }
    if event.paths.is_empty() {
        return true;
    }
    event.paths.iter().any(|p| is_lnk_path(p) || p.is_dir() || p.extension().is_none())
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

/// 重扫结束后：仅清除「扫描开始前或当时」的 pending；扫描期间新事件保留
fn clear_pending_if_not_newer(pending: &Mutex<Option<Instant>>, scan_started: Instant) {
    if let Ok(mut slot) = pending.lock() {
        match *slot {
            Some(t) if t > scan_started => {
                // 扫描期间又有变更，保留 pending 供下一轮
            }
            _ => {
                *slot = None;
            }
        }
    }
}

fn min_interval_elapsed(last_rescan: &Mutex<Option<Instant>>) -> bool {
    match last_rescan.lock() {
        Ok(last) => match *last {
            Some(t) => t.elapsed() >= MIN_RESCAN_INTERVAL,
            None => true,
        },
        Err(_) => true,
    }
}

fn mark_rescan_done(last_rescan: &Mutex<Option<Instant>>) {
    if let Ok(mut last) = last_rescan.lock() {
        *last = Some(Instant::now());
    }
}

/// 监听根目录下是否存在比 cache_mtime 更新的 .lnk / .exe（关机期间新装检测）
fn dir_has_newer_app_file(dir: &Path, cache_mtime: SystemTime, depth: usize) -> bool {
    if depth > STALE_CHECK_MAX_DEPTH {
        return false;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return false,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if dir_has_newer_app_file(&path, cache_mtime, depth + 1) {
                return true;
            }
            continue;
        }
        let is_app = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|ext| {
                let e = ext.to_lowercase();
                e == "lnk" || e == "exe"
            })
            .unwrap_or(false);
        if !is_app {
            continue;
        }
        if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
            if modified > cache_mtime {
                return true;
            }
        }
    }
    false
}

/// 开始菜单/桌面相对 app_cache.json 是否过期（无缓存也视为过期）
fn index_appears_stale(app_data_dir: &Path) -> bool {
    let cache_file = app_search::windows::get_cache_file_path(app_data_dir);
    let cache_mtime = match fs::metadata(&cache_file).and_then(|m| m.modified()) {
        Ok(t) => t,
        Err(_) => {
            eprintln!("[AppIndexWatcher] 无磁盘缓存，需要启动重扫");
            return true;
        }
    };

    for root in collect_watch_roots() {
        if dir_has_newer_app_file(&root, cache_mtime, 0) {
            eprintln!(
                "[AppIndexWatcher] 检测到比缓存更新的应用文件: {}",
                root.display()
            );
            return true;
        }
    }
    false
}

/// 启动后若索引过期则静默重扫（发现 ReFast 未运行时安装的软件）
fn run_startup_freshness_check(app: &AppHandle, last_rescan: &Mutex<Option<Instant>>) {
    std::thread::sleep(STARTUP_FRESHNESS_DELAY);

    let app_data_dir = match get_app_data_dir(app) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[AppIndexWatcher] 启动新鲜度检查失败（无数据目录）: {}", e);
            return;
        }
    };

    if !index_appears_stale(&app_data_dir) {
        eprintln!("[AppIndexWatcher] 启动新鲜度检查：缓存仍新，跳过重扫");
        return;
    }

    eprintln!("[AppIndexWatcher] 启动新鲜度检查：缓存过期，开始静默重扫");
    // Busy 时短暂重试（可能与手动重扫撞车）
    for attempt in 0..6 {
        match quiet_rescan_and_notify(app) {
            QuietRescanOutcome::Busy => {
                eprintln!(
                    "[AppIndexWatcher] 启动重扫 Busy，重试 {}/6",
                    attempt + 1
                );
                std::thread::sleep(Duration::from_millis(500));
            }
            QuietRescanOutcome::Done | QuietRescanOutcome::Failed => {
                mark_rescan_done(last_rescan);
                return;
            }
        }
    }
    eprintln!("[AppIndexWatcher] 启动重扫放弃（持续 Busy）");
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
    // 延迟二次重扫截止时间（安装器晚写 .lnk 时兜底）
    let follow_up = Arc::new(Mutex::new(None::<Instant>));

    let pending_clone = Arc::clone(&pending);
    let follow_up_clone = Arc::clone(&follow_up);
    let app_for_callback = app.clone();

    let mut watcher = match RecommendedWatcher::new(
        move |result: Result<Event, notify::Error>| match result {
            Ok(event) => {
                if !event_looks_like_app_change(&event) {
                    return;
                }
                let now = Instant::now();
                if let Ok(mut slot) = pending_clone.lock() {
                    *slot = Some(now);
                }
                if event_suggests_lnk_change(&event) {
                    if let Ok(mut slot) = follow_up_clone.lock() {
                        *slot = Some(now + FOLLOW_UP_DELAY);
                    }
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

    // 冷启动：缓存先服务搜索；若关机期间有新装则延迟静默重扫
    {
        let app_fresh = app.clone();
        let last_rescan_fresh = Arc::clone(&last_rescan);
        std::thread::spawn(move || {
            run_startup_freshness_check(&app_fresh, &last_rescan_fresh);
        });
    }

    // 持有 watcher，并在后台线程做防抖重扫 + 延迟二次重扫
    std::thread::spawn(move || {
        let _watcher = watcher; // keep alive
        loop {
            std::thread::sleep(Duration::from_millis(500));

            let debounce_due = {
                let slot = match pending.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                match *slot {
                    Some(t) if t.elapsed() >= DEBOUNCE => true,
                    _ => false,
                }
            };

            let follow_up_due = match follow_up.lock() {
                Ok(slot) => match *slot {
                    Some(deadline) if Instant::now() >= deadline => true,
                    _ => false,
                },
                Err(_) => false,
            };

            if !debounce_due && !follow_up_due {
                continue;
            }

            // 最短间隔未到：保留 pending / follow_up，下一轮再试
            if !min_interval_elapsed(&last_rescan) {
                continue;
            }

            let scan_started = Instant::now();
            match quiet_rescan_and_notify(&app_for_callback) {
                QuietRescanOutcome::Busy => {
                    // 手动重扫中：保留 pending / follow_up，稍后再试
                    continue;
                }
                QuietRescanOutcome::Done | QuietRescanOutcome::Failed => {
                    clear_pending_if_not_newer(&pending, scan_started);
                    mark_rescan_done(&last_rescan);

                    if follow_up_due {
                        // 本次是延迟二次重扫：清掉已到期的 follow_up；若期间又排了更晚的则保留
                        if let Ok(mut slot) = follow_up.lock() {
                            match *slot {
                                Some(deadline) if deadline > scan_started => {}
                                _ => *slot = None,
                            }
                        }
                    }
                    // debounce 触发的重扫不主动清 follow_up，让 8s 后的二次重扫仍能跑
                }
            }
        }
    });
}
