/**
 * 日期格式化工具函数
 * 统一处理各种日期时间格式化需求
 */

/**
 * 格式化时间戳为中文日期时间
 * @param timestamp 时间戳（秒或毫秒）
 * @returns 格式化的日期时间字符串，如 "2024/01/15 14:30"
 */
export function formatDateTime(timestamp: number | undefined | null): string {
  if (!timestamp || timestamp <= 0) {
    return "未知时间";
  }
  try {
    // 判断是秒还是毫秒时间戳
    const timestampMs = timestamp < 10000000000 ? timestamp * 1000 : timestamp;
    const date = new Date(timestampMs);
    if (isNaN(date.getTime())) {
      return "无效时间";
    }
    return date.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (error) {
    return "无效时间";
  }
}

/**
 * 格式化时间戳为相对时间
 * @param timestamp 时间戳（秒）
 * @returns 相对时间字符串，如 "2天前"、"3小时前"、"刚刚"
 */
export function formatRelativeTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}天前`;
  } else if (hours > 0) {
    return `${hours}小时前`;
  } else if (minutes > 0) {
    return `${minutes}分钟前`;
  } else {
    return "刚刚";
  }
}

/**
 * 格式化日期字符串为中文日期
 * @param dateString 日期字符串
 * @returns 中文日期字符串，如 "2024年1月15日"
 */
export function formatDateString(dateString: string): string {
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
      return dateString;
    }
    return date.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return dateString;
  }
}

/**
 * 格式化日期字符串为标准格式
 * @param dateStr 日期字符串（可选）
 * @param parseDate 解析日期字符串的函数（可选）
 * @returns 标准格式日期时间字符串，如 "2024-01-15 14:30"
 */
export function formatStandardDateTime(
  dateStr?: string,
  parseDate?: (dateStr: string) => number | null
): string {
  if (!dateStr) return "-";
  
  let timestamp: number | null = null;
  
  if (parseDate) {
    timestamp = parseDate(dateStr);
  } else {
    const date = new Date(dateStr);
    if (!isNaN(date.getTime())) {
      timestamp = date.getTime();
    }
  }
  
  if (!timestamp) return "-";
  
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  const hours = d.getHours().toString().padStart(2, "0");
  const minutes = d.getMinutes().toString().padStart(2, "0");
  
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * 格式化时间戳为完整的中文日期时间
 * @param timestamp 时间戳（秒）
 * @param options 格式化选项
 * @returns 格式化的日期时间字符串
 */
export function formatFullDateTime(
  timestamp: number,
  options?: {
    year?: "numeric" | "2-digit";
    month?: "numeric" | "2-digit" | "long" | "short";
    day?: "numeric" | "2-digit";
    hour?: "2-digit" | "numeric";
    minute?: "2-digit" | "numeric";
    second?: "2-digit" | "numeric";
    timeZone?: string;
  }
): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleString("zh-CN", {
    year: options?.year || "numeric",
    month: options?.month || "numeric",
    day: options?.day || "numeric",
    hour: options?.hour || "2-digit",
    minute: options?.minute || "2-digit",
    second: options?.second,
    timeZone: options?.timeZone,
  });
}

/**
 * 格式化时间戳为简单格式（默认格式）
 * @param timestamp 时间戳（秒）
 * @returns 格式化的日期时间字符串
 */
export function formatSimpleDateTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

