#[cfg(target_os = "windows")]
pub mod windows {
    use std::sync::mpsc;
    use std::thread;
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        UI::WindowsAndMessaging::{
            DispatchMessageW, GetMessageW, TranslateMessage,
            MSG,
        },
    };
    
    // These functions are in user32.dll but not exposed in windows-sys
    extern "system" {
        fn RegisterHotKey(hWnd: HWND, id: i32, fsModifiers: u32, vk: u32) -> i32;
        fn UnregisterHotKey(hWnd: HWND, id: i32) -> i32;
    }
    
    const MOD_ALT: u32 = 0x0001;

    const HOTKEY_ID_ALT_SPACE: i32 = 1;
    const HOTKEY_ID_ESC: i32 = 2;
    const VK_SPACE: u32 = 0x20;
    const VK_ESCAPE: u32 = 0x1B;

    pub fn start_hotkey_listener(
        sender: mpsc::Sender<()>,
    ) -> Result<thread::JoinHandle<()>, String> {
        let handle = thread::spawn(move || {
            unsafe {
                use windows_sys::Win32::UI::WindowsAndMessaging::{
                    CreateWindowExW, RegisterClassW, UnregisterClassW,
                    CW_USEDEFAULT, WS_OVERLAPPED, WNDCLASSW,
                };
                use std::ffi::OsStr;
                use std::os::windows::ffi::OsStrExt;

                // Create a window class
                let class_name: Vec<u16> = OsStr::new("ReFastHotkeyWindow")
                    .encode_wide()
                    .chain(Some(0))
                    .collect();

                let wc = WNDCLASSW {
                    style: 0,
                    lpfnWndProc: Some(hotkey_wnd_proc),
                    cbClsExtra: 0,
                    cbWndExtra: 0,
                    hInstance: 0,
                    hIcon: 0,
                    hCursor: 0,
                    hbrBackground: 0,
                    lpszMenuName: std::ptr::null(),
                    lpszClassName: class_name.as_ptr(),
                };

                let atom = RegisterClassW(&wc);
                if atom == 0 {
                    eprintln!("Failed to register window class");
                    return;
                }

                // Create a hidden window
                let hwnd = CreateWindowExW(
                    0,
                    class_name.as_ptr(),
                    std::ptr::null(),
                    WS_OVERLAPPED,
                    CW_USEDEFAULT,
                    CW_USEDEFAULT,
                    CW_USEDEFAULT,
                    CW_USEDEFAULT,
                    0,
                    0,
                    0,
                    std::ptr::null_mut(),
                );

                if hwnd == 0 {
                    eprintln!("Failed to create hotkey window");
                    let _ = UnregisterClassW(class_name.as_ptr(), 0);
                    return;
                }

                // Store sender in window user data
                let sender_ptr = Box::into_raw(Box::new(sender));
                windows_sys::Win32::UI::WindowsAndMessaging::SetWindowLongPtrW(
                    hwnd,
                    windows_sys::Win32::UI::WindowsAndMessaging::GWLP_USERDATA,
                    sender_ptr as isize,
                );

                // Register hotkey
                let result = RegisterHotKey(
                    hwnd,
                    HOTKEY_ID_ALT_SPACE,
                    MOD_ALT,
                    VK_SPACE,
                );

                if result == 0 {
                    eprintln!("Failed to register global hotkey");
                    // Free the sender pointer before cleanup
                    let sender_ptr = windows_sys::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                        hwnd,
                        windows_sys::Win32::UI::WindowsAndMessaging::GWLP_USERDATA,
                    ) as *mut mpsc::Sender<()>;
                    if !sender_ptr.is_null() {
                        let _ = Box::from_raw(sender_ptr);
                    }
                    let _ = UnregisterClassW(class_name.as_ptr(), 0);
                    return;
                }

                // Message loop
                let mut msg = MSG {
                    hwnd: 0,
                    message: 0,
                    wParam: 0,
                    lParam: 0,
                    time: 0,
                    pt: windows_sys::Win32::Foundation::POINT { x: 0, y: 0 },
                };

                loop {
                    // Use NULL (0) to receive messages for all windows in the thread
                    let result = GetMessageW(&mut msg, 0, 0, 0);
                    
                    if result == 0 {
                        // WM_QUIT
                        break;
                    }
                    
                    if result == -1 {
                        // Error
                        eprintln!("GetMessage error");
                        break;
                    }

                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }

                // Cleanup
                let _ = UnregisterHotKey(hwnd, HOTKEY_ID_ALT_SPACE);
                
                // Free the sender pointer
                let sender_ptr = windows_sys::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                    hwnd,
                    windows_sys::Win32::UI::WindowsAndMessaging::GWLP_USERDATA,
                ) as *mut mpsc::Sender<()>;
                if !sender_ptr.is_null() {
                    let _ = Box::from_raw(sender_ptr);
                }
                
                let _ = UnregisterClassW(class_name.as_ptr(), 0);
            }
        });

        Ok(handle)
    }

    unsafe extern "system" fn hotkey_wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        _lparam: LPARAM,
    ) -> LRESULT {
        use windows_sys::Win32::UI::WindowsAndMessaging::{WM_HOTKEY, WM_DESTROY, PostQuitMessage, DefWindowProcW};

        match msg {
            WM_HOTKEY => {
                if wparam == HOTKEY_ID_ALT_SPACE as usize {
                    // Get sender from window user data
                    let sender_ptr = windows_sys::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                        hwnd,
                        windows_sys::Win32::UI::WindowsAndMessaging::GWLP_USERDATA,
                    ) as *mut mpsc::Sender<()>;
                    
                    if !sender_ptr.is_null() {
                        let sender = &*sender_ptr;
                        let _ = sender.send(());
                    }
                }
                0
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, _lparam),
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub mod windows {
    use std::sync::mpsc;
    use std::thread;

    pub fn start_hotkey_listener(
        _sender: mpsc::Sender<()>,
    ) -> Result<thread::JoinHandle<()>, String> {
        Err("Hotkey listener is only supported on Windows".to_string())
    }
}

