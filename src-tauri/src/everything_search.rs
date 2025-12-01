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

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct EverythingSearchResponse {
    pub results: Vec<EverythingResult>,
    pub total_count: u32,
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
                write!(
                    f,
                    "SERVICE_NOT_RUNNING:Everything 服务未运行，请启动 Everything 主程序"
                )
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
    use std::ffi::OsStr;
    use std::fs::{File, OpenOptions};
    use std::io::Write;
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use std::ptr;
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::System::DataExchange::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    // Everything IPC 常量
    // Everything v1.4 使用 EVERYTHING_TASKBAR_NOTIFICATION 窗口类进行 IPC
    const EVERYTHING_IPC_WNDCLASS: &str = "EVERYTHING_TASKBAR_NOTIFICATION";
    // Everything 1.4+ 新协议 QueryW (Unicode/Wide Char 版本)
    const EVERYTHING_IPC_COPYDATAQUERYW: usize = 2; // Unicode 查询命令（必须使用 2，不是 0x10001）
    const EVERYTHING_IPC_REPLY: u32 = 2;
    const COPYDATA_QUERYCOMPLETE: u32 = 0x804E; // 新协议必须使用 0x804E

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
        reply_hwnd: u32,             // HWND cast to u32 (DWORD) - 4 bytes
        reply_copydata_message: u32, // DWORD - 必须填 0x804E
        search_flags: u32,           // DWORD - 4 bytes
        reply_offset: u32,           // DWORD - 新增字段！通常填 0
        max_results: u32,            // DWORD - 4 bytes
                                     // search_string follows as WCHAR[] (UTF-16), must end with 0,0
                                     // 注意：结构体后面紧跟着 UTF-16 字符串，没有额外的对齐
    }

    // Everything IPC 回复结构体（根据官方头文件 everything_ipc.h）
    // 对应 EVERYTHING_IPC_LISTW 结构体
    // 总大小：28 字节（7 * DWORD）
    #[repr(C)]
    #[derive(Debug, Clone, Copy)]
    struct EverythingIpcList {
        totfolders: u32, // Offset 0  - DWORD - 找到的文件夹总数
        totfiles: u32,   // Offset 4  - DWORD - 找到的文件总数
        totitems: u32,   // Offset 8  - DWORD - totfolders + totfiles
        numfolders: u32, // Offset 12 - DWORD - 当前返回的文件夹数
        numfiles: u32,   // Offset 16 - DWORD - 当前返回的文件数
        numitems: u32,   // Offset 20 - DWORD - 当前返回的 item 数
        offset: u32,     // Offset 24 - DWORD - 第一个结果在 item 列表中的索引偏移
                         // items[] follows at offset 28
    }

    // Everything IPC Item 结构体（根据官方头文件 everything_ipc.h）
    // 对应 EVERYTHING_IPC_ITEMW 结构体
    // 总大小：12 字节（3 * DWORD）
    #[repr(C)]
    #[derive(Debug, Clone, Copy)]
    struct EverythingIpcItem {
        flags: u32,           // DWORD - item 标志（EVERYTHING_IPC_FOLDER | EVERYTHING_IPC_DRIVE | EVERYTHING_IPC_ROOT）
        filename_offset: u32, // DWORD - 文件名从 list 结构起始地址开始的字节偏移
        path_offset: u32,     // DWORD - 路径从 list 结构起始地址开始的字节偏移
    }

    // 全局状态：存储每个窗口句柄对应的发送器
    use std::collections::HashMap;

    static WINDOW_SENDERS: OnceLock<
        Arc<
            Mutex<
                HashMap<HWND, mpsc::Sender<Result<(Vec<String>, u32, u32, u32), EverythingError>>>,
            >,
        >,
    > = OnceLock::new();

    // 日志文件（使用应用数据目录下的 logs 文件夹，按天生成）
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
                        "[DEBUG] ERROR: Failed to create log directory {}: {}",
                        log_dir.display(),
                        e
                    );
                }
                
                let log_path = log_dir.join(format!("everything-ipc-{}.log", today));

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
                    eprintln!(
                        "[DEBUG] ERROR: Failed to create log file at {}",
                        log_path.display()
                    );
                }

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
            if let Err(e) = std::fs::create_dir_all(&log_dir) {
                eprintln!(
                    "[DEBUG] ERROR: Failed to create log directory {}: {}",
                    log_dir.display(),
                    e
                );
            }
            
            let log_path = log_dir.join(format!("everything-ipc-{}.log", today));
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

    fn get_window_senders() -> &'static Arc<
        Mutex<HashMap<HWND, mpsc::Sender<Result<(Vec<String>, u32, u32, u32), EverythingError>>>>,
    > {
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
        CACHED_WINDOW
            .get_or_init(|| {
                Arc::new(Mutex::new(CachedEverythingWindow {
                    hwnd: None,
                    timestamp: Instant::now() - CACHE_DURATION, // 初始化为过期
                }))
            })
            .clone()
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

        // 只记录重要消息，忽略常见的系统消息以减少日志噪音

        match msg {
            WM_COPYDATA => {
                let cds = ptr::read(lparam as *const COPYDATASTRUCT);

                // Everything 回复时，dwData 通常是 EVERYTHING_IPC_REPLY (2)
                // 新协议也可能使用我们发送的 reply_copydata_message 值
                // 为了兼容性，我们检查多种可能
                let is_reply = cds.dwData == EVERYTHING_IPC_REPLY as usize
                    || cds.dwData == COPYDATA_QUERYCOMPLETE as usize
                    || cds.dwData == 0x804E; // 兼容新协议可能的回复值

                if is_reply {
                    // 解析结果（现在返回四元组：结果列表, 总条数, 当前页条数, 当前页偏移量）
                    let result = parse_ipc_reply(&cds);
                    match &result {
                        Ok((paths, tot, num, _off)) => {
                            // 只在批次数量很大或出错时输出详细日志，减少日志噪音
                            if *tot > 100_000 || paths.len() != *num as usize {
                                log_debug!("[DEBUG] Parsed result: {} paths (Total: {}, This batch: {})", paths.len(), tot, num);
                            }
                        }
                        Err(e) => {
                            log_debug!("[DEBUG] Parsed result error: {:?}", e);
                        }
                    }

                    // 获取对应的发送器并发送结果
                    let senders = get_window_senders();
                    if let Ok(senders_guard) = senders.lock() {
                        if let Some(sender) = senders_guard.get(&hwnd) {
                            if let Err(e) = sender.send(result) {
                                log_debug!(
                                    "[DEBUG] ERROR: Failed to send result to channel: {:?}",
                                    e
                                );
                            }
                        } else {
                            log_debug!("[DEBUG] WARNING: No sender found for hwnd: {:?}", hwnd);
                        }
                    } else {
                        log_debug!("[DEBUG] ERROR: Failed to lock senders mutex");
                    }
                } else {
                    log_debug!("[DEBUG] Unexpected dwData value: {} (expected EVERYTHING_IPC_REPLY={} or COPYDATA_QUERYCOMPLETE={})", 
                        cds.dwData, EVERYTHING_IPC_REPLY, COPYDATA_QUERYCOMPLETE);
                }
                1 // TRUE - 消息已处理
            }
            WM_DESTROY => {
                // 清理发送器
                let senders = get_window_senders();
                if let Ok(mut senders_guard) = senders.lock() {
                    senders_guard.remove(&hwnd);
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
        result_receiver: mpsc::Receiver<Result<(Vec<String>, u32, u32, u32), EverythingError>>,
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
                        eprintln!(
                            "[DEBUG] WARNING: RegisterClassW returned 0, error: {}",
                            last_error
                        );
                    } else {
                        eprintln!(
                            "[DEBUG] Window class registered successfully, atom: {}",
                            atom
                        );
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
                    eprintln!(
                        "[DEBUG] ERROR: CreateWindowExW returned 0, error: {}",
                        last_error
                    );
                    return Err(EverythingError::IpcFailed(format!(
                        "无法创建消息窗口, error: {}",
                        last_error
                    )));
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
        let mut result: Vec<u16> = OsStr::new(s).encode_wide().collect();
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

    /// 从 u16 指针读取 UTF-16 字符串（辅助函数）
    unsafe fn read_u16_string(str_ptr: *const u16, max_chars: usize) -> String {
        let mut chars = Vec::new();
        let mut len = 0;

        while len < max_chars {
            let wchar = *str_ptr.add(len);
            if wchar == 0 {
                break;
            }
            chars.push(wchar);
            len += 1;
        }

        if !chars.is_empty() {
            from_wide_string(&chars)
        } else {
            String::new()
        }
    }

    /// 安全读取 UTF-16 字符串（从基地址 + 偏移量）
    /// 允许 offset == 0（表示空字符串）
    /// offset 必须是相对于整个 EVERYTHING_IPC_LIST 结构起始地址的字节偏移
    unsafe fn read_u16_string_at_offset(
        base: *const u8,
        offset: u32,
        max_len: usize,
        data_size: u32,
    ) -> Option<String> {
        // offset == 0 表示空字符串，这是一个合法值
        if offset == 0 {
            return Some(String::new());
        }

        // 边界检查：确保偏移量在有效范围内
        if offset as usize >= data_size as usize {
            log_debug!(
                "[DEBUG] ERROR: offset {} exceeds data size {}",
                offset,
                data_size
            );
            return None;
        }

        // 奇数 offset 是解析错误，Everything 不会返回奇数 offset
        // UTF-16 字符串必须 2 字节对齐
        if offset % 2 != 0 {
            log_debug!(
                "[DEBUG] ERROR: Invalid odd offset {} - this indicates a parsing bug! \
                Everything should never return odd offsets. Check struct layout and base address calculation.",
                offset
            );
            return None; // 直接返回错误，不要尝试"修复"
        }

        // 直接使用 offset，不需要对齐
        let str_ptr = base.add(offset as usize) as *const u16;

        // 计算最大可读取的字符数（防止越界）
        let max_chars = ((data_size as usize - offset as usize) / 2).min(max_len);

        Some(read_u16_string(str_ptr, max_chars))
    }

    /// 解析 Everything IPC 回复（官方协议）
    /// 返回 (结果列表, 总条数, 当前页条数, 当前页偏移量)
    fn parse_ipc_reply(
        cds: &COPYDATASTRUCT,
    ) -> Result<(Vec<String>, u32, u32, u32), EverythingError> {
        // 验证结构体大小（根据官方头文件，应该是 28 字节）
        let expected_list_size = 28u32; // 7 * DWORD = 28 字节
        let actual_list_size = std::mem::size_of::<EverythingIpcList>() as u32;
        if actual_list_size != expected_list_size {
            log_debug!(
                "[DEBUG] ERROR: EverythingIpcList size mismatch! Expected {}, got {}. This will cause parsing errors!",
                expected_list_size,
                actual_list_size
            );
        }

        let expected_item_size = 12u32; // 3 * u32 = 12 字节
        let actual_item_size = std::mem::size_of::<EverythingIpcItem>() as u32;
        if actual_item_size != expected_item_size {
            log_debug!(
                "[DEBUG] ERROR: EverythingIpcItem size is {} bytes, expected 12! This will cause parsing errors.",
                actual_item_size
            );
        }

        let list_size = actual_list_size;

        if cds.cbData < list_size {
            log_debug!(
                "[DEBUG] ERROR: Reply data too short: {} < {}",
                cds.cbData,
                list_size
            );
            return Err(EverythingError::IpcFailed("回复数据太短".to_string()));
        }

        unsafe {
            // 读取 EverythingIpcList 结构体（根据官方头文件：28 字节头部）
            let list_ptr = cds.lpData as *const EverythingIpcList;
            let list = &*list_ptr;

            let totfolders = list.totfolders; // Offset 0
            let totfiles = list.totfiles;     // Offset 4
            let totitems = list.totitems;     // Offset 8 - totfolders + totfiles
            let numfolders = list.numfolders; // Offset 12
            let numfiles = list.numfiles;     // Offset 16
            let numitems = list.numitems;     // Offset 20 - 当前返回的 item 数
            let offset = list.offset;         // Offset 24 - 第一个结果在 item 列表中的索引偏移

            // 验证读取的值是否合理（只检查 totitems，不限制 numitems，因为分页时 numitems 是批次大小）
            if totitems > 10_000_000 {
                log_debug!(
                    "[DEBUG] ERROR: TotItems {} is suspicious (>10M), aborting parse.",
                    totitems
                );
                return Err(EverythingError::IpcFailed(format!(
                    "总结果数异常: {} (超过合理范围)",
                    totitems
                )));
            }

            // 如果 totitems 和 numitems 为 0，直接返回空结果
            if numitems == 0 {
                return Ok((Vec::new(), totitems, 0, offset));
            }

            // 处理所有返回的 item（不再限制）
            let items_to_process = numitems;

            // 计算 Items 起始位置（根据官方头文件：Items 数组紧跟在 28 字节的 Header 之后）
            let items_start_offset = 28;
            let base_addr = cds.lpData as usize;
            let items_ptr = (base_addr + items_start_offset) as *const EverythingIpcItem;

            // 验证数据大小是否足够容纳所有 items
            let items_size = (items_to_process as usize) * std::mem::size_of::<EverythingIpcItem>();
            let min_required_size = items_start_offset + items_size;
            if cds.cbData < min_required_size as u32 {
                log_debug!(
                    "[DEBUG] ERROR: Reply data too small for {} items: {} < {} bytes",
                    items_to_process,
                    cds.cbData,
                    min_required_size
                );
                return Err(EverythingError::IpcFailed(format!(
                    "回复数据大小不足: 需要 {} 字节，实际只有 {} 字节",
                    min_required_size, cds.cbData
                )));
            }

            // 根据官方头文件：filename_offset 和 path_offset 都是从 EVERYTHING_IPC_LIST 结构起始地址（lpData）开始的字节偏移
            // 使用宏定义：EVERYTHING_IPC_ITEMFILENAMEW(list,item) = (WCHAR *)((CHAR *)(list) + item->filename_offset)
            // 使用宏定义：EVERYTHING_IPC_ITEMPATHW(list,item) = (WCHAR *)((CHAR *)(list) + item->path_offset)

            let mut results = Vec::new();
            let mut skipped_count = 0;
            let mut invalid_offset_count = 0;

            // 遍历每个 item
            for i in 0..items_to_process {
                let current_item_ptr = items_ptr.add(i as usize);

                // 边界检查：防止读取超出 cbData 范围
                let item_size = std::mem::size_of::<EverythingIpcItem>();
                if (current_item_ptr as usize) + item_size > base_addr + cds.cbData as usize {
                    log_debug!("[DEBUG] Reached end of buffer at item {}, stopping", i);
                    break;
                }

                let item = &*current_item_ptr;
                let flags = item.flags;
                let filename_offset = item.filename_offset;
                let path_offset = item.path_offset;

                // 验证读取的 offset 值是否合理（只记录错误）
                if filename_offset != 0 && filename_offset % 2 != 0 {
                    log_debug!(
                        "[DEBUG] ERROR: Item {} has odd filename_offset={} - struct parsing may be wrong!",
                        i, filename_offset
                    );
                }
                if path_offset != 0 && path_offset % 2 != 0 {
                    log_debug!(
                        "[DEBUG] ERROR: Item {} has odd path_offset={} - struct parsing may be wrong!",
                        i, path_offset
                    );
                }

                // 解析文件名（允许 offset=0 表示空）
                let filename = if filename_offset == 0 {
                    String::new() // offset=0 表示空
                } else if (filename_offset as usize) < cds.cbData as usize {
                    match read_u16_string_at_offset(
                        cds.lpData as *const u8,
                        filename_offset,
                        32767,
                        cds.cbData,
                    ) {
                        Some(s) => s,
                        None => {
                            invalid_offset_count += 1;
                            if i < 10 {
                                log_debug!(
                                    "[DEBUG] WARNING: Item {} filename_offset={} failed to read",
                                    i,
                                    filename_offset
                                );
                            }
                            String::from("[Invalid Offset]")
                        }
                    }
                } else {
                    invalid_offset_count += 1;
                    if i < 10 {
                        log_debug!(
                            "[DEBUG] WARNING: Item {} filename_offset={} exceeds data size",
                            i,
                            filename_offset
                        );
                    }
                    String::from("[Invalid Offset]")
                };

                // 解析路径部分（允许 offset=0 表示空，例如根目录）
                let path_part = if path_offset == 0 {
                    String::new() // offset=0 表示空（例如根目录）
                } else if (path_offset as usize) < cds.cbData as usize {
                    match read_u16_string_at_offset(
                        cds.lpData as *const u8,
                        path_offset,
                        32767,
                        cds.cbData,
                    ) {
                        Some(s) => s,
                        None => {
                            // path offset 无效不应该导致整个 item 丢弃，给个空值即可
                            if i < 10 {
                                log_debug!("[DEBUG] WARNING: Item {} path_offset={} failed to read, using empty path", i, path_offset);
                            }
                            String::new()
                        }
                    }
                } else {
                    // path offset 超出范围，使用空路径
                    if i < 10 {
                        log_debug!("[DEBUG] WARNING: Item {} path_offset={} exceeds data size, using empty path", i, path_offset);
                    }
                    String::new()
                };

                // 如果文件名是无效标记，跳过这个 item
                if filename == "[Invalid Offset]" {
                    skipped_count += 1;
                    if i < 10 {
                        log_debug!(
                            "[DEBUG] WARNING: Item {} has invalid filename offset, skipping",
                            i
                        );
                    }
                    continue;
                }

                // 拼接完整路径：path + filename
                // Everything 返回的 path 是父目录，filename 是文件名
                let full_path = if path_part.is_empty() {
                    filename.clone()
                } else if filename.is_empty() {
                    path_part.clone()
                } else {
                    // 处理 Windows 驱动器号的情况（如 "D:" 需要变成 "D:\"）
                    let normalized_path = if path_part.len() == 2 && path_part.ends_with(':') {
                        format!("{}\\", path_part)
                    } else if !path_part.ends_with('\\') && !path_part.ends_with('/') {
                        format!("{}\\", path_part)
                    } else {
                        path_part.clone()
                    };
                    
                    // 使用 PathBuf 来正确拼接路径
                    let path_buf = PathBuf::from(&normalized_path);
                    if let Some(joined) = path_buf.join(&filename).to_str() {
                        joined.to_string()
                    } else {
                        // 如果路径包含无效字符，使用简单拼接
                        format!("{}{}", normalized_path, filename)
                    }
                };

                // 只有当文件名或路径至少有一个有效时才添加结果
                if !filename.is_empty() || !path_part.is_empty() {
                    // 只在出错时输出详细日志
                    results.push(full_path);
                } else {
                    skipped_count += 1;
                    // 性能优化：减少日志输出
                    // if i < 10 {
                    //     log_debug!("[DEBUG] WARNING: Item {} has empty path and filename, skipping", i);
                    // }
                }
            }

            // 只在出错或批次很大时输出解析摘要，减少日志噪音
            if skipped_count > 0 || invalid_offset_count > 0 || items_to_process > 5000 {
                log_debug!(
                    "[DEBUG] Parse summary: Total items={}, Parsed={}, Skipped={}, Invalid offsets={}",
                    items_to_process,
                    results.len(),
                    skipped_count,
                    invalid_offset_count
                );
            }

            // 返回四元组：(结果列表, 总条数, 当前页条数, 当前页偏移量)
            Ok((results, totitems, numitems, offset))
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
            // Everything v1.4 使用 EVERYTHING_TASKBAR_NOTIFICATION 窗口类进行 IPC
            let class_name = wide_string(EVERYTHING_IPC_WNDCLASS);
            log_debug!(
                "[DEBUG] Looking for Everything IPC window with class: {}",
                EVERYTHING_IPC_WNDCLASS
            );
            let hwnd = FindWindowW(class_name.as_ptr(), ptr::null());

            let result = if hwnd != 0 {
                log_debug!("[DEBUG] Everything IPC window found: {:?}", hwnd);
                Some(hwnd)
            } else {
                log_debug!("[DEBUG] Everything IPC window NOT found (FindWindowW returned 0)");
                let last_error = windows_sys::Win32::Foundation::GetLastError();
                log_debug!("[DEBUG] Last error: {}", last_error);
                log_debug!("[DEBUG] Please ensure Everything is running");
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
            .replace('\'', "''") // PowerShell 中单引号需要双写来转义
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
                        eprintln!(
                            "[DEBUG] PowerShell error: {}",
                            String::from_utf8_lossy(&output.stderr)
                        );
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
        offset: u32, // 新增参数：分页偏移量
        reply_hwnd: HWND,
        everything_hwnd: HWND,
    ) -> Result<(), EverythingError> {
        // 将查询字符串转换为 UTF-16（以双 0 结尾）
        let query_wide = wide_string(query);
        // 验证字符串以双 0 结尾
        if query_wide.len() < 2
            || query_wide[query_wide.len() - 2] != 0
            || query_wide[query_wide.len() - 1] != 0
        {
            log_debug!("[DEBUG] WARNING: Query string does not end with double null!");
        }

        // 计算结构体大小（Everything 1.4+ QueryW 协议）
        let base_size = std::mem::size_of::<EverythingIpcQueryW>();
        let string_size = query_wide.len() * std::mem::size_of::<u16>();
        let struct_size = base_size + string_size;

        // 分配内存
        let mut query_data = vec![0u8; struct_size];
        let query_ptr = query_data.as_mut_ptr() as *mut EverythingIpcQueryW;

        unsafe {
            // 按照 Everything 1.4+ QueryW 协议顺序填充结构体
            // 顺序：reply_hwnd, reply_copydata_message (0x804E), search_flags, reply_offset, max_results
            (*query_ptr).reply_hwnd = reply_hwnd as u32; // HWND 转换为 u32
            (*query_ptr).reply_copydata_message = COPYDATA_QUERYCOMPLETE; // 必须填 0x804E
            (*query_ptr).search_flags = 0; // 默认标志
            (*query_ptr).reply_offset = offset; // 使用传入的 offset 参数
            (*query_ptr).max_results = max_results;

            // 复制查询字符串到结构体后面
            let search_string_ptr = (query_ptr as *mut u8).add(base_size) as *mut u16;
            ptr::copy_nonoverlapping(query_wide.as_ptr(), search_string_ptr, query_wide.len());
        }

        // 创建 COPYDATASTRUCT（Everything 1.4+ 使用 QueryW 协议）
        let mut cds = COPYDATASTRUCT {
            dwData: EVERYTHING_IPC_COPYDATAQUERYW, // 关键！必须是 2 (EVERYTHING_IPC_COPYDATAQUERYW)
            cbData: struct_size as u32,
            lpData: query_data.as_mut_ptr() as *mut std::ffi::c_void,
        };


        // 发送消息
        unsafe {
            // 验证窗口句柄是否有效
            use windows_sys::Win32::UI::WindowsAndMessaging::IsWindow;
            let window_valid = IsWindow(everything_hwnd);

            if window_valid == 0 {
                return Err(EverythingError::IpcFailed(format!(
                    "Everything 窗口句柄无效: {:?}",
                    everything_hwnd
                )));
            }

            // SendMessageW 是同步的，会阻塞直到 Everything 处理完消息
            // 如果 Everything 在 SendMessageW 期间调用 SendMessageW 发送回复到我们的窗口，
            // 我们的窗口过程会被 Everything 的线程调用，而不是在消息循环中
            let result = SendMessageW(
                everything_hwnd,
                WM_COPYDATA,
                reply_hwnd as WPARAM,
                &mut cds as *mut COPYDATASTRUCT as LPARAM,
            );

            if result == 0 {
                let last_error = windows_sys::Win32::Foundation::GetLastError();
                log_debug!(
                    "[DEBUG] ERROR: SendMessage returned FALSE, last error: {}",
                    last_error
                );
                return Err(EverythingError::IpcFailed(format!(
                    "SendMessage 返回 FALSE, error: {}",
                    last_error
                )));
            }

            // SendMessageW 返回后，Everything 可能已经发送了回复
            // 如果是通过 SendMessageW 发送的，窗口过程已经在 SendMessageW 期间被调用了
            // 如果是通过 PostMessage 发送的，需要在消息循环中等待
            // 移除详细的 SendMessageW 日志，减少日志噪音
            // 这些日志在正常运行时不需要，只在调试时有用
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
                    &mut msg, 0, // HWND_NULL - 获取所有窗口的消息
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
                        eprintln!(
                            "[DEBUG] pump_messages: Dispatching WM_COPYDATA to hwnd {:?}",
                            msg.hwnd
                        );
                    }
                    TranslateMessage(&msg);
                    let result = DispatchMessageW(&msg);
                    if msg.message == WM_COPYDATA {
                        eprintln!(
                            "[DEBUG] pump_messages: DispatchMessageW returned: {}",
                            result
                        );
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
    /// 
    /// # Arguments
    /// * `query` - 搜索查询字符串
    /// * `max_results` - 最大结果数量
    /// * `cancelled` - 可选的取消标志，如果设置为 true，搜索将提前终止
    pub fn search_files(
        query: &str,
        max_results: usize,
        cancelled: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
    ) -> Result<EverythingSearchResponse, EverythingError> {
        log_debug!("[DEBUG] ===== search_files called =====");
        log_debug!("[DEBUG] Query: '{}', max_results: {}", query, max_results);

        // 验证查询字符串
        if query.trim().is_empty() {
            log_debug!("[DEBUG] ERROR: Query is empty");
            return Err(EverythingError::InvalidQuery(
                "查询字符串不能为空".to_string(),
            ));
        }

        // 检查 Everything 是否运行（只查找一次）
        log_debug!("[DEBUG] Checking if Everything service is running...");
        let everything_hwnd = find_everything_window().ok_or_else(|| {
            log_debug!("[DEBUG] ERROR: Everything service is not running");
            EverythingError::ServiceNotRunning
        })?;
        // 创建 IPC 句柄
        let ipc_handle = EverythingIpcHandle::new().map_err(|e| {
            log_debug!("[DEBUG] ERROR: Failed to create IPC handle: {:?}", e);
            e
        })?;

        // 分页参数
        let mut all_results = Vec::new();
        let mut current_offset = 0;
        let mut total_count: Option<u32> = None; // 保存第一次获取的总数
                                                 // 每次请求的批次大小（建议 2000，太大可能导致 IPC 缓冲区溢出）
        let batch_size = 2000;
        let timeout = Duration::from_secs(5);

        // 分页循环：直到获取所有结果
        let mut batch_count = 0;
        loop {
            // 检查是否被取消
            if let Some(cancel_flag) = cancelled {
                if cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
                    log_debug!("[DEBUG] Search cancelled by user");
                    return Err(EverythingError::Other("搜索已取消".to_string()));
                }
            }
            
            batch_count += 1;
            
            // 每100批次或每10万条记录输出一次进度，减少日志噪音
            // 第一次循环总是输出，让用户知道搜索开始了
            let should_log_detail = batch_count == 1 || batch_count % 100 == 0 || (current_offset > 0 && current_offset % 100_000 == 0);
            
            if should_log_detail {
                log_debug!(
                    "[DEBUG] Requesting batch #{}: offset={}, batch_size={}",
                    batch_count,
                    current_offset,
                    batch_size
                );
            }

            // 发送查询（带 offset）
            send_search_query(
                query,
                batch_size,
                current_offset, // 传入当前偏移
                ipc_handle.reply_hwnd,
                everything_hwnd,
            )
            .map_err(|e| {
                log_debug!("[DEBUG] ERROR: Failed to send search query: {:?}", e);
                e
            })?;

            if should_log_detail {
                log_debug!(
                    "[DEBUG] Search query sent successfully (offset={})",
                    current_offset
                );
            }

            // 等待回复
            let start = Instant::now();
            let mut iteration = 0;
            let mut batch_result: Option<Result<(Vec<String>, u32, u32, u32), EverythingError>> =
                None;

            loop {
                // 检查是否被取消
                if let Some(cancel_flag) = cancelled {
                    if cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
                        log_debug!("[DEBUG] Search cancelled while waiting for batch reply");
                        return Err(EverythingError::Other("搜索已取消".to_string()));
                    }
                }
                
                iteration += 1;
                if iteration % 10 == 0 {
                    log_debug!(
                        "[DEBUG] Still waiting for batch reply, elapsed: {:?}",
                        start.elapsed()
                    );
                }

                // 处理消息
                pump_messages(Duration::from_millis(100));

                // 检查是否有结果
                match ipc_handle.result_receiver.try_recv() {
                    Ok(result) => {
                        batch_result = Some(result);
                        break;
                    }
                    Err(mpsc::TryRecvError::Empty) => {
                        // 继续等待
                        if start.elapsed() > timeout {
                            log_debug!(
                                "[DEBUG] ERROR: Timeout waiting for batch reply after {:?}",
                                start.elapsed()
                            );
                            return Err(EverythingError::Timeout);
                        }
                    }
                    Err(mpsc::TryRecvError::Disconnected) => {
                        log_debug!("[DEBUG] ERROR: Result channel disconnected");
                        return Err(EverythingError::IpcFailed("通道已断开".to_string()));
                    }
                }
            }

            // 处理批次结果
            let (batch_paths, tot_items, num_items, reply_offset) = match batch_result {
                Some(Ok((paths, tot, num, off))) => (paths, tot, num, off),
                Some(Err(e)) => {
                    log_debug!("[DEBUG] ERROR: Received error in batch: {:?}", e);
                    return Err(e);
                }
                None => {
                    log_debug!("[DEBUG] ERROR: No batch result received");
                    return Err(EverythingError::Timeout);
                }
            };

            // 保存第一次获取的总数
            if total_count.is_none() {
                total_count = Some(tot_items);
            }

            // 转换路径为 EverythingResult
            for path in batch_paths.iter() {
                let path_buf = PathBuf::from(path);
                let name = path_buf
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| path.clone());

                // 性能优化：不查询文件元数据
                let size = None;
                let date_modified = None;
                let is_folder = None;

                all_results.push(EverythingResult {
                    path: path.clone(),
                    name,
                    size,
                    date_modified,
                    is_folder,
                });
            }

            // 更新偏移量：始终使用累积的结果数量作为下一次请求的 offset
            // 这是最可靠的分页方式：第一次请求 offset=0 获取93条，下次请求 offset=93，再下次 offset=186，以此类推
            // Everything 返回的 reply_offset 是它内部的偏移量，我们不应该依赖它
            let next_offset = all_results.len() as u32;
            current_offset = next_offset;

            // 检查退出条件
            // 条件1: 达到了用户设定的总最大限制
            if all_results.len() >= max_results {
                break;
            }

            // 条件2: 已获取所有结果（使用 tot_items 判断）
            if all_results.len() >= tot_items as usize {
                break;
            }

            // 条件3: 此次返回 0 条，但还有更多结果需要获取
            // 如果还有更多结果（accumulated < tot_items），尝试使用累积结果数作为 offset 继续
            if num_items == 0 {
                if all_results.len() < tot_items as usize {
                    // 尝试使用累积的结果数量作为新的 offset
                    current_offset = all_results.len() as u32;
                    // 继续循环，尝试新的 offset
                    continue;
                } else {
                    log_debug!("[DEBUG] EXIT: Received 0 items and all results fetched, stopping pagination");
                    break;
                }
            }

            // 如果没有退出，继续下一轮循环
            // 只在每100批次或每10万条记录时输出进度，减少日志噪音
            if should_log_detail {
                let remaining = (tot_items as usize).saturating_sub(all_results.len());
                let max_remaining = (max_results as usize).saturating_sub(all_results.len());
                let actual_remaining = remaining.min(max_remaining);
                log_debug!(
                    "[DEBUG] Progress: {}/{} items ({}%), batch #{}, remaining: {}",
                    all_results.len(),
                    tot_items.min(max_results as u32),
                    (all_results.len() * 100 / tot_items.min(max_results as u32) as usize),
                    batch_count,
                    actual_remaining
                );
            }
        }

        log_debug!(
            "[DEBUG] ===== search_files completed: {} total results =====",
            all_results.len()
        );

        // 返回结果和总数
        let total = total_count.unwrap_or(all_results.len() as u32);
        Ok(EverythingSearchResponse {
            results: all_results,
            total_count: total,
        })
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
