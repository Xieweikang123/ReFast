/**
 * Launcher Window 工具函数
 * 从 LauncherWindow.tsx 提取的纯函数，用于搜索、文本处理等
 */

// Extract URLs from text
export function extractUrls(text: string): string[] {
  if (!text || text.trim().length === 0) return [];
  
  // 只匹配以 http:// 或 https:// 开头的 URL
  const urlPattern = /https?:\/\/[^\s<>"']+/gi;
  const matches = text.match(urlPattern);
  if (!matches) return [];
  
  // 清理并返回 URL
  return matches
    .map(url => url.trim())
    .filter((url): url is string => url.length > 0)
    .filter((url, index, self) => self.indexOf(url) === index); // Remove duplicates
}

// Extract email addresses from text
export function extractEmails(text: string): string[] {
  if (!text || text.trim().length === 0) return [];
  
  // 匹配邮箱地址的正则表达式
  // 支持常见格式：user@domain.com, user.name@domain.com, user+tag@domain.co.uk
  // 排除已包含在 URL 中的邮箱（避免重复）
  const emailPattern = /\b[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}\b/gi;
  const matches = text.match(emailPattern);
  if (!matches) return [];
  
  // 清理并返回邮箱地址
  return matches
    .map(email => email.trim().toLowerCase())
    .filter((email): email is string => email.length > 0)
    .filter((email, index, self) => self.indexOf(email) === index); // Remove duplicates
}

// Check if text is valid JSON
// 添加长度限制，避免处理过长的JSON导致性能问题或内存溢出
const MAX_JSON_CHECK_LENGTH = 1000000; // 1MB，足够大的JSON但避免处理超大文件

export function isValidJson(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  
  const trimmed = text.trim();
  
  // 长度检查：如果超过限制，不进行JSON解析（避免性能问题）
  if (trimmed.length > MAX_JSON_CHECK_LENGTH) {
    return false;
  }
  
  // Quick check: JSON should start with { or [
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return false;
  }
  
  // Try to parse as JSON
  // 添加更详细的错误处理，避免解析错误导致的问题
  try {
    JSON.parse(trimmed);
    return true;
  } catch (error) {
    // 静默处理解析错误，避免错误传播
    // 对于很长的JSON，解析失败是正常的（可能是格式错误或超出限制）
    return false;
  }
}

// Highlight matching keywords in text
// 添加长度限制，避免长JSON或超长查询导致正则表达式错误
const MAX_HIGHLIGHT_QUERY_LENGTH = 5000; // 最大查询长度（字符数）
const MAX_HIGHLIGHT_WORD_LENGTH = 200; // 单个单词最大长度
const MAX_HIGHLIGHT_PATTERN_LENGTH = 10000; // 正则表达式模式最大长度

export function highlightText(text: string, query: string): string {
  if (!query || !query.trim() || !text) {
    // Escape HTML to prevent XSS
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const trimmedQuery = query.trim();

  // 查询与全文相同（如粘贴完整路径）时不高亮，避免整行变色抢视觉
  if (trimmedQuery.toLowerCase() === text.toLowerCase()) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  
  // 如果查询过长，直接返回转义后的文本，不进行高亮（避免正则表达式错误）
  if (trimmedQuery.length > MAX_HIGHLIGHT_QUERY_LENGTH) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Escape HTML in the original text
  const escapedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
  // Split query into words (handle multiple words)
  const queryWords = trimmedQuery.split(/\s+/).filter(word => word.length > 0);
  
  // 过滤掉过长的单词，避免正则表达式过于复杂
  const validQueryWords = queryWords
    .filter(word => word.length <= MAX_HIGHLIGHT_WORD_LENGTH)
    .slice(0, 50); // 最多处理50个单词，避免正则表达式过长
  
  // 如果没有有效的查询词，直接返回转义后的文本
  if (validQueryWords.length === 0) {
    return escapedText;
  }
  
  // Escape special regex characters in query words
  const escapedQueryWords = validQueryWords.map(word => 
    word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );
  
  // 检查正则表达式模式长度，避免创建过大的正则表达式
  const patternString = `(${escapedQueryWords.join('|')})`;
  if (patternString.length > MAX_HIGHLIGHT_PATTERN_LENGTH) {
    // 如果模式过长，只使用前几个单词
    const limitedWords = escapedQueryWords.slice(0, Math.floor(MAX_HIGHLIGHT_PATTERN_LENGTH / 100));
    const limitedPattern = `(${limitedWords.join('|')})`;
    try {
      const pattern = new RegExp(limitedPattern, 'gi');
      return escapedText.replace(pattern, (match) => {
        return `<span class="highlight-match font-semibold">${match}</span>`;
      });
    } catch (error) {
      // 如果正则表达式创建失败，返回转义后的文本
      console.warn('[高亮文本] 正则表达式创建失败，跳过高亮:', error);
      return escapedText;
    }
  }
  
  // Create regex pattern that matches any of the query words (case-insensitive)
  try {
    const pattern = new RegExp(patternString, 'gi');
    
    // Replace matches with highlighted version
    return escapedText.replace(pattern, (match) => {
      return `<span class="highlight-match font-semibold">${match}</span>`;
    });
  } catch (error) {
    // 如果正则表达式创建失败（例如模式过长或无效），返回转义后的文本
    console.warn('[高亮文本] 正则表达式创建失败，跳过高亮:', error);
    return escapedText;
  }
}

// 判断字符串是否包含中文字符
export function containsChinese(text: string): boolean {
  return /[\u4E00-\u9FFF]/.test(text);
}

// 粗略判断输入是否像是绝对路径（含盘符、UNC 或根路径）
export function isLikelyAbsolutePath(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3) return false;
  const hasSeparator = trimmed.includes("\\") || trimmed.includes("/");
  const drivePattern = /^[a-zA-Z]:[\\/]/;
  const uncPattern = /^\\\\/;
  const rootLike = trimmed.startsWith("/") && hasSeparator;
  return (drivePattern.test(trimmed) || uncPattern.test(trimmed) || rootLike) && hasSeparator;
}

// 根据路径粗略判断是否更像"文件夹"
export function isFolderLikePath(path: string | undefined | null): boolean {
  if (!path) return false;
  // 去掉末尾的 / 或 \
  const normalized = path.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/);
  const last = segments[segments.length - 1] || "";
  if (!last) return false;
  // 如果最后一段里有扩展名（排除以点开头的特殊情况），认为是文件
  const dotIndex = last.indexOf(".");
  if (dotIndex > 0 && dotIndex < last.length - 1) {
    return false;
  }
  return true;
}

// 判断路径是否为 .lnk 快捷方式
export function isLnkPath(path: string | undefined | null): boolean {
  return path?.toLowerCase().endsWith(".lnk") ?? false;
}

/** Extensions that use Windows shell-associated icons (via extract_icon_png_via_shell). */
const SHELL_ASSOCIATED_ICON_EXTS = [
  ".msc",
  ".bat",
  ".cmd",
  ".ps1",
  ".vbs",
  ".js",
  ".jse",
  ".wsf",
  ".wsh",
  ".msi",
  ".cpl",
  ".com",
  ".scr",
] as const;

/** .exe / .lnk plus shell-associated types that benefit from extracted icons in search results. */
export function pathNeedsExtractedIcon(path: string | undefined | null): boolean {
  if (!path) return false;
  const pathLower = path.toLowerCase();
  if (pathLower.includes("windowsapps")) return false;
  if (pathLower.endsWith(".exe") || pathLower.endsWith(".lnk")) return true;
  return SHELL_ASSOCIATED_ICON_EXTS.some((ext) => pathLower.endsWith(ext));
}

/** Script-like extensions shown with a dedicated SVG until/unless a shell icon is available. */
export function isScriptLikePath(path: string | undefined | null): boolean {
  if (!path) return false;
  const pathLower = path.toLowerCase();
  return [".bat", ".cmd", ".ps1", ".vbs", ".js", ".jse", ".wsf", ".wsh"].some((ext) =>
    pathLower.endsWith(ext)
  );
}

// 检测输入是否为数学表达式
export function isMathExpression(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  
  const trimmed = text.trim();
  
  // 如果太短（少于2个字符），不太可能是数学表达式
  if (trimmed.length < 2) return false;
  
  // 移除所有空格
  const withoutSpaces = trimmed.replace(/\s+/g, "");
  
  // 检查是否包含数学运算符
  const hasOperator = /[+\-*/%=^]/.test(withoutSpaces);
  if (!hasOperator) return false;
  
  // 检查是否包含数字
  const hasNumber = /\d/.test(withoutSpaces);
  if (!hasNumber) return false;
  
  // 检查是否主要是数学相关字符（数字、运算符、括号、小数点、空格）
  // 允许的字符：数字、运算符、括号、小数点、空格、科学计数法（e/E）
  const mathPattern = /^[0-9+\-*/%()^.\sEe]+$/;
  const isMathChars = mathPattern.test(withoutSpaces);
  
  // 如果包含太多字母（超过2个），不太可能是纯数学表达式
  const letterCount = (withoutSpaces.match(/[a-zA-Z]/g) || []).length;
  if (letterCount > 2) return false;
  
  // 如果主要是数学字符，且包含运算符和数字，则认为是数学表达式
  if (isMathChars && hasOperator && hasNumber) {
    return true;
  }
  
  // 特殊情况：包含科学计数法（如 1e5, 2E-3）
  if (/^\d+\.?\d*[eE][+\-]?\d+$/.test(withoutSpaces)) {
    return true;
  }
  
  return false;
}

// 相关性评分函数
export function calculateRelevanceScore(
  displayName: string,
  path: string,
  query: string,
  useCount?: number,
  lastUsed?: number,
  isEverything?: boolean,
  isApp?: boolean,  // 新增：标识是否是应用
  namePinyin?: string,  // 新增：应用名称的拼音全拼
  namePinyinInitials?: string,  // 新增：应用名称的拼音首字母
  isFileHistory?: boolean,  // 新增：标识是否是历史文件
  isUrl?: boolean  // 新增：标识是否是 URL
): number {
  if (!query || !query.trim()) {
    // 如果查询为空，只根据使用频率和时间排序
    let score = 0;
    if (useCount !== undefined) {
      if (isFileHistory) {
        // 历史文件的使用次数加分更高（最多200分），使用次数越多分数越高
        score += Math.min(useCount * 2, 200);
      } else {
        score += Math.min(useCount, 100); // 最多100分
      }
    }
    if (lastUsed !== undefined) {
      // 最近使用时间：距离现在越近分数越高（大幅提高权重）
      const now = Date.now();
      const hoursSinceUse = (now - lastUsed) / (1000 * 60 * 60);
      const daysSinceUse = hoursSinceUse / 24;
      
      let timeScore = 0;
      if (hoursSinceUse <= 1) {
        // 最近1小时内：+500分
        timeScore = 500;
      } else if (hoursSinceUse <= 24) {
        // 最近1天内：+300分
        timeScore = 300;
      } else if (daysSinceUse <= 7) {
        // 最近7天内：+200分，线性递减
        timeScore = 200 - (daysSinceUse - 1) * 20;
      } else if (daysSinceUse <= 30) {
        // 最近30天内：+100分，线性递减
        timeScore = 100 - (daysSinceUse - 7) * (100 / 23);
      } else if (daysSinceUse <= 90) {
        // 最近90天内：+50分，线性递减
        timeScore = 50 - (daysSinceUse - 30) * (50 / 60);
      }
      
      // 历史文件类型额外加权（×1.5），让历史文件更重视最近使用时间
      if (isFileHistory && timeScore > 0) {
        timeScore = Math.floor(timeScore * 1.5);
      }
      
      score += Math.max(0, timeScore);
    }
    // 历史文件基础加分
    if (isFileHistory) {
      score += 300; // 历史文件基础加分（提高到300分）
    }
    // 应用类型额外加分
    if (isApp) {
      score += 50;
    }
    return score;
  }

  const queryLower = query.toLowerCase().trim();
  const nameLower = displayName.toLowerCase();
  const pathLower = path.toLowerCase();
  const queryLength = queryLower.length;
  const queryIsPinyin = !containsChinese(queryLower); // 判断查询是否是拼音

  let score = 0;

  // 文件名匹配（最高优先级）
  let nameMatchScore = 0;
  if (nameLower === queryLower) {
    // 完全匹配：短查询（2-4字符）给予更高权重
    if (queryLength >= 2 && queryLength <= 4) {
      nameMatchScore = 1500; // 短查询完全匹配给予更高分数
    } else {
      nameMatchScore = 1000; // 完全匹配
    }
  } else if (nameLower.startsWith(queryLower)) {
    nameMatchScore = 500; // 开头匹配
  } else if (nameLower.includes(queryLower)) {
    nameMatchScore = 100; // 包含匹配
  }
  
  // URL 类型降低匹配分数权重（×0.7），避免 URL 历史记录权重过高
  if (isUrl && nameMatchScore > 0) {
    nameMatchScore = Math.floor(nameMatchScore * 0.7);
  }
  
  score += nameMatchScore;
  
  // 历史文件在文件名匹配时额外加权（匹配分数的30%），确保优先显示
  if (isFileHistory && nameMatchScore > 0) {
    score += Math.floor(nameMatchScore * 0.3); // 额外加30%的匹配分数
  }

  // 拼音匹配（如果查询是拼音且是应用类型）
  if (queryIsPinyin && isApp && (namePinyin || namePinyinInitials)) {
    // 拼音全拼匹配
    if (namePinyin) {
      if (namePinyin === queryLower) {
        score += 800; // 拼音完全匹配给予高分
      } else if (namePinyin.startsWith(queryLower)) {
        score += 400; // 拼音开头匹配
      } else if (namePinyin.includes(queryLower)) {
        score += 150; // 拼音包含匹配
      }
    }

    // 拼音首字母匹配
    if (namePinyinInitials) {
      if (namePinyinInitials === queryLower) {
        score += 600; // 拼音首字母完全匹配给予高分
      } else if (namePinyinInitials.startsWith(queryLower)) {
        score += 300; // 拼音首字母开头匹配
      } else if (namePinyinInitials.includes(queryLower)) {
        score += 120; // 拼音首字母包含匹配
      }
    }
  }

  // 路径匹配（权重较低）
  if (pathLower.includes(queryLower)) {
    // 如果文件名已经匹配，路径匹配的权重更低
    if (score === 0) {
      score += 10; // 只有路径匹配时给10分
    } else {
      score += 5; // 文件名已匹配时只给5分
    }
  }

  // 应用类型额外加分：仅在名称/拼音真正命中时加分（避免未命中应用靠基础分挤进列表）
  if (isApp) {
    const nameNormalized = normalizeAppName(displayName);
    const nameHits =
      nameNormalized === queryLower ||
      nameLower === queryLower ||
      nameNormalized.startsWith(queryLower) ||
      nameLower.startsWith(queryLower) ||
      nameNormalized.includes(queryLower) ||
      nameLower.includes(queryLower);
    const pinyinHits =
      queryIsPinyin &&
      ((!!namePinyin &&
        (namePinyin === queryLower ||
          namePinyin.startsWith(queryLower) ||
          namePinyin.includes(queryLower))) ||
        (!!namePinyinInitials &&
          (namePinyinInitials === queryLower ||
            namePinyinInitials.startsWith(queryLower) ||
            namePinyinInitials.includes(queryLower))));
    if (nameHits || pinyinHits) {
      score += 300;
    }
  }

  // Everything 结果：路径深度越浅越好
  if (isEverything) {
    const pathDepth = path.split(/[/\\]/).length;
    // 路径深度越浅，加分越多（最多50分）
    score += Math.max(0, 50 - pathDepth * 2);
  }

  // 历史文件结果：给予基础加分，体现使用历史优势
  if (isFileHistory) {
    score += 300; // 历史文件基础加分（提高到300分），确保优先于 Everything 结果
  }

  // 使用频率加分
  if (useCount !== undefined) {
    if (isFileHistory) {
      // 历史文件的使用次数加分更高（最多200分），使用次数越多分数越高
      score += Math.min(useCount * 2, 200);
    } else {
      // 其他类型最多100分
      score += Math.min(useCount, 100);
    }
  }

  // 最近使用时间加分（大幅提高权重，让最近打开的文件排到前面）
  if (lastUsed !== undefined) {
    const now = Date.now();
    const hoursSinceUse = (now - lastUsed) / (1000 * 60 * 60);
    const daysSinceUse = hoursSinceUse / 24;
    
    let timeScore = 0;
    if (hoursSinceUse <= 1) {
      // 最近1小时内：+500分
      timeScore = 500;
    } else if (hoursSinceUse <= 24) {
      // 最近1天内：+300分
      timeScore = 300;
    } else if (daysSinceUse <= 7) {
      // 最近7天内：+200分，线性递减
      timeScore = 200 - (daysSinceUse - 1) * 20;
    } else if (daysSinceUse <= 30) {
      // 最近30天内：+100分，线性递减
      timeScore = 100 - (daysSinceUse - 7) * (100 / 23);
    } else if (daysSinceUse <= 90) {
      // 最近90天内：+50分，线性递减
      timeScore = 50 - (daysSinceUse - 30) * (50 / 60);
    }
    
    // 历史文件类型额外加权（×1.5），让历史文件更重视最近使用时间
    if (isFileHistory && timeScore > 0) {
      timeScore = Math.floor(timeScore * 1.5);
    }
    
    // URL 类型大幅降低时间加分权重（×0.3），避免 URL 历史记录权重过高
    // 注意：这不会影响排序，因为排序时优先按时间排序，这里只是影响评分
    if (isUrl && timeScore > 0) {
      timeScore = Math.floor(timeScore * 0.3);
    }
    
    score += Math.max(0, timeScore);
  }

  return score;
}

/**
 * 规范化路径用于历史记录比较（统一大小写和路径分隔符）
 * 用于在 openHistory 中查找匹配的路径
 */
export function normalizePathForHistory(path: string): string {
  return path.toLowerCase().replace(/\\/g, "/");
}

/**
 * 规范化应用名称用于去重（忽略大小写与可执行/快捷方式后缀）
 */
export function normalizeAppName(name: string): string {
  return name.toLowerCase().replace(/\.(exe|lnk)$/i, "").trim();
}

/**
 * 名称/路径匹配档位（数值越小匹配越强）
 * 有查询时排序应优先按档位，再按最近使用时间
 */
export const MatchTier = {
  EXACT: 0,
  PREFIX: 1,
  CONTAINS: 2,
  PATH: 3,
  NONE: 4,
} as const;

export type MatchTierValue = (typeof MatchTier)[keyof typeof MatchTier];

/**
 * 计算查询与结果的匹配档位（去 .exe/.lnk 后再比名称）
 */
export function getMatchTier(
  displayName: string,
  path: string,
  query: string,
  namePinyin?: string,
  namePinyinInitials?: string
): MatchTierValue {
  const queryLower = query.toLowerCase().trim();
  if (!queryLower) {
    return MatchTier.NONE;
  }

  const nameLower = displayName.toLowerCase();
  const nameNormalized = normalizeAppName(displayName);
  const pathLower = path.toLowerCase();

  if (nameNormalized === queryLower || nameLower === queryLower) {
    return MatchTier.EXACT;
  }
  if (nameNormalized.startsWith(queryLower) || nameLower.startsWith(queryLower)) {
    return MatchTier.PREFIX;
  }
  if (nameNormalized.includes(queryLower) || nameLower.includes(queryLower)) {
    return MatchTier.CONTAINS;
  }

  // 拼音匹配（仅非中文查询）
  if (!containsChinese(queryLower)) {
    if (namePinyin) {
      if (namePinyin === queryLower) return MatchTier.EXACT;
      if (namePinyin.startsWith(queryLower)) return MatchTier.PREFIX;
      if (namePinyin.includes(queryLower)) return MatchTier.CONTAINS;
    }
    if (namePinyinInitials) {
      if (namePinyinInitials === queryLower) return MatchTier.EXACT;
      if (namePinyinInitials.startsWith(queryLower)) return MatchTier.PREFIX;
      if (namePinyinInitials.includes(queryLower)) return MatchTier.CONTAINS;
    }
  }

  if (pathLower.includes(queryLower)) {
    return MatchTier.PATH;
  }

  return MatchTier.NONE;
}

/** 有查询时始终保留的结果类型（检测型/功能型，不依赖名称命中） */
export function isQueryIndependentResultType(type: string): boolean {
  return (
    type === "ai" ||
    type === "url" ||
    type === "email" ||
    type === "json_formatter" ||
    type === "search" ||
    type === "settings" ||
    type === "history"
  );
}

/** Windows「最近使用」目录中的快捷方式（常指向文件夹，不宜当应用） */
export function isRecentShortcutPath(path: string): boolean {
  const pathLower = path.toLowerCase().replace(/\//g, "\\");
  return (
    pathLower.includes("\\recent\\") ||
    pathLower.endsWith("\\recent") ||
    pathLower.includes("\\microsoft\\windows\\recent")
  );
}

/**
 * 应用路径来源优先级（数值越小越应保留；同名去重时用）
 * 开始菜单 > 桌面 > 普通 exe > 其它 lnk > Recent
 */
export function appSourceRank(path: string): number {
  const p = path.toLowerCase().replace(/\//g, "\\");
  if (isRecentShortcutPath(p)) return 9;
  if (p.includes("\\start menu\\programs\\")) {
    return 0;
  }
  if (p.includes("\\desktop\\")) {
    return 1;
  }
  if (p.endsWith(".exe")) return 2;
  if (p.endsWith(".lnk")) return 3;
  return 5;
}

/** 卸载类快捷方式（不应挤占主应用展示位） */
export function isUninstallShortcutName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n.startsWith("uninstall ") || n.startsWith("卸载");
}

/**
 * 判断路径是否为系统文件夹
 * 系统文件夹包括：控制面板、设置、CLSID 路径（如回收站）等
 */
export function isSystemFolder(path: string, isFolder?: boolean | null): boolean {
  const pathLower = path.toLowerCase();
  if (pathLower.startsWith("rf-builtin:")) {
    return true;
  }
  // System32 下的 .msc / .cpl（内置系统工具快捷方式）
  if (/\\system32\\[^\\/]+\.(msc|cpl)$/.test(pathLower)) {
    return true;
  }
  return (
    pathLower === "control" ||
    pathLower === "ms-settings:" ||
    pathLower.startsWith("::{") ||
    (isFolder === true && pathLower.startsWith("::{"))
  );
}

/**
 * 判断结果是否应该显示在横向列表中
 * 横向列表包括：可执行文件、快捷方式、UWP 应用、系统文件夹、插件
 * 
 * @param result - 搜索结果对象
 * @param fileIsFolder - 文件是否为文件夹（可选，从 result.file?.is_folder 获取）
 */
export function shouldShowInHorizontal(
  result: { type: string; path: string; file?: { is_folder?: boolean | null; path?: string } }
): boolean {
  if (result.type === "app") {
    const pathLower = result.path.toLowerCase();
    return (
      pathLower.endsWith('.exe') ||
      pathLower.endsWith('.lnk') ||
      pathLower.startsWith('shell:appsfolder') ||
      pathLower.startsWith('ms-settings:')
    );
  }
  
  if (result.type === "file" && result.file) {
    return isSystemFolder(result.path, result.file.is_folder);
  }
  
  return result.type === "plugin";
}

/**
 * 从 openHistory 中获取结果的使用信息
 * @param result - 搜索结果对象
 * @param openHistory - 打开历史记录（key: 路径, value: 时间戳（秒））
 * @returns 使用信息对象，包含 useCount 和 lastUsed（毫秒）
 */
export function getResultUsageInfo(
  result: { path: string; file?: { use_count?: number; last_used?: number } },
  openHistory: Record<string, number>
): { useCount?: number; lastUsed: number } {
  const normalizedPath = normalizePathForHistory(result.path);
  const lastUsedFromHistory = Object.entries(openHistory).find(
    ([key]) => normalizePathForHistory(key) === normalizedPath
  )?.[1];
  
  const useCount = result.file?.use_count;
  // openHistory 存储的是秒级时间戳，需要转换为毫秒；file.last_used 也是秒级时间戳
  const lastUsed = (lastUsedFromHistory || result.file?.last_used || 0) * 1000;
  
  return { useCount, lastUsed };
}

/**
 * Icon extraction failure marker (must match backend constant)
 */
export const ICON_EXTRACTION_FAILED_MARKER = "__ICON_EXTRACTION_FAILED__";

/**
 * Check if an icon value represents a failed extraction
 */
export const isIconExtractionFailed = (icon: string | null | undefined): boolean => {
  return icon === ICON_EXTRACTION_FAILED_MARKER;
};

/**
 * Check if an icon is valid (not empty and not failed)
 */
export const isValidIcon = (icon: string | null | undefined): boolean => {
  return icon !== null && icon !== undefined && icon.trim() !== '' && !isIconExtractionFailed(icon);
};

/**
 * 格式化最近使用时间的相对时间显示
 */
export function formatLastUsedTime(timestamp: number): string {
  // 判断时间戳是秒级还是毫秒级（毫秒级时间戳 > 1e12）
  const ts = timestamp > 1e12 ? timestamp : timestamp * 1000;
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (seconds < 60) {
    return "刚刚";
  } else if (minutes < 60) {
    return `${minutes}分钟前`;
  } else if (hours < 24) {
    return `${hours}小时前`;
  } else if (days === 1) {
    return "昨天";
  } else if (days < 7) {
    return `${days}天前`;
  } else {
    // 超过7天显示具体日期
    const date = new Date(ts);
    const today = new Date();
    const isThisYear = date.getFullYear() === today.getFullYear();
    if (isThisYear) {
      return `${date.getMonth() + 1}月${date.getDate()}日`;
    } else {
      return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    }
  }
}

/**
 * 分批处理数组，避免阻塞UI线程
 * 使用 requestIdleCallback 或 setTimeout 在空闲时处理
 */
export function processBatchAsync<T, R>(
  items: T[],
  processor: (item: T) => R | null,
  batchSize: number = 50,
  timeout: number = 1000
): Promise<R[]> {
  return new Promise((resolve) => {
    const results: R[] = [];
    let index = 0;

    const processBatch = () => {
      const end = Math.min(index + batchSize, items.length);
      
      // 处理当前批次
      for (let i = index; i < end; i++) {
        const result = processor(items[i]);
        if (result !== null) {
          results.push(result);
        }
      }
      
      index = end;

      // 如果还有剩余项，继续处理
      if (index < items.length) {
        // 使用 requestIdleCallback 或 setTimeout 让出主线程
        if (window.requestIdleCallback) {
          window.requestIdleCallback(processBatch, { timeout });
        } else {
          setTimeout(processBatch, 0);
        }
      } else {
        resolve(results);
      }
    };

    // 开始处理
    if (window.requestIdleCallback) {
      window.requestIdleCallback(processBatch, { timeout });
    } else {
      setTimeout(processBatch, 0);
    }
  });
}

