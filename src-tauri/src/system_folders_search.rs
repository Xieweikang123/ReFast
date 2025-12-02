#[cfg(target_os = "windows")]
pub mod windows {
    use serde::{Deserialize, Serialize};
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::UI::Shell::*;
    use pinyin::ToPinyin;

    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct SystemFolderItem {
        pub name: String,
        pub path: String,
        pub display_name: String,
        pub is_folder: bool,
    }

    // Windows Shell API 常量定义
    // 参考：https://learn.microsoft.com/en-us/windows/win32/shell/csidl
    const CSIDL_BITBUCKET: i32 = 0x000a; // 回收站
    const CSIDL_CONTROLS: i32 = 0x0003; // 控制面板
    const CSIDL_DESKTOP: i32 = 0x0000; // 桌面
    const CSIDL_PERSONAL: i32 = 0x0005; // 我的文档
    const CSIDL_DRIVES: i32 = 0x0011; // 我的电脑
    const CSIDL_NETWORK: i32 = 0x0012; // 网络
    const CSIDL_FONTS: i32 = 0x0014; // 字体
    const CSIDL_PROGRAMS: i32 = 0x0002; // 程序
    const CSIDL_STARTUP: i32 = 0x0007; // 启动
    const CSIDL_RECENT: i32 = 0x0008; // 最近使用的文档
    const CSIDL_PROFILE: i32 = 0x0028; // 用户配置文件目录
    const CSIDL_MYPICTURES: i32 = 0x0027; // 图片
    const CSIDL_MYVIDEO: i32 = 0x000e; // 视频
    const CSIDL_MYMUSIC: i32 = 0x000d; // 音乐

    // Windows 特殊文件夹的 CSIDL 常量映射
    const SPECIAL_FOLDERS: &[(&str, i32, &str)] = &[
        ("回收站", CSIDL_BITBUCKET, "Recycle Bin"),
        ("控制面板", CSIDL_CONTROLS, "Control Panel"),
        ("桌面", CSIDL_DESKTOP, "Desktop"),
        ("我的文档", CSIDL_PERSONAL, "My Documents"),
        ("我的电脑", CSIDL_DRIVES, "My Computer"),
        ("网络", CSIDL_NETWORK, "Network"),
        ("字体", CSIDL_FONTS, "Fonts"),
        ("程序", CSIDL_PROGRAMS, "Programs"),
        ("启动", CSIDL_STARTUP, "Startup"),
        ("最近使用的文档", CSIDL_RECENT, "Recent"),
        ("下载", CSIDL_PROFILE, "Downloads"), // 需要特殊处理
        ("图片", CSIDL_MYPICTURES, "Pictures"),
        ("视频", CSIDL_MYVIDEO, "Videos"),
        ("音乐", CSIDL_MYMUSIC, "Music"),
    ];

    /// 获取特殊文件夹路径
    fn get_special_folder_path(csidl: i32) -> Option<String> {
        unsafe {
            let mut path: Vec<u16> = vec![0; 260]; // MAX_PATH
            // SHGetSpecialFolderPathW 返回非零值表示成功
            let result = SHGetSpecialFolderPathW(0, path.as_mut_ptr(), csidl, 0);
            if result != 0 {
                let len = path.iter().position(|&x| x == 0).unwrap_or(path.len());
                path.truncate(len);
                let os_string = OsString::from_wide(&path);
                let path_str = os_string.to_string_lossy().to_string();
                eprintln!("[DEBUG] get_special_folder_path: csidl={}, path={}", csidl, path_str);
                Some(path_str)
            } else {
                eprintln!("[DEBUG] get_special_folder_path: csidl={} failed", csidl);
                None
            }
        }
    }

    /// 获取回收站路径（使用 CLSID）
    fn get_recycle_bin_path() -> Option<String> {
        // 回收站的 CLSID: {645FF040-5081-101B-9F08-00AA002F954E}
        // 使用 ::{CLSID} 格式访问虚拟文件夹
        Some("::{645FF040-5081-101B-9F08-00AA002F954E}".to_string())
    }

    /// 获取控制面板路径（使用 CLSID）
    fn get_control_panel_path() -> Option<String> {
        // 控制面板的 CLSID: {21EC2020-3AEA-1069-A2DD-08002B30309D}
        // 使用 ::{CLSID} 格式访问虚拟文件夹
        Some("::{21EC2020-3AEA-1069-A2DD-08002B30309D}".to_string())
    }

    /// 获取下载文件夹路径（需要特殊处理）
    fn get_downloads_folder() -> Option<String> {
        // 尝试使用 CSIDL_PROFILE 然后拼接 Downloads
        if let Some(profile) = get_special_folder_path(CSIDL_PROFILE) {
            let downloads = std::path::Path::new(&profile).join("Downloads");
            if downloads.exists() {
                return Some(downloads.to_string_lossy().to_string());
            }
        }
        None
    }

    // Convert Chinese characters to pinyin (full pinyin)
    fn to_pinyin(text: &str) -> String {
        text.to_pinyin()
            .filter_map(|p| p.map(|p| p.plain()))
            .collect::<Vec<_>>()
            .join("")
    }

    // Convert Chinese characters to pinyin initials (first letter of each pinyin)
    fn to_pinyin_initials(text: &str) -> String {
        text.to_pinyin()
            .filter_map(|p| p.map(|p| p.plain().chars().next()))
            .flatten()
            .collect::<String>()
    }

    // Check if text contains Chinese characters
    fn contains_chinese(text: &str) -> bool {
        text.chars().any(|c| {
            matches!(c as u32,
                0x4E00..=0x9FFF |  // CJK Unified Ideographs
                0x3400..=0x4DBF |  // CJK Extension A
                0x20000..=0x2A6DF | // CJK Extension B
                0x2A700..=0x2B73F | // CJK Extension C
                0x2B740..=0x2B81F | // CJK Extension D
                0xF900..=0xFAFF |  // CJK Compatibility Ideographs
                0x2F800..=0x2FA1F   // CJK Compatibility Ideographs Supplement
            )
        })
    }

    /// 获取所有系统特殊文件夹
    pub fn get_all_system_folders() -> Vec<SystemFolderItem> {
        let mut folders = Vec::new();

        for (name_cn, csidl, name_en) in SPECIAL_FOLDERS {
            // 特殊处理下载文件夹、回收站和控制面板
            let path = if *name_cn == "下载" {
                get_downloads_folder()
            } else if *name_cn == "回收站" {
                // 回收站使用 CLSID 路径
                get_recycle_bin_path()
            } else if *name_cn == "控制面板" {
                // 控制面板使用 CLSID 路径
                get_control_panel_path()
            } else {
                get_special_folder_path(*csidl)
            };

            if let Some(path) = path {
                folders.push(SystemFolderItem {
                    name: name_cn.to_string(),
                    path: path.clone(),
                    display_name: format!("{} ({})", name_cn, name_en),
                    is_folder: true,
                });
            }
        }

        folders
    }

    /// 搜索系统特殊文件夹
    pub fn search_system_folders(query: &str) -> Vec<SystemFolderItem> {
        eprintln!("[DEBUG] search_system_folders called with query: '{}'", query);
        
        if query.trim().is_empty() {
            return get_all_system_folders();
        }

        let query_lower = query.to_lowercase();
        let query_is_pinyin = !contains_chinese(&query_lower);
        let all_folders = get_all_system_folders();
        
        eprintln!("[DEBUG] Found {} system folders, query_is_pinyin: {}", all_folders.len(), query_is_pinyin);

        let mut results: Vec<(SystemFolderItem, i32)> = all_folders
            .into_iter()
            .filter_map(|folder| {
                let name_lower = folder.name.to_lowercase();
                let display_lower = folder.display_name.to_lowercase();
                let path_lower = folder.path.to_lowercase();

                let mut score = 0;

                // Direct text match (highest priority)
                if name_lower == query_lower {
                    score += 1000;
                } else if name_lower.starts_with(&query_lower) {
                    score += 500;
                } else if name_lower.contains(&query_lower) {
                    score += 100;
                }

                // Display name match
                if display_lower.contains(&query_lower) {
                    score += 50;
                }

                // Pinyin matching (if query is pinyin)
                if query_is_pinyin {
                    let name_pinyin = to_pinyin(&folder.name).to_lowercase();
                    let name_pinyin_initials = to_pinyin_initials(&folder.name).to_lowercase();
                    let display_pinyin = to_pinyin(&folder.display_name).to_lowercase();
                    let display_pinyin_initials = to_pinyin_initials(&folder.display_name).to_lowercase();

                    // Full pinyin match on name
                    if name_pinyin == query_lower {
                        score += 800;
                    } else if name_pinyin.starts_with(&query_lower) {
                        score += 400;
                    } else if name_pinyin.contains(&query_lower) {
                        score += 150;
                    }

                    // Pinyin initials match on name
                    if name_pinyin_initials == query_lower {
                        score += 600;
                    } else if name_pinyin_initials.starts_with(&query_lower) {
                        score += 300;
                    } else if name_pinyin_initials.contains(&query_lower) {
                        score += 120;
                    }

                    // Full pinyin match on display name
                    if display_pinyin.contains(&query_lower) {
                        score += 100;
                    }

                    // Pinyin initials match on display name
                    if display_pinyin_initials.contains(&query_lower) {
                        score += 80;
                    }
                }

                // Path match gets lower score
                if path_lower.contains(&query_lower) {
                    score += 10;
                }

                if score > 0 {
                    eprintln!("[DEBUG] Match found: '{}' matches query '{}' with score {}", folder.name, query, score);
                    Some((folder, score))
                } else {
                    None
                }
            })
            .collect();

        // Sort by score (descending)
        results.sort_by(|a, b| b.1.cmp(&a.1));
        
        let final_results: Vec<SystemFolderItem> = results.into_iter().map(|(item, _)| item).collect();
        
        eprintln!("[DEBUG] search_system_folders returning {} results", final_results.len());
        final_results
    }
}

#[cfg(not(target_os = "windows"))]
pub mod windows {
    use serde::{Deserialize, Serialize};

    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct SystemFolderItem {
        pub name: String,
        pub path: String,
        pub display_name: String,
        pub is_folder: bool,
    }

    pub fn get_all_system_folders() -> Vec<SystemFolderItem> {
        Vec::new()
    }

    pub fn search_system_folders(_query: &str) -> Vec<SystemFolderItem> {
        Vec::new()
    }
}

