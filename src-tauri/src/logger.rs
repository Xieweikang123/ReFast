// 通用日志工具模块
// 复用 everything_search 的日志机制，统一管理日志输出

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::OnceLock;

// 日志文件状态
struct LogFileState {
    file: Option<File>,
    file_path: PathBuf,
    date: String, // YYYYMMDD 格式
}

static LOG_FILE_STATE: OnceLock<Arc<Mutex<LogFileState>>> = OnceLock::new();

/// 获取日志目录路径
pub fn get_log_dir() -> PathBuf {
    // 优先使用 APPDATA 环境变量
    if let Ok(appdata) = std::env::var("APPDATA") {
        PathBuf::from(appdata).join("re-fast").join("logs")
    } else {
        // 回退到临时目录
        std::env::temp_dir().join("re-fast-logs")
    }
}

fn get_log_file_state() -> Arc<Mutex<LogFileState>> {
    LOG_FILE_STATE
        .get_or_init(|| {
            // 初始化日志文件状态
            let today = chrono::Local::now().format("%Y%m%d").to_string();
            let log_dir = get_log_dir();
            
            // 确保日志目录存在
            if let Err(e) = std::fs::create_dir_all(&log_dir) {
                eprintln!(
                    "[Logger] ERROR: Failed to create log directory {}: {}",
                    log_dir.display(),
                    e
                );
            }
            
            let log_path = log_dir.join(format!("everything-ipc-{}.log", today));

            let file = match OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
                Ok(f) => {
                    Some(f)
                }
                Err(e) => {
                    eprintln!("[Logger] ERROR: 无法打开日志文件 {}: {}", log_path.display(), e);
                    None
                }
            };

            Arc::new(Mutex::new(LogFileState {
                file,
                file_path: log_path,
                date: today,
            }))
        })
        .clone()
}

/// 确保日志文件是当前日期的文件，如果日期变化了则切换文件
fn ensure_current_log_file() {
    let state = get_log_file_state();
    let today = chrono::Local::now().format("%Y%m%d").to_string();

    let mut state_guard = match state.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };

    // 如果日期变化了，需要切换到新的日志文件
    if state_guard.date != today {
        // 关闭旧文件
        if let Some(mut old_file) = state_guard.file.take() {
            let _ = old_file.flush();
            drop(old_file);
        }

        // 创建新的日志文件
        let log_dir = get_log_dir();
        
        // 确保日志目录存在
        let _ = std::fs::create_dir_all(&log_dir);
        
        let log_path = log_dir.join(format!("everything-ipc-{}.log", today));
        let file = match OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            Ok(f) => {
                eprintln!("[Logger] 切换到新的日志文件: {}", log_path.display());
                Some(f)
            }
            Err(e) => {
                eprintln!("[Logger] ERROR: 无法打开新日志文件 {}: {}", log_path.display(), e);
                None
            }
        };

        // 更新状态
        state_guard.file = file;
        state_guard.file_path = log_path;
        state_guard.date = today;
    }
}

/// 获取日志文件路径
pub fn get_log_file_path() -> Option<PathBuf> {
    let state = get_log_file_state();
    state.lock().ok().map(|s| s.file_path.clone())
}

/// 在程序启动时初始化日志文件（确保路径被保存和显示）
pub fn init_log_file_early() {
    // 强制初始化日志文件
    let _ = get_log_file_state();
    // 写入一条测试日志，确保写入功能正常工作
    write_log("Logger", "日志系统已初始化");
}

/// 写入日志到文件
/// 
/// # Arguments
/// * `module` - 模块名称（如 "IconExtract", "Everything", "Hotkey" 等）
/// * `msg` - 日志消息
pub fn write_log(module: &str, msg: &str) {
    // 确保使用当前日期的日志文件（如果日期变化了会自动切换）
    ensure_current_log_file();

    // 输出到日志文件
    let state = get_log_file_state();
    let state_guard_result = state.lock();
    match state_guard_result {
        Ok(mut state_guard) => {
            // 如果文件句柄丢失，尝试重新打开
            if state_guard.file.is_none() {
                let log_path = state_guard.file_path.clone();
                match OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&log_path)
                {
                    Ok(f) => {
                        eprintln!("[Logger] 重新打开日志文件: {}", log_path.display());
                        state_guard.file = Some(f);
                    }
                    Err(e) => {
                        eprintln!("[Logger] ERROR: 无法重新打开日志文件 {}: {}", log_path.display(), e);
                        return;
                    }
                }
            }

            // 现在文件句柄应该存在了，尝试写入
            match state_guard.file.as_mut() {
                Some(file) => {
                    let timestamp = chrono::Local::now().format("%H:%M:%S%.3f");
                    let log_msg = format!("[{}] [{}] {}\n", timestamp, module, msg);
                    match file.write_all(log_msg.as_bytes()) {
                        Ok(_) => {
                            if let Err(e) = file.flush() {
                                eprintln!("[Logger] ERROR: 刷新日志文件失败: {}", e);
                            }
                        }
                        Err(e) => {
                            eprintln!("[Logger] ERROR: 写入日志失败: {} (文件路径: {})", e, state_guard.file_path.display());
                            // 写入失败时，清除文件句柄，下次尝试重新打开
                            state_guard.file = None;
                        }
                    }
                }
                None => {
                    eprintln!("[Logger] ERROR: 文件句柄仍然为 None，无法写入日志");
                }
            }
        }
        Err(e) => {
            eprintln!("[Logger] ERROR: 无法锁定日志状态: {}", e);
        }
    }
}

/// 日志宏，支持格式化字符串
/// 
/// # 使用示例
/// ```rust
/// use crate::logger::log;
/// log!("IconExtract", "开始提取图标: {}", file_path);
/// log!("Everything", "搜索查询: {}", query);
/// ```
#[macro_export]
macro_rules! log {
    ($module:expr, $($arg:tt)*) => {
        crate::logger::write_log($module, &format!($($arg)*));
    };
}

