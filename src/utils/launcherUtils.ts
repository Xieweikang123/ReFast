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
export function isValidJson(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  
  const trimmed = text.trim();
  
  // Quick check: JSON should start with { or [
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return false;
  }
  
  // Try to parse as JSON
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

// Highlight matching keywords in text
export function highlightText(text: string, query: string): string {
  if (!query || !query.trim() || !text) {
    // Escape HTML to prevent XSS
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Escape HTML in the original text
  const escapedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
  // Split query into words (handle multiple words)
  const queryWords = query.trim().split(/\s+/).filter(word => word.length > 0);
  
  // Escape special regex characters in query words
  const escapedQueryWords = queryWords.map(word => 
    word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );
  
  // Create regex pattern that matches any of the query words (case-insensitive)
  const pattern = new RegExp(`(${escapedQueryWords.join('|')})`, 'gi');
  
  // Replace matches with highlighted version
  return escapedText.replace(pattern, (match) => {
    return `<span class="highlight-match font-semibold">${match}</span>`;
  });
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
  const mathPattern = /^[0-9+\-*/%()^.\s]+$/i;
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

  // 应用类型额外加分（优先显示应用）
  if (isApp) {
    // 如果应用名称匹配，给予更高的额外加分
    if (nameLower === queryLower || nameLower.startsWith(queryLower) || nameLower.includes(queryLower)) {
      score += 300; // 应用匹配时额外加300分
    } else if (queryIsPinyin && (namePinyin || namePinyinInitials)) {
      // 如果是拼音匹配，也给予额外加分
      if ((namePinyin && (namePinyin === queryLower || namePinyin.startsWith(queryLower) || namePinyin.includes(queryLower))) ||
          (namePinyinInitials && (namePinyinInitials === queryLower || namePinyinInitials.startsWith(queryLower) || namePinyinInitials.includes(queryLower)))) {
        score += 300; // 拼音匹配时也额外加300分
      } else {
        score += 100; // 即使不匹配也给予基础加分
      }
    } else {
      score += 100; // 即使不匹配也给予基础加分
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

