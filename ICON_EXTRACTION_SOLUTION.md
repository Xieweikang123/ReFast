# Icon Extraction Solution for Windows .lnk Files

## Problem Summary
1. **Encoding Issues**: Chinese characters in paths become garbled (Ѷ instead of 腾讯软件)
2. **Mixed-Mode Assembly Error**: `System.Drawing.Icon::ExtractAssociatedIcon` fails with "无法加载类型。不支持混合模式程序集"
3. **Path Embedding**: Embedding paths in PowerShell script strings causes encoding problems

## Solution: Three Approaches

### Approach 1: Improved PowerShell (Recommended)
- Uses parameter passing via base64-encoded UTF-16 paths
- Uses Shell32 COM object to extract icons (avoids System.Drawing mixed-mode issues)
- Writes script to temp file to avoid command-line length limits
- Uses PowerShell 5.1 explicitly

### Approach 2: Native Windows API (Most Reliable)
- Uses IShellLinkW + ExtractIconExW directly from Rust
- No PowerShell dependency
- Full control over encoding
- Requires windows-sys crate

### Approach 3: Hybrid (Fallback)
- Tries native API first, falls back to PowerShell
- Best of both worlds

## Implementation Files

See the updated `src-tauri/src/app_search.rs` for the complete implementation.



