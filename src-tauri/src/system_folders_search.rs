#[cfg(target_os = "windows")]
pub mod windows {
    use serde::{Deserialize, Serialize};
    use pinyin::ToPinyin;
    use std::sync::OnceLock;

    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct SystemFolderItem {
        pub name: String,
        pub path: String,
        pub display_name: String,
        pub is_folder: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub icon: Option<String>, // Base64 encoded PNG icon
        #[serde(skip_serializing_if = "Option::is_none")]
        pub name_pinyin: Option<String>, // 拼音全拼（用于拼音搜索）
        #[serde(skip_serializing_if = "Option::is_none")]
        pub name_pinyin_initials: Option<String>, // 拼音首字母（用于拼音首字母搜索）
    }

    // Windows 特殊文件夹列表（仅支持特殊处理的文件夹）
    const SPECIAL_FOLDERS: &[(&str, &str)] = &[
        ("回收站", "Recycle Bin"),
        ("设置", "Settings"),
        ("下载", "Downloads"),
    ];

    // 缓存系统文件夹列表，避免每次搜索都重新获取
    static SYSTEM_FOLDERS_CACHE: OnceLock<Vec<SystemFolderItem>> = OnceLock::new();

    /// 获取回收站路径（使用 CLSID）
    fn get_recycle_bin_path() -> Option<String> {
        // 回收站的 CLSID: {645FF040-5081-101B-9F08-00AA002F954E}
        // 使用 ::{CLSID} 格式访问虚拟文件夹
        Some("::{645FF040-5081-101B-9F08-00AA002F954E}".to_string())
    }

    /// 获取系统设置路径（使用 ms-settings: URI 打开 Windows 设置）
    fn get_settings_path() -> Option<String> {
        // 使用 ms-settings: URI 打开 Windows 设置
        Some("ms-settings:".to_string())
    }

    /// 获取下载文件夹路径（需要特殊处理）
    fn get_downloads_folder() -> Option<String> {
        // 使用环境变量获取用户目录
        if let Ok(profile) = std::env::var("USERPROFILE") {
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

    /// 获取所有系统特殊文件夹（使用缓存）
    fn get_all_system_folders() -> &'static Vec<SystemFolderItem> {
        SYSTEM_FOLDERS_CACHE.get_or_init(|| {
            let mut folders = Vec::new();

            for (name_cn, name_en) in SPECIAL_FOLDERS {
                // 特殊处理下载文件夹、回收站和设置
                let path = if *name_cn == "下载" {
                    get_downloads_folder()
                } else if *name_cn == "回收站" {
                    // 回收站使用 CLSID 路径
                    get_recycle_bin_path()
                } else if *name_cn == "设置" {
                    // 设置使用 ms-settings: URI
                    get_settings_path()
                } else {
                    None
                };

                if let Some(path) = path {
                    // 计算拼音（仅对中文名称）
                    let (name_pinyin, name_pinyin_initials) = if contains_chinese(name_cn) {
                        (
                            Some(to_pinyin(name_cn).to_lowercase()),
                            Some(to_pinyin_initials(name_cn).to_lowercase()),
                        )
                    } else {
                        (None, None)
                    };
                    
                    // 系统文件夹不使用自动提取的图标，使用前端默认图标
                    folders.push(SystemFolderItem {
                        name: name_cn.to_string(),
                        path: path.clone(),
                        display_name: format!("{} ({})", name_cn, name_en),
                        is_folder: true,
                        icon: None, // 使用前端默认图标
                        name_pinyin,
                        name_pinyin_initials,
                    });
                }
            }

            folders
        })
    }

    /// 搜索系统特殊文件夹
    pub fn search_system_folders(query: &str) -> Vec<SystemFolderItem> {
        let all_folders = get_all_system_folders();
        
        if query.trim().is_empty() {
            return all_folders.clone();
        }

        let query_lower = query.to_lowercase();
        let query_is_pinyin = !contains_chinese(&query_lower);

        let mut results: Vec<(SystemFolderItem, i32)> = all_folders
            .iter()
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
                    Some((folder.clone(), score))
                } else {
                    None
                }
            })
            .collect();

        // Sort by score (descending)
        results.sort_by(|a, b| b.1.cmp(&a.1));
        
        let final_results: Vec<SystemFolderItem> = results.into_iter().map(|(item, _)| item).collect();
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
        #[serde(skip_serializing_if = "Option::is_none")]
        pub icon: Option<String>, // Base64 encoded PNG icon
        #[serde(skip_serializing_if = "Option::is_none")]
        pub name_pinyin: Option<String>, // 拼音全拼（用于拼音搜索）
        #[serde(skip_serializing_if = "Option::is_none")]
        pub name_pinyin_initials: Option<String>, // 拼音首字母（用于拼音首字母搜索）
    }

    pub fn get_all_system_folders() -> Vec<SystemFolderItem> {
        Vec::new()
    }

    pub fn search_system_folders(_query: &str) -> Vec<SystemFolderItem> {
        Vec::new()
    }
}

