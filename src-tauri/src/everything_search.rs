use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct EverythingResult {
    pub path: String,
    pub name: String,
    pub size: Option<u64>,
    pub date_modified: Option<String>,
    pub is_folder: Option<bool>,
}

/// Everything 错误类型枚举
#[derive(Debug, Clone)]
pub enum EverythingError {
    /// Everything 未安装
    NotInstalled,
    /// Everything 服务未运行
    ServiceNotRunning,
    /// 搜索超时
    Timeout,
    /// IPC 通信失败
    IpcFailed(String),
    /// 查询参数错误
    InvalidQuery(String),
    /// JSON 解析失败
    JsonParseError(String),
    /// 其他错误
    Other(String),
}

impl fmt::Display for EverythingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EverythingError::NotInstalled => {
                write!(f, "NOT_INSTALLED:Everything 未安装，请安装 Everything")
            }
            EverythingError::ServiceNotRunning => {
                write!(f, "SERVICE_NOT_RUNNING:Everything 服务未运行，请启动 Everything 主程序")
            }
            EverythingError::Timeout => {
                write!(f, "TIMEOUT:搜索超时，请缩短关键字或稍后再试")
            }
            EverythingError::IpcFailed(msg) => {
                write!(f, "IPC_FAILED:IPC 通信失败: {}", msg)
            }
            EverythingError::InvalidQuery(msg) => {
                write!(f, "INVALID_QUERY:查询参数错误: {}", msg)
            }
            EverythingError::JsonParseError(msg) => {
                write!(f, "JSON_PARSE_ERROR:JSON 解析失败: {}", msg)
            }
            EverythingError::Other(msg) => {
                write!(f, "OTHER:{}", msg)
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub mod windows {
    use super::*;
    use std::ptr;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    use windows_sys::Win32::System::DataExchange::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::fs::{File, OpenOptions};
    use std::io::Write;
    use std::path::PathBuf;

    // Everything IPC 常量
    // Everything 1.4+ 使用主窗口类名（旧的 EVERYTHING_TASKBAR_NOTIFICATION 已失效）
    const EVERYTHING_IPC_WNDCLASS: &str = "EVERYTHING";
    // Everything 1.4+ 新协议 QueryW
    const EVERYTHING_IPC_COPYDATAQUERYW: usize = 0x10001;  // 新协议标识
    const EVERYTHING_IPC_REPLY: u32 = 2;
    const COPYDATA_QUERYCOMPLETE: u32 = 0x804E;  // 新协议必须使用 0x804E

    // Everything IPC 搜索标志
    const EVERYTHING_IPC_REGEX: u32 = 0x00000001;
    const EVERYTHING_IPC_MATCHCASE: u32 = 0x00000002;
    const EVERYTHING_IPC_MATCHWHOLEWORD: u32 = 0x00000004;
    const EVERYTHING_IPC_MATCHPATH: u32 = 0x00000008;

    // Everything IPC 查询结构体（Everything 1.4+ QueryW 协议）
    // 字段顺序必须严格按照新协议：
    // reply_hwnd, reply_copydata_message (0x804E), search_flags, reply_offset, max_results, search_string
    // 注意：使用 #[repr(C)] 而不是 packed，因为 DWORD 在 Windows 上是 4 字节对齐的
    #[repr(C)]
    struct EverythingIpcQueryW {
        reply_hwnd: u32,              // HWND cast to u32 (DWORD) - 4 bytes
        reply_copydata_message: u32,  // DWORD - 必须填 0x804E
        search_flags: u32,            // DWORD - 4 bytes
        reply_offset: u32,            // DWORD - 新增字段！通常填 0
        max_results: u32,             // DWORD - 4 bytes
        // search_string follows as WCHAR[] (UTF-16), must end with 0,0
        // 注意：结构体后面紧跟着 UTF-16 字符串，没有额外的对齐
    }

    // Everything IPC 回复结构体（官方协议）
    #[repr(C)]
    struct EverythingIpcList {
        totitems: u32,    // DWORD - 总结果数
        numitems: u32,    // DWORD - 当前返回的结果数
        // items[] follows
    }

    // Everything IPC Item 结构体
    #[repr(C)]
    struct EverythingIpcItem {
        flags: u32,              // DWORD
        filename_offset: u32,    // DWORD - 文件名在字符串池中的偏移
        path_offset: u32,        // DWORD - 路径在字符串池中的偏移
    }

    // 全局状态：存储每个窗口句柄对应的发送器
    use std::collections::HashMap;
    
    static WINDOW_SENDERS: OnceLock<Arc<Mutex<HashMap<HWND, mpsc::Sender<Result<Vec<String>, EverythingError>>>>>> = OnceLock::new();
    
    // 日志文件（使用临时目录，按天生成）
    struct LogFileState {
        file: Option<File>,
        file_path: PathBuf,
        date: String, // YYYYMMDD 格式
    }
    
    static LOG_FILE_STATE: OnceLock<Arc<Mutex<LogFileState>>> = OnceLock::new();
    
    fn get_log_file_state() -> Arc<Mutex<LogFileState>> {
        LOG_FILE_STATE.get_or_init(|| {
            // 初始化日志文件状态
            let today = chrono::Local::now().format("%Y%m%d").to_string();
            let log_path = std::env::temp_dir().join(format!("re-fast-everything-ipc-{}.log", today));
            
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
                .ok();
            
            if file.is_some() {
                eprintln!("========================================");
                eprintln!("[DEBUG] Everything IPC log file created:");
                eprintln!("[DEBUG] {}", log_path.display());
                eprintln!("========================================");
            } else {
                eprintln!("[DEBUG] ERROR: Failed to create log file at {}", log_path.display());
            }
            
            Arc::new(Mutex::new(LogFileState {
                file,
                file_path: log_path,
                date: today,
            }))
        }).clone()
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
            let log_path = std::env::temp_dir().join(format!("re-fast-everything-ipc-{}.log", today));
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
                .ok();
            
            if file.is_some() {
                eprintln!("========================================");
                eprintln!("[DEBUG] New day detected, switching to new log file:");
                eprintln!("[DEBUG] {}", log_path.display());
                eprintln!("========================================");
            }
            
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
        
        // 显示当前日志文件路径
        if let Some(path) = get_log_file_path() {
            eprintln!("========================================");
            eprintln!("[DEBUG] Everything IPC log file:");
            eprintln!("[DEBUG] {}", path.display());
            eprintln!("========================================");
        }
    }
    
    /// 内部函数：写入日志到文件
    fn write_log_to_file(msg: &str) {
        // 确保使用当前日期的日志文件（如果日期变化了会自动切换）
        ensure_current_log_file();
        
        // 输出到日志文件
        let state = get_log_file_state();
        let state_guard_result = state.lock();
        if let Ok(mut state_guard) = state_guard_result {
            if let Some(file) = state_guard.file.as_mut() {
                let timestamp = chrono::Local::now().format("%H:%M:%S%.3f");
                let log_msg = format!("[{}] {}", timestamp, msg);
                let _ = writeln!(file, "{}", log_msg);
                let _ = file.flush();
            }
        }
    }
    
    /// 日志宏，支持格式化字符串，同时输出到控制台和日志文件
    macro_rules! log_debug {
        ($($arg:tt)*) => {
            {
                let msg = format!($($arg)*);
                // 输出到控制台
                eprintln!("{}", msg);
                // 输出到日志文件
                write_log_to_file(&msg);
            }
        };
    }
    
    fn get_window_senders() -> &'static Arc<Mutex<HashMap<HWND, mpsc::Sender<Result<Vec<String>, EverythingError>>>>> {
        WINDOW_SENDERS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
    }

    // 缓存 Everything 窗口句柄，避免重复查找
    struct CachedEverythingWindow {
        hwnd: Option<HWND>,
        timestamp: Instant,
    }
    
    static CACHED_WINDOW: OnceLock<Arc<Mutex<CachedEverythingWindow>>> = OnceLock::new();
    const CACHE_DURATION: Duration = Duration::from_secs(5); // 缓存5秒
    
    fn get_cached_window() -> Arc<Mutex<CachedEverythingWindow>> {
        CACHED_WINDOW.get_or_init(|| {
            Arc::new(Mutex::new(CachedEverythingWindow {
                hwnd: None,
                timestamp: Instant::now() - CACHE_DURATION, // 初始化为过期
            }))
        }).clone()
    }

    /// 窗口过程，处理 WM_COPYDATA 消息
    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        // 记录所有重要消息（排除常见的系统消息以减少噪音）
        const WM_TIMER: u32 = 0x0113;
        const WM_PAINT: u32 = 0x000F;
        const WM_SETCURSOR: u32 = 0x0020;
        const WM_MOUSEMOVE: u32 = 0x0200;
        const WM_NCHITTEST: u32 = 0x0084;
        
        // 特别记录 WM_COPYDATA，这是关键消息
        if msg == WM_COPYDATA {
            log_debug!("[DEBUG] ===== CRITICAL: window_proc called with WM_COPYDATA =====");
            log_debug!("[DEBUG] window_proc: msg=0x{:X} (WM_COPYDATA), hwnd={:?}, wparam={:?}, lparam={:?}", 
                msg, hwnd, wparam, lparam);
        } else if msg != WM_TIMER && msg != WM_PAINT && msg != WM_SETCURSOR && 
           msg != WM_MOUSEMOVE && msg != WM_NCHITTEST {
            log_debug!("[DEBUG] window_proc called: msg=0x{:X} ({}), hwnd={:?}, wparam={:?}, lparam={:?}", 
                msg, msg, hwnd, wparam, lparam);
        }
        
        match msg {
            WM_COPYDATA => {
                log_debug!("[DEBUG] ===== WM_COPYDATA RECEIVED =====");
                log_debug!("[DEBUG] WM_COPYDATA hwnd: {:?}, wparam: {:?}, lparam: {:?}", hwnd, wparam, lparam);
                
                let cds = ptr::read(lparam as *const COPYDATASTRUCT);
                log_debug!("[DEBUG] COPYDATASTRUCT: dwData={}, cbData={} bytes, lpData={:?}", 
                    cds.dwData, cds.cbData, cds.lpData);
                
                // Everything 回复时，dwData 通常是 EVERYTHING_IPC_REPLY (2)
                // 新协议也可能使用我们发送的 reply_copydata_message 值
                // 为了兼容性，我们检查多种可能
                let is_reply = cds.dwData == EVERYTHING_IPC_REPLY as usize || 
                               cds.dwData == COPYDATA_QUERYCOMPLETE as usize ||
                               cds.dwData == 0x804E;  // 兼容新协议可能的回复值
                
                if is_reply {
                    log_debug!("[DEBUG] Processing Everything reply (dwData={})", cds.dwData);
                    // 解析结果
                    let result = parse_ipc_reply(&cds);
                    log_debug!("[DEBUG] Parsed result: {:?}", result);
                    
                    // 获取对应的发送器并发送结果
                    let senders = get_window_senders();
                    log_debug!("[DEBUG] Looking up sender for hwnd: {:?}", hwnd);
                    if let Ok(senders_guard) = senders.lock() {
                        log_debug!("[DEBUG] Senders map has {} entries", senders_guard.len());
                        log_debug!("[DEBUG] Registered hwnds: {:?}", senders_guard.keys().collect::<Vec<_>>());
                        
                        if let Some(sender) = senders_guard.get(&hwnd) {
                            log_debug!("[DEBUG] Found sender! Sending result to channel");
                            match sender.send(result) {
                                Ok(_) => log_debug!("[DEBUG] Result sent to channel successfully"),
                                Err(e) => log_debug!("[DEBUG] ERROR: Failed to send result to channel: {:?}", e),
                            }
                        } else {
                            log_debug!("[DEBUG] WARNING: No sender found for hwnd: {:?}", hwnd);
                            log_debug!("[DEBUG] Available hwnds: {:?}", senders_guard.keys().collect::<Vec<_>>());
                        }
                    } else {
                        log_debug!("[DEBUG] ERROR: Failed to lock senders mutex");
                    }
                } else {
                    log_debug!("[DEBUG] Unexpected dwData value: {} (expected EVERYTHING_IPC_REPLY={} or COPYDATA_QUERYCOMPLETE={})", 
                        cds.dwData, EVERYTHING_IPC_REPLY, COPYDATA_QUERYCOMPLETE);
                    log_debug!("[DEBUG] This might be a different type of COPYDATA message");
                }
                log_debug!("[DEBUG] ===== WM_COPYDATA HANDLED =====");
                1 // TRUE - 消息已处理
            }
            WM_DESTROY => {
                log_debug!("[DEBUG] WM_DESTROY received for hwnd: {:?}", hwnd);
                // 清理发送器
                let senders = get_window_senders();
                if let Ok(mut senders_guard) = senders.lock() {
                    senders_guard.remove(&hwnd);
                    log_debug!("[DEBUG] Removed sender for hwnd: {:?}", hwnd);
                }
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    /// Everything IPC 查询句柄，用于管理消息循环和结果接收
    struct EverythingIpcHandle {
        reply_hwnd: HWND,
        result_receiver: mpsc::Receiver<Result<Vec<String>, EverythingError>>,
    }

        impl EverythingIpcHandle {
        fn new() -> Result<Self, EverythingError> {
            eprintln!("[DEBUG] EverythingIpcHandle::new called");
            
            // 确保窗口类已注册
            static INIT_ONCE: std::sync::Once = std::sync::Once::new();
            INIT_ONCE.call_once(|| {
                eprintln!("[DEBUG] Registering window class for IPC");
                unsafe {
                    let class_name = wide_string("ReFastEverythingIPC");
                    let wc = WNDCLASSW {
                        style: 0,
                        lpfnWndProc: Some(window_proc),
                        cbClsExtra: 0,
                        cbWndExtra: 0,
                        hInstance: 0,
                        hIcon: 0,
                        hCursor: 0,
                        hbrBackground: 0,
                        lpszMenuName: ptr::null(),
                        lpszClassName: class_name.as_ptr(),
                    };
                    let atom = RegisterClassW(&wc);
                    if atom == 0 {
                        let last_error = windows_sys::Win32::Foundation::GetLastError();
                        eprintln!("[DEBUG] WARNING: RegisterClassW returned 0, error: {}", last_error);
                    } else {
                        eprintln!("[DEBUG] Window class registered successfully, atom: {}", atom);
                    }
                }
            });

            // 创建通道用于接收搜索结果
            let (sender, receiver) = mpsc::channel();
            eprintln!("[DEBUG] Created mpsc channel");

            // 创建消息窗口
            unsafe {
                let class_name = wide_string("ReFastEverythingIPC");
                eprintln!("[DEBUG] Creating message window...");
                let hwnd = CreateWindowExW(
                    0,
                    class_name.as_ptr(),
                    class_name.as_ptr(),
                    0,
                    0,
                    0,
                    0,
                    0,
                    HWND_MESSAGE,
                    0,
                    0,
                    ptr::null_mut(),
                );

                if hwnd == 0 {
                    let last_error = windows_sys::Win32::Foundation::GetLastError();
                    eprintln!("[DEBUG] ERROR: CreateWindowExW returned 0, error: {}", last_error);
                    return Err(EverythingError::IpcFailed(format!("无法创建消息窗口, error: {}", last_error)));
                }
                
                eprintln!("[DEBUG] Message window created: {:?}", hwnd);

                // 注册发送器
                let senders = get_window_senders();
                if let Ok(mut senders_guard) = senders.lock() {
                    senders_guard.insert(hwnd, sender);
                    eprintln!("[DEBUG] Sender registered for hwnd: {:?}", hwnd);
                } else {
                    eprintln!("[DEBUG] ERROR: Failed to lock senders mutex");
                }

                Ok(EverythingIpcHandle {
                    reply_hwnd: hwnd,
                    result_receiver: receiver,
                })
            }
        }

        fn destroy(&self) {
            unsafe {
                let senders = get_window_senders();
                if let Ok(mut senders_guard) = senders.lock() {
                    senders_guard.remove(&self.reply_hwnd);
                }
                DestroyWindow(self.reply_hwnd);
            }
        }
    }

    impl Drop for EverythingIpcHandle {
        fn drop(&mut self) {
            self.destroy();
        }
    }

    /// 将 Rust 字符串转换为 Windows UTF-16 宽字符串
    /// Everything v1.4.1 要求字符串必须以 UTF-16 双 0 结尾（\0\0）
    fn wide_string(s: &str) -> Vec<u16> {
        let mut result: Vec<u16> = OsStr::new(s)
            .encode_wide()
            .collect();
        // Everything v1.4.1 要求字符串以双 0 结尾
        result.push(0);
        result.push(0);
        result
    }

    /// 从 UTF-16 宽字符串转换为 Rust 字符串
    fn from_wide_string(wide: &[u16]) -> String {
        let end = wide.iter().position(|&x| x == 0).unwrap_or(wide.len());
        String::from_utf16_lossy(&wide[..end])
    }


    /// 解析 Everything IPC 回复（官方协议）
    fn parse_ipc_reply(cds: &COPYDATASTRUCT) -> Result<Vec<String>, EverythingError> {
        let list_size = std::mem::size_of::<EverythingIpcList>() as u32;
        eprintln!("[DEBUG] parse_ipc_reply: cbData={}, expected list_size={}", cds.cbData, list_size);
        
        if cds.cbData < list_size {
            eprintln!("[DEBUG] ERROR: Reply data too short: {} < {}", cds.cbData, list_size);
            return Err(EverythingError::IpcFailed("回复数据太短".to_string()));
        }

        unsafe {
            // 读取 EVERYTHING_IPC_LIST 结构
            let list = ptr::read(cds.lpData as *const EverythingIpcList);
            let totitems = list.totitems;
            let numitems = list.numitems;
            eprintln!("[DEBUG] Reply structure: totitems={}, numitems={}", totitems, numitems);

            if numitems == 0 {
                eprintln!("[DEBUG] numitems is 0, returning empty result");
                return Ok(Vec::new());
            }

            // 计算 items 数组的起始位置
            let items_ptr = (cds.lpData as *const u8)
                .add(list_size as usize) as *const EverythingIpcItem;
            
            eprintln!("[DEBUG] Items array starts at offset: {}", list_size);
            
            // Everything v1.4.1: offset 字段指向 EVERYTHING_IPC_LIST 基地址的字节偏移
            // filename_offset 和 path_offset 都是相对于 lpData 的偏移
            
            let mut results = Vec::new();
            let list_base = cds.lpData as *const u8;
            
            // 遍历每个 item
            for i in 0..numitems {
                let item = ptr::read(items_ptr.add(i as usize));
                let flags = item.flags;
                let filename_offset = item.filename_offset;
                let path_offset = item.path_offset;
                eprintln!("[DEBUG] Item {}: flags={}, filename_offset={}, path_offset={}", 
                    i, flags, filename_offset, path_offset);
                
                // path_offset 是相对于 EVERYTHING_IPC_LIST 基地址的字节偏移
                // 直接使用 offset 值，不需要加上字符串池偏移
                let path_ptr = list_base.add(path_offset as usize) as *const u16;
                
                // 读取 UTF-16 字符串直到遇到 \0
                let mut path_chars = Vec::new();
                let mut offset = 0;
                loop {
                    let wchar = ptr::read(path_ptr.add(offset));
                    if wchar == 0 {
                        break;
                    }
                    path_chars.push(wchar);
                    offset += 1;
                    // 防止无限循环（最多读取 32767 个字符）
                    if offset > 32767 {
                        eprintln!("[DEBUG] WARNING: Path string too long, truncating");
                        break;
                    }
                }
                
                if !path_chars.is_empty() {
                    let path = from_wide_string(&path_chars);
                    eprintln!("[DEBUG] Found result path: {}", path);
                    results.push(path);
                } else {
                    eprintln!("[DEBUG] WARNING: Item {} has empty path", i);
                }
            }

            eprintln!("[DEBUG] Total parsed results: {}", results.len());
            Ok(results)
        }
    }

    /// 查找 Everything 窗口（内部函数，带缓存）
    fn find_everything_window_internal(caller: &str) -> Option<HWND> {
        log_debug!("[DEBUG] find_everything_window called from: {}", caller);
        
        // 检查缓存
        let cache = get_cached_window();
        if let Ok(mut cached) = cache.lock() {
            let now = Instant::now();
            if cached.hwnd.is_some() && now.duration_since(cached.timestamp) < CACHE_DURATION {
                log_debug!("[DEBUG] Using cached Everything window: {:?}", cached.hwnd);
                return cached.hwnd;
            }
        }
        
        // 缓存过期或不存在，重新查找
        log_debug!("[DEBUG] Cache expired or empty, searching for Everything window...");
        
        unsafe {
            use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowTextW, EnumWindows, GetClassNameW};
            
            // Everything 1.4+ 优先使用主窗口（唯一有效的 IPC 接收窗口）
            let main_class_name = wide_string("EVERYTHING");
            log_debug!("[DEBUG] Looking for Everything main window with class: EVERYTHING");
            let main_hwnd = FindWindowW(main_class_name.as_ptr(), ptr::null());
            
            let result = if main_hwnd != 0 {
                log_debug!("[DEBUG] Everything main window found: {:?} (recommended for IPC)", main_hwnd);
                Some(main_hwnd)
            } else {
                // 如果类名查找失败，检查旧的窗口类（用于诊断）
                log_debug!("[DEBUG] Everything main window class 'EVERYTHING' not found");
                let old_class_name = wide_string("EVERYTHING_TASKBAR_NOTIFICATION");
                let old_hwnd = FindWindowW(old_class_name.as_ptr(), ptr::null());
                if old_hwnd != 0 {
                    log_debug!("[DEBUG] WARNING: Only found old window class (will fail): {:?}", old_hwnd);
                    log_debug!("[DEBUG] Everything 1.4+ requires main window class 'EVERYTHING' for IPC");
                    log_debug!("[DEBUG] Please open Everything main window (not just service mode)");
                } else {
                    log_debug!("[DEBUG] Everything window NOT found - Everything may not be running");
                    log_debug!("[DEBUG] Please ensure Everything is running and main window is open");
                }
                None
            };
            
            // 更新缓存
            if let Ok(mut cached) = cache.lock() {
                cached.hwnd = result;
                cached.timestamp = Instant::now();
                log_debug!("[DEBUG] Updated cache with window: {:?}", cached.hwnd);
            }
            
            result
        }
    }

    /// 查找 Everything 窗口
    fn find_everything_window() -> Option<HWND> {
        find_everything_window_internal("find_everything_window")
    }

    /// 检查 Everything 服务是否运行
    /// 通过查找 Everything 窗口来判断（使用缓存）
    pub fn check_everything_service_running() -> bool {
        find_everything_window_internal("check_everything_service_running").is_some()
    }

    /// 查找 Everything.exe 主程序路径（用于启动）
    pub fn find_everything_main_exe() -> Option<PathBuf> {
        let everything_paths = [
            r"C:\Program Files\Everything\Everything.exe",
            r"C:\Program Files (x86)\Everything\Everything.exe",
            r"C:\Tools\Everything\Everything.exe",
            r"C:\Everything\Everything.exe",
        ];
        
        for path in &everything_paths {
            let exe_path = PathBuf::from(path);
            if exe_path.exists() {
                return Some(exe_path);
            }
        }
        
        None
    }

    /// 获取 Everything 版本号
    /// 通过读取 Everything.exe 的文件版本信息来获取
    pub fn get_everything_version() -> Option<String> {
        let exe_path = find_everything_main_exe()?;
        
        // 使用 PowerShell 获取文件版本信息
        // 这样可以避免复杂的 Windows API 调用
        // 将路径中的单引号转义，并转义反斜杠
        let path_str = exe_path.to_string_lossy();
        let escaped_path = path_str
            .replace('\'', "''")  // PowerShell 中单引号需要双写来转义
            .replace('\\', "\\\\");
        
        let ps_command = format!(
            r#"
            try {{
                $version = (Get-ItemProperty -LiteralPath '{}' -ErrorAction Stop).VersionInfo
                $versionString = "$($version.FileMajorPart).$($version.FileMinorPart).$($version.FileBuildPart).$($version.FilePrivatePart)"
                Write-Output $versionString
            }} catch {{
                exit 1
            }}
            "#,
            escaped_path
        );

        match std::process::Command::new("powershell")
            .args(&["-NoProfile", "-NonInteractive", "-Command", &ps_command])
            .output()
        {
            Ok(output) => {
                if output.status.success() {
                    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if !version.is_empty() {
                        Some(version)
                    } else {
                        None
                    }
                } else {
                    // 输出错误信息以便调试
                    if !output.stderr.is_empty() {
                        eprintln!("[DEBUG] PowerShell error: {}", String::from_utf8_lossy(&output.stderr));
                    }
                    None
                }
            }
            Err(e) => {
                eprintln!("[DEBUG] Failed to execute PowerShell: {}", e);
                None
            }
        }
    }

    /// 通过 IPC 发送搜索查询
    fn send_search_query(
        query: &str,
        max_results: u32,
        reply_hwnd: HWND,
        everything_hwnd: HWND,
    ) -> Result<(), EverythingError> {
        log_debug!("[DEBUG] send_search_query called: query='{}', max_results={}, reply_hwnd={:?}, everything_hwnd={:?}", 
            query, max_results, reply_hwnd, everything_hwnd);

        // 将查询字符串转换为 UTF-16（以双 0 结尾）
        let query_wide = wide_string(query);
        log_debug!("[DEBUG] Query converted to UTF-16: {} chars (including double null terminator)", query_wide.len());
        // 验证字符串以双 0 结尾
        if query_wide.len() < 2 || query_wide[query_wide.len() - 2] != 0 || query_wide[query_wide.len() - 1] != 0 {
            log_debug!("[DEBUG] WARNING: Query string does not end with double null!");
        } else {
            log_debug!("[DEBUG] Query string correctly ends with double null (UTF-16)");
        }

        // 计算结构体大小（Everything 1.4+ QueryW 协议）
        let base_size = std::mem::size_of::<EverythingIpcQueryW>();
        let string_size = query_wide.len() * std::mem::size_of::<u16>();
        let struct_size = base_size + string_size;
        log_debug!("[DEBUG] Query structure size: base={}, string={}, total={}", base_size, string_size, struct_size);

        // 分配内存
        let mut query_data = vec![0u8; struct_size];
        let query_ptr = query_data.as_mut_ptr() as *mut EverythingIpcQueryW;

        unsafe {
            // 按照 Everything 1.4+ QueryW 协议顺序填充结构体
            // 顺序：reply_hwnd, reply_copydata_message (0x804E), search_flags, reply_offset, max_results
            (*query_ptr).reply_hwnd = reply_hwnd as u32;  // HWND 转换为 u32
            (*query_ptr).reply_copydata_message = COPYDATA_QUERYCOMPLETE;  // 必须填 0x804E
            (*query_ptr).search_flags = 0; // 默认标志
            (*query_ptr).reply_offset = 0; // 新增字段，通常填 0
            (*query_ptr).max_results = max_results;
            
            log_debug!("[DEBUG] Query structure filled (Everything 1.4+ QueryW protocol):");
            log_debug!("[DEBUG]   reply_hwnd={:?} (as u32: {}) (offset 0)", reply_hwnd, reply_hwnd as u32);
            log_debug!("[DEBUG]   reply_copydata_message={:08X} (0x804E) (offset 4)", COPYDATA_QUERYCOMPLETE);
            log_debug!("[DEBUG]   search_flags=0 (offset 8)");
            log_debug!("[DEBUG]   reply_offset=0 (offset 12)");
            log_debug!("[DEBUG]   max_results={} (offset 16)", max_results);

            // 复制查询字符串到结构体后面
            let search_string_ptr = (query_ptr as *mut u8).add(base_size) as *mut u16;
            ptr::copy_nonoverlapping(
                query_wide.as_ptr(),
                search_string_ptr,
                query_wide.len(),
            );
            log_debug!("[DEBUG] Query string copied to structure ({} UTF-16 chars)", query_wide.len());
        }

        // 创建 COPYDATASTRUCT（Everything 1.4+ 使用 QueryW 协议）
        let mut cds = COPYDATASTRUCT {
            dwData: EVERYTHING_IPC_COPYDATAQUERYW,  // 关键！必须是 0x10001
            cbData: struct_size as u32,
            lpData: query_data.as_mut_ptr() as *mut std::ffi::c_void,
        };
        
        log_debug!("[DEBUG] COPYDATASTRUCT created: dwData={} (0x{:X}, QueryW protocol), cbData={}", 
            cds.dwData, cds.dwData, cds.cbData);
        
        // 打印前32字节用于调试（写入日志文件）
        unsafe {
            let mut hex_dump = String::new();
            for i in 0..32.min(query_data.len()) {
                if i % 16 == 0 {
                    hex_dump.push_str(&format!("\n[DEBUG]   {:04X}: ", i));
                }
                hex_dump.push_str(&format!("{:02X} ", query_data[i]));
            }
            log_debug!("[DEBUG] First 32 bytes of query data:{}", hex_dump);
            
            log_debug!("[DEBUG] Structure breakdown (Everything 1.4+ QueryW protocol):");
            log_debug!("[DEBUG]   reply_hwnd (offset 0): {:08X}", 
                u32::from_le_bytes([query_data[0], query_data[1], query_data[2], query_data[3]]));
            log_debug!("[DEBUG]   reply_copydata_message (offset 4): {:08X}", 
                u32::from_le_bytes([query_data[4], query_data[5], query_data[6], query_data[7]]));
            log_debug!("[DEBUG]   search_flags (offset 8): {:08X}", 
                u32::from_le_bytes([query_data[8], query_data[9], query_data[10], query_data[11]]));
            log_debug!("[DEBUG]   reply_offset (offset 12): {:08X}", 
                u32::from_le_bytes([query_data[12], query_data[13], query_data[14], query_data[15]]));
            log_debug!("[DEBUG]   max_results (offset 16): {:08X}", 
                u32::from_le_bytes([query_data[16], query_data[17], query_data[18], query_data[19]]));
            log_debug!("[DEBUG]   search_string starts at offset {}", base_size);
            
            // 打印完整的字符串内容
            if query_data.len() > base_size {
                let string_start = base_size;
                let mut string_bytes = Vec::new();
                for i in string_start..query_data.len().min(string_start + 64) {
                    string_bytes.push(query_data[i]);
                }
                log_debug!("[DEBUG]   search_string bytes (first 64): {:?}", string_bytes);
            }
        }

        // 发送消息
        unsafe {
            log_debug!("[DEBUG] ===== About to send WM_COPYDATA =====");
            log_debug!("[DEBUG] Target Everything window: {:?}", everything_hwnd);
            log_debug!("[DEBUG] Reply window (wparam): {:?}", reply_hwnd);
            log_debug!("[DEBUG] COPYDATASTRUCT: dwData={}, cbData={}", cds.dwData, cds.cbData);
            
            // 验证窗口句柄是否有效
            use windows_sys::Win32::UI::WindowsAndMessaging::IsWindow;
            let window_valid = IsWindow(everything_hwnd);
            log_debug!("[DEBUG] Everything window handle valid: {} (0=invalid, non-zero=valid)", window_valid);
            
            if window_valid == 0 {
                return Err(EverythingError::IpcFailed(format!("Everything 窗口句柄无效: {:?}", everything_hwnd)));
            }
            
            log_debug!("[DEBUG] Calling SendMessageW (this will block until Everything processes the message)...");
            
            // SendMessageW 是同步的，会阻塞直到 Everything 处理完消息
            // 如果 Everything 在 SendMessageW 期间调用 SendMessageW 发送回复到我们的窗口，
            // 我们的窗口过程会被 Everything 的线程调用，而不是在消息循环中
            let result = SendMessageW(
                everything_hwnd,
                WM_COPYDATA,
                reply_hwnd as WPARAM,
                &mut cds as *mut COPYDATASTRUCT as LPARAM,
            );
            
            log_debug!("[DEBUG] ===== CRITICAL: SendMessageW returned: {} (0=FALSE, non-zero=TRUE) =====", result);
            log_debug!("[DEBUG] SendMessageW completed (Everything has processed the query)");
            log_debug!("[DEBUG] NOTE: If Everything sent reply via SendMessageW, window_proc should have been called during SendMessageW");
            log_debug!("[DEBUG] NOTE: If Everything sent reply via PostMessage, we need to wait in message loop");

            if result == 0 {
                let last_error = windows_sys::Win32::Foundation::GetLastError();
                log_debug!("[DEBUG] ERROR: SendMessage returned FALSE, last error: {}", last_error);
                return Err(EverythingError::IpcFailed(format!("SendMessage 返回 FALSE, error: {}", last_error)));
            }
            
            // SendMessageW 返回后，Everything 可能已经发送了回复
            // 如果是通过 SendMessageW 发送的，窗口过程已经在 SendMessageW 期间被调用了
            // 如果是通过 PostMessage 发送的，需要在消息循环中等待
            log_debug!("[DEBUG] ===== CRITICAL: SendMessageW returned successfully =====");
            log_debug!("[DEBUG] If Everything sent reply via SendMessageW, window_proc should have been called");
            log_debug!("[DEBUG] If Everything sent reply via PostMessage, we need to wait in message loop");
            log_debug!("[DEBUG] Checking for any pending messages immediately after SendMessageW...");
            
            let mut msg = MSG {
                hwnd: 0,
                message: 0,
                wParam: 0,
                lParam: 0,
                time: 0,
                pt: POINT { x: 0, y: 0 },
            };
            
            // 尝试立即获取一条消息（非阻塞）
            let has_msg = PeekMessageW(&mut msg, 0, 0, 0, PM_NOREMOVE);
            if has_msg != 0 {
                log_debug!("[DEBUG] Found pending message after SendMessageW: msg=0x{:X} ({}), hwnd={:?}", 
                    msg.message, msg.message, msg.hwnd);
            } else {
                log_debug!("[DEBUG] No pending messages immediately after SendMessageW");
            }
            
            log_debug!("[DEBUG] ===== SendMessageW completed, will wait for reply in message loop =====");
        }

        Ok(())
    }

    /// 处理消息循环，等待回复
    fn pump_messages(timeout: Duration) -> bool {
        let start = Instant::now();
        let mut message_count = 0;
        let mut wm_copydata_count = 0;
        
        unsafe {
            let mut msg = MSG {
                hwnd: 0,
                message: 0,
                wParam: 0,
                lParam: 0,
                time: 0,
                pt: POINT { x: 0, y: 0 },
            };

            while start.elapsed() < timeout {
                // 非阻塞检查消息 - 获取所有窗口的所有消息
                let has_message = PeekMessageW(
                    &mut msg,
                    0, // HWND_NULL - 获取所有窗口的消息
                    0, // 0 - 所有消息
                    0, // 0 - 所有消息
                    PM_REMOVE,
                );

                if has_message != 0 {
                    message_count += 1;
                    
                    // 记录重要消息
                    if msg.message == WM_COPYDATA {
                        wm_copydata_count += 1;
                        eprintln!("[DEBUG] pump_messages: Received WM_COPYDATA #{} in pump loop, hwnd: {:?}", 
                            wm_copydata_count, msg.hwnd);
                    }
                    // 只记录重要消息，减少日志噪音
                    // else if msg.message != WM_TIMER && msg.message != WM_PAINT {
                    //     eprintln!("[DEBUG] pump_messages: Received message {} (0x{:X}), hwnd: {:?}", 
                    //         msg.message, msg.message, msg.hwnd);
                    // }
                    
                    if msg.message == WM_QUIT {
                        eprintln!("[DEBUG] pump_messages: Received WM_QUIT, exiting");
                        return false;
                    }
                    
                    // 只在处理 WM_COPYDATA 时输出详细日志
                    if msg.message == WM_COPYDATA {
                        eprintln!("[DEBUG] pump_messages: Dispatching WM_COPYDATA to hwnd {:?}", msg.hwnd);
                    }
                    TranslateMessage(&msg);
                    let result = DispatchMessageW(&msg);
                    if msg.message == WM_COPYDATA {
                        eprintln!("[DEBUG] pump_messages: DispatchMessageW returned: {}", result);
                    }
                } else {
                    // 没有消息，短暂休眠
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
        
        // 只在收到 WM_COPYDATA 时才输出完成日志
        if wm_copydata_count > 0 {
            eprintln!("[DEBUG] pump_messages completed: processed {} messages ({} WM_COPYDATA), elapsed: {:?}", 
                message_count, wm_copydata_count, start.elapsed());
        }
        true
    }

    /// 搜索文件（使用 Everything IPC）
    pub fn search_files(query: &str, max_results: usize) -> Result<Vec<EverythingResult>, EverythingError> {
        log_debug!("[DEBUG] ===== search_files called =====");
        log_debug!("[DEBUG] Query: '{}', max_results: {}", query, max_results);
        
        // 验证查询字符串
        if query.trim().is_empty() {
            log_debug!("[DEBUG] ERROR: Query is empty");
            return Err(EverythingError::InvalidQuery("查询字符串不能为空".to_string()));
        }

        // 检查 Everything 是否运行（只查找一次）
        log_debug!("[DEBUG] Checking if Everything service is running...");
        let everything_hwnd = find_everything_window()
            .ok_or_else(|| {
                log_debug!("[DEBUG] ERROR: Everything service is not running");
                EverythingError::ServiceNotRunning
            })?;
        log_debug!("[DEBUG] Everything service is running, window: {:?}", everything_hwnd);

        // 创建 IPC 句柄
        log_debug!("[DEBUG] Creating IPC handle...");
        let ipc_handle = EverythingIpcHandle::new()
            .map_err(|e| {
                log_debug!("[DEBUG] ERROR: Failed to create IPC handle: {:?}", e);
                e
            })?;
        log_debug!("[DEBUG] IPC handle created successfully, reply_hwnd: {:?}", ipc_handle.reply_hwnd);

        // 发送搜索查询（传递已找到的窗口句柄）
        log_debug!("[DEBUG] Sending search query...");
        send_search_query(query, max_results as u32, ipc_handle.reply_hwnd, everything_hwnd)
            .map_err(|e| {
                log_debug!("[DEBUG] ERROR: Failed to send search query: {:?}", e);
                e
            })?;
        log_debug!("[DEBUG] Search query sent successfully");

        // 等待结果（最多 5 秒）
        let timeout = Duration::from_secs(5);
        let start = Instant::now();
        let mut iteration = 0;
        
        log_debug!("[DEBUG] Waiting for results (timeout: {:?})...", timeout);
        loop {
            iteration += 1;
            if iteration % 10 == 0 {
                log_debug!("[DEBUG] Still waiting for results, elapsed: {:?}", start.elapsed());
            }
            
            // 处理消息
            pump_messages(Duration::from_millis(100));

            // 检查是否有结果
            match ipc_handle.result_receiver.try_recv() {
                Ok(Ok(paths)) => {
                    log_debug!("[DEBUG] Received {} paths from Everything IPC", paths.len());
                    // 转换路径为 EverythingResult
                    let mut results = Vec::new();
                    for (idx, path) in paths.iter().enumerate() {
                        if results.len() >= max_results {
                            log_debug!("[DEBUG] Reached max_results limit, stopping");
                            break;
                        }

                        let path_buf = PathBuf::from(path);
                        let name = path_buf
                            .file_name()
                            .and_then(|n| n.to_str())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| path.clone());

                        let metadata = std::fs::metadata(path).ok();
                        let size = metadata.as_ref()
                            .and_then(|m| if m.is_file() { Some(m.len()) } else { None });
                        
                        let date_modified = metadata.as_ref()
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs().to_string());

                        let is_folder = metadata.as_ref().map(|m| m.is_dir());

                        results.push(EverythingResult {
                            path: path.clone(),
                            name,
                            size,
                            date_modified,
                            is_folder,
                        });
                        
                        if idx < 5 {
                            eprintln!("[DEBUG] Processed result {}: {}", idx + 1, path);
                        }
                    }

                    log_debug!("[DEBUG] Returning {} results", results.len());
                    log_debug!("[DEBUG] ===== search_files completed =====");
                    return Ok(results);
                }
                Ok(Err(e)) => {
                    log_debug!("[DEBUG] ERROR: Received error in result channel: {:?}", e);
                    return Err(e);
                }
                Err(mpsc::TryRecvError::Empty) => {
                    // 继续等待
                    if start.elapsed() > timeout {
                        log_debug!("[DEBUG] ERROR: Timeout waiting for results after {:?}", start.elapsed());
                        return Err(EverythingError::Timeout);
                    }
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    log_debug!("[DEBUG] ERROR: Result channel disconnected");
                    return Err(EverythingError::IpcFailed("通道已断开".to_string()));
                }
            }
        }
    }

    /// 检查 Everything 是否可用
    pub fn is_everything_available() -> bool {
        check_everything_service_running()
    }

    /// 获取 Everything 可用性状态和错误信息
    pub fn check_everything_status() -> (bool, Option<String>) {
        if check_everything_service_running() {
            (true, None)
        } else {
            (false, Some("SERVICE_NOT_RUNNING".to_string()))
        }
    }

    /// 获取 Everything 路径（返回 Everything.exe 路径）
    pub fn get_everything_path() -> Option<PathBuf> {
        find_everything_main_exe()
    }
}
