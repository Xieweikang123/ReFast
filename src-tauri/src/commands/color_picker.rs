//! 拾色器功能模块
//! 
//! 提供屏幕取色和拾色器窗口管理功能

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use std::sync::Once;

static INIT: Once = Once::new();

/// 预热函数：在后台预加载 Windows GDI 资源
#[cfg(target_os = "windows")]
pub fn warmup_color_picker() {
    INIT.call_once(|| {
        // 在后台线程预热，避免阻塞主线程
        std::thread::spawn(|| {
            unsafe {
                use windows_sys::Win32::UI::WindowsAndMessaging::{
                    CreateWindowExW, DestroyWindow, WS_EX_LAYERED, WS_EX_TOPMOST,
                    WS_EX_TOOLWINDOW, WS_POPUP,
                };
                use windows_sys::Win32::Graphics::Gdi::{
                    GetDC, ReleaseDC, CreateCompatibleDC, DeleteDC,
                    CreateFontW, DeleteObject, FW_NORMAL, DEFAULT_CHARSET,
                    OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, DEFAULT_QUALITY, FF_DONTCARE,
                };
                use windows_sys::Win32::Foundation::HWND;
                
                // 预创建窗口（加载窗口类和 DLL）
                let hwnd = CreateWindowExW(
                    WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                    "Static\0".encode_utf16().collect::<Vec<u16>>().as_ptr(),
                    std::ptr::null(),
                    WS_POPUP,
                    0, 0, 1, 1,
                    0 as HWND,
                    0,
                    0,
                    std::ptr::null(),
                );
                
                if hwnd != 0 {
                    // 预加载 GDI 资源
                    let dc = GetDC(0);
                    let mem_dc = CreateCompatibleDC(dc);
                    
                    // 预加载字体
                    let font = CreateFontW(
                        16, 0, 0, 0,
                        FW_NORMAL as i32,
                        0, 0, 0,
                        DEFAULT_CHARSET as u32,
                        OUT_DEFAULT_PRECIS as u32,
                        CLIP_DEFAULT_PRECIS as u32,
                        DEFAULT_QUALITY as u32,
                        FF_DONTCARE as u32,
                        "Segoe UI\0".encode_utf16().collect::<Vec<u16>>().as_ptr(),
                    );
                    
                    // 清理资源
                    if font != 0 {
                        DeleteObject(font);
                    }
                    DeleteDC(mem_dc);
                    ReleaseDC(0, dc);
                    DestroyWindow(hwnd);
                }
            }
        });
    });
}

#[cfg(not(target_os = "windows"))]
pub fn warmup_color_picker() {
    // 非 Windows 平台无需预热
}

// 全局标志：标记是否正在取色
#[cfg(target_os = "windows")]
static mut IS_COLOR_PICKING: bool = false;

// 鼠标钩子回调函数
#[cfg(target_os = "windows")]
unsafe extern "system" fn mouse_hook_proc(
    n_code: i32,
    w_param: usize,
    l_param: isize,
) -> isize {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_RBUTTONDOWN, 
        WM_RBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP,
    };
    
    if n_code >= 0 && IS_COLOR_PICKING {
        let msg = w_param as u32;
        match msg {
            // 允许左键点击（用于取色）
            WM_LBUTTONDOWN | WM_LBUTTONUP => {
                // 允许通过
            }
            // 阻止所有其他鼠标按键
            WM_RBUTTONDOWN | WM_RBUTTONUP | WM_MBUTTONDOWN | WM_MBUTTONUP => {
                // 返回非零值阻止事件传递
                return 1;
            }
            _ => {}
        }
    }
    
    CallNextHookEx(0, n_code, w_param, l_param)
}

/// 显示拾色器窗口
#[tauri::command]
pub async fn show_color_picker_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    // 尝试获取现有窗口
    if let Some(window) = app.get_webview_window("color-picker-window") {
        super::show_and_focus_window(&window)?;
    } else {
        // 动态创建窗口
        let _window = tauri::WebviewWindowBuilder::new(
            &app,
            "color-picker-window",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("拾色器")
        .inner_size(1000.0, 900.0)
        .resizable(true)
        .min_inner_size(800.0, 700.0)
        .center()
        .build()
        .map_err(|e| format!("创建拾色器窗口失败: {}", e))?;
    }

    Ok(())
}

/// 从屏幕取色（Windows 实现）
#[tauri::command]
pub async fn pick_color_from_screen() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        // 创建取消标志
        let picking = Arc::new(AtomicBool::new(true));
        let picking_clone = picking.clone();
        
        // 在后台线程中执行取色操作
        let result = tokio::task::spawn_blocking(move || {
            windows_pick_color(picking_clone)
        }).await.map_err(|e| format!("取色任务失败: {}", e))?;
        
        result
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        Err("屏幕取色功能目前仅支持 Windows".to_string())
    }
}

#[cfg(target_os = "windows")]
fn windows_pick_color(picking: Arc<AtomicBool>) -> Result<Option<String>, String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, CreateWindowExW, DestroyWindow, SetWindowPos, ShowWindow,
        HWND_TOPMOST, SWP_NOACTIVATE, SW_SHOWNOACTIVATE, WS_EX_LAYERED, WS_EX_TOPMOST,
        WS_EX_TOOLWINDOW, WS_POPUP, SetLayeredWindowAttributes, LWA_ALPHA,
        SetCursor, LoadCursorW, IDC_CROSS, SetWindowsHookExW, UnhookWindowsHookEx,
        CallNextHookEx, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP,
        WM_RBUTTONDOWN, WM_RBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_LBUTTON, VK_ESCAPE, VK_SHIFT, VK_C,
    };
    use windows_sys::Win32::Graphics::Gdi::{
        GetDC, GetPixel, ReleaseDC, CreateCompatibleDC, CreateCompatibleBitmap,
        SelectObject, BitBlt, DeleteDC, DeleteObject, StretchBlt, SRCCOPY,
        CreateSolidBrush, FillRect, SetBkMode, SetTextColor, TextOutW, TRANSPARENT,
        CreateFontW, FW_NORMAL, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
        DEFAULT_QUALITY, FF_DONTCARE,
    };
    use windows_sys::Win32::Foundation::{POINT, RECT, HWND};
    
    // Define RGB macro since windows_sys doesn't export it
    macro_rules! WIN_RGB {
        ($r:expr, $g:expr, $b:expr) => {
            ($r as u32) | (($g as u32) << 8) | (($b as u32) << 16)
        };
    }
    
    unsafe {
        // 先加载十字光标并设置（快速响应用户）
        let cross_cursor = LoadCursorW(0, IDC_CROSS);
        SetCursor(cross_cursor);
        
        // 设置全局取色标志
        IS_COLOR_PICKING = true;
        
        // 安装鼠标钩子以阻止点击穿透
        let hook = SetWindowsHookExW(
            WH_MOUSE_LL,
            Some(mouse_hook_proc),
            0,
            0,
        );
        
        if hook == 0 {
            IS_COLOR_PICKING = false;
            return Err("安装鼠标钩子失败".to_string());
        }
        
        // 放大镜窗口相关变量（懒加载）
        let magnifier_width = 280i32;
        let magnifier_height = 320i32;
        let preview_size = 200i32;
        let capture_size = 20i32;
        
        let screen_dc = GetDC(0);
        
        // 懒加载标志和资源
        let mut hwnd: HWND = 0;
        let mut window_dc: isize = 0;
        let mut mem_dc: isize = 0;
        let mut bitmap: isize = 0;
        let mut old_bitmap: isize = 0;
        let mut font: isize = 0;
        let mut old_font: isize = 0;
        let mut magnifier_created = false;
        
        // 格式切换状态：true = RGB, false = HEX
        let mut show_rgb = true;
        let mut shift_pressed = false;
        let mut c_pressed = false;
        let mut frame_count = 0u32;  // 帧计数器
        
        // 等待用户点击鼠标或按下 ESC
        let result = loop {
            // 持续设置十字光标（确保在整个屏幕上都显示）
            SetCursor(cross_cursor);
            
            if !picking.load(Ordering::SeqCst) {
                break Ok(None);
            }
            
            // 检查是否按下 ESC 键
            if GetAsyncKeyState(VK_ESCAPE as i32) as u16 & 0x8000 != 0 {
                break Ok(None);
            }
            
            // 懒加载：等待几帧后再创建放大镜窗口（减少初始卡顿）
            frame_count += 1;
            if !magnifier_created && frame_count > 3 {
                hwnd = CreateWindowExW(
                    WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                    "Static\0".encode_utf16().collect::<Vec<u16>>().as_ptr(),
                    std::ptr::null(),
                    WS_POPUP,
                    0, 0, magnifier_width, magnifier_height,
                    0 as HWND,
                    0,
                    0,
                    std::ptr::null(),
                );
                
                if hwnd != 0 {
                    SetLayeredWindowAttributes(hwnd, 0, 240, LWA_ALPHA);
                    window_dc = GetDC(hwnd);
                    mem_dc = CreateCompatibleDC(screen_dc);
                    bitmap = CreateCompatibleBitmap(screen_dc, magnifier_width, magnifier_height);
                    old_bitmap = SelectObject(mem_dc, bitmap as isize);
                    
                    font = CreateFontW(
                        16, 0, 0, 0,
                        FW_NORMAL as i32,
                        0, 0, 0,
                        DEFAULT_CHARSET as u32,
                        OUT_DEFAULT_PRECIS as u32,
                        CLIP_DEFAULT_PRECIS as u32,
                        DEFAULT_QUALITY as u32,
                        FF_DONTCARE as u32,
                        "Segoe UI\0".encode_utf16().collect::<Vec<u16>>().as_ptr(),
                    );
                    old_font = SelectObject(mem_dc, font as isize);
                    magnifier_created = true;
                }
            }
            
            // 检查 Shift 键切换显示格式
            let shift_now = GetAsyncKeyState(VK_SHIFT as i32) as u16 & 0x8000 != 0;
            if shift_now && !shift_pressed {
                show_rgb = !show_rgb;
            }
            shift_pressed = shift_now;
            
            // 获取鼠标位置和颜色
            let mut point = POINT { x: 0, y: 0 };
            if GetCursorPos(&mut point) != 0 && magnifier_created {
                // 获取当前像素颜色
                let color = GetPixel(screen_dc, point.x, point.y);
                let r = (color & 0xFF) as u8;
                let g = ((color >> 8) & 0xFF) as u8;
                let b = ((color >> 16) & 0xFF) as u8;
                
                // 检查 C 键复制颜色
                let c_now = GetAsyncKeyState(VK_C as i32) as u16 & 0x8000 != 0;
                if c_now && !c_pressed {
                    // 复制到剪贴板
                    let color_text = if show_rgb {
                        format!("rgb({}, {}, {})", r, g, b)
                    } else {
                        format!("#{:02x}{:02x}{:02x}", r, g, b)
                    };
                    
                    // 使用 Windows API 复制到剪贴板
                    use windows_sys::Win32::System::DataExchange::{
                        OpenClipboard, EmptyClipboard, SetClipboardData, CloseClipboard,
                    };
                    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
                    
                    if OpenClipboard(0) != 0 {
                        EmptyClipboard();
                        let text_wide: Vec<u16> = color_text.encode_utf16().chain(std::iter::once(0)).collect();
                        let h_mem = GlobalAlloc(GMEM_MOVEABLE, text_wide.len() * 2);
                        if !h_mem.is_null() {
                            let p_mem = GlobalLock(h_mem) as *mut u16;
                            if !p_mem.is_null() {
                                std::ptr::copy_nonoverlapping(text_wide.as_ptr(), p_mem, text_wide.len());
                                GlobalUnlock(h_mem);
                                SetClipboardData(13, h_mem as isize); // CF_UNICODETEXT = 13
                            }
                        }
                        CloseClipboard();
                    }
                }
                c_pressed = c_now;
                
                // 更新放大镜窗口位置
                let offset = 30i32;
                SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    point.x + offset,
                    point.y + offset,
                    magnifier_width,
                    magnifier_height,
                    SWP_NOACTIVATE,
                );
                
                // 填充深灰色背景
                let bg_brush = CreateSolidBrush(WIN_RGB!(45, 45, 48));
                let rect = RECT {
                    left: 0,
                    top: 0,
                    right: magnifier_width,
                    bottom: magnifier_height,
                };
                FillRect(mem_dc, &rect, bg_brush);
                DeleteObject(bg_brush as isize);
                
                // 捕获并放大鼠标周围区域
                let half_size = capture_size / 2;
                let src_x = point.x - half_size;
                let src_y = point.y - half_size;
                let margin = 40i32;
                
                StretchBlt(
                    mem_dc,
                    margin, margin, preview_size, preview_size,
                    screen_dc,
                    src_x, src_y, capture_size, capture_size,
                    SRCCOPY,
                );
                
                // 绘制白色边框
                let border_brush = CreateSolidBrush(WIN_RGB!(255, 255, 255));
                let border_rects = [
                    RECT { left: margin - 2, top: margin - 2, right: margin + preview_size + 2, bottom: margin },
                    RECT { left: margin - 2, top: margin + preview_size, right: margin + preview_size + 2, bottom: margin + preview_size + 2 },
                    RECT { left: margin - 2, top: margin - 2, right: margin, bottom: margin + preview_size + 2 },
                    RECT { left: margin + preview_size, top: margin - 2, right: margin + preview_size + 2, bottom: margin + preview_size + 2 },
                ];
                for rect in &border_rects {
                    FillRect(mem_dc, rect, border_brush);
                }
                DeleteObject(border_brush as isize);
                
                // 绘制十字准星
                let center = margin + preview_size / 2;
                let crosshair_size = 15i32;
                let cyan_brush = CreateSolidBrush(WIN_RGB!(0, 255, 255));
                
                let crosshair_rects = [
                    RECT { left: center - crosshair_size, top: center - 1, right: center - 3, bottom: center + 1 },
                    RECT { left: center + 3, top: center - 1, right: center + crosshair_size, bottom: center + 1 },
                    RECT { left: center - 1, top: center - crosshair_size, right: center + 1, bottom: center - 3 },
                    RECT { left: center - 1, top: center + 3, right: center + 1, bottom: center + crosshair_size },
                ];
                for rect in &crosshair_rects {
                    FillRect(mem_dc, rect, cyan_brush);
                }
                DeleteObject(cyan_brush as isize);
                
                // 绘制中心像素标记
                let pixel_rect = RECT {
                    left: center - 1,
                    top: center - 1,
                    right: center + 1,
                    bottom: center + 1,
                };
                let white_brush = CreateSolidBrush(WIN_RGB!(255, 255, 255));
                FillRect(mem_dc, &pixel_rect, white_brush);
                DeleteObject(white_brush as isize);
                
                // 设置文本绘制模式
                SetBkMode(mem_dc, TRANSPARENT as i32);
                SetTextColor(mem_dc, WIN_RGB!(255, 255, 255));
                
                // 绘制信息文本
                let mut y_pos = margin + preview_size + 15;
                let x_pos = 15i32;
                let line_height = 22i32;
                
                // 坐标
                let coord_text = format!("坐标: ({}, {})\0", point.x, point.y);
                let coord_wide: Vec<u16> = coord_text.encode_utf16().collect();
                TextOutW(mem_dc, x_pos, y_pos, coord_wide.as_ptr(), coord_wide.len() as i32 - 1);
                y_pos += line_height;
                
                // 颜色值
                let color_text = if show_rgb {
                    format!("RGB: ({}, {}, {})\0", r, g, b)
                } else {
                    format!("HEX: #{:02X}{:02X}{:02X}\0", r, g, b)
                };
                let color_wide: Vec<u16> = color_text.encode_utf16().collect();
                TextOutW(mem_dc, x_pos, y_pos, color_wide.as_ptr(), color_wide.len() as i32 - 1);
                y_pos += line_height + 5;
                
                // 提示信息
                SetTextColor(mem_dc, WIN_RGB!(180, 180, 180));
                let help1 = "左键: 确认  ESC: 取消\0";
                let help1_wide: Vec<u16> = help1.encode_utf16().collect();
                TextOutW(mem_dc, x_pos, y_pos, help1_wide.as_ptr(), help1_wide.len() as i32 - 1);
                y_pos += line_height;
                
                let help2 = "C: 复制  Shift: 切换格式\0";
                let help2_wide: Vec<u16> = help2.encode_utf16().collect();
                TextOutW(mem_dc, x_pos, y_pos, help2_wide.as_ptr(), help2_wide.len() as i32 - 1);
                
                // 复制到窗口
                BitBlt(
                    window_dc,
                    0, 0, magnifier_width, magnifier_height,
                    mem_dc,
                    0, 0,
                    SRCCOPY,
                );
                
                // 显示窗口
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            }
            
            // 检查是否按下鼠标左键
            if GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000 != 0 {
                // 获取鼠标位置
                let mut point = POINT { x: 0, y: 0 };
                if GetCursorPos(&mut point) == 0 {
                    break Err("获取鼠标位置失败".to_string());
                }
                
                // 获取指定位置的像素颜色
                let color = GetPixel(screen_dc, point.x, point.y);
                
                if color == 0xFFFFFFFF {
                    break Err("获取像素颜色失败".to_string());
                }
                
                // 提取 RGB 值
                let r = color & 0xFF;
                let g = (color >> 8) & 0xFF;
                let b = (color >> 16) & 0xFF;
                
                // 转换为 HEX 字符串
                let hex_color = format!("#{:02x}{:02x}{:02x}", r, g, b);
                
                // 等待鼠标释放
                while GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000 != 0 {
                    thread::sleep(Duration::from_millis(10));
                }
                
                break Ok(Some(hex_color));
            }
            
            // 短暂休眠以避免过度占用 CPU
            thread::sleep(Duration::from_millis(16)); // ~60 FPS
        };
        
        // 清理资源（仅清理已创建的）
        if magnifier_created {
            if old_font != 0 {
                SelectObject(mem_dc, old_font);
            }
            if font != 0 {
                DeleteObject(font);
            }
            if old_bitmap != 0 {
                SelectObject(mem_dc, old_bitmap);
            }
            if bitmap != 0 {
                DeleteObject(bitmap);
            }
            if mem_dc != 0 {
                DeleteDC(mem_dc);
            }
            if window_dc != 0 {
                ReleaseDC(hwnd, window_dc);
            }
            if hwnd != 0 {
                DestroyWindow(hwnd);
            }
        }
        
        ReleaseDC(0, screen_dc);
        
        // 卸载鼠标钩子
        UnhookWindowsHookEx(hook);
        IS_COLOR_PICKING = false;
        
        result
    }
}
