/**
 * 浏览器路由规则工具
 * 负责根据用户配置的规则，为 URL 选择对应的浏览器
 */
import type { BrowserRule } from "../types";

/** 规范化匹配关键字（域名或 URL 前缀） */
function normalizeRulePattern(pattern: string): string {
  return pattern.trim().toLowerCase().replace(/\/+$/, "");
}

/** 解析 URL 的 hostname，无法解析时返回 null */
function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 判断规则是否匹配给定 URL
 * - 规则含 "://"：按 URL 前缀匹配
 * - 否则：按域名后缀匹配（子域名同样命中）
 */
export function isBrowserRuleMatch(rule: BrowserRule, url: string): boolean {
  if (!rule.enabled) return false;
  const pattern = normalizeRulePattern(rule.pattern);
  if (!pattern) return false;

  const urlLower = url.trim().toLowerCase();
  if (pattern.includes("://")) {
    return urlLower.startsWith(pattern);
  }

  // 裸域名 URL（无协议）：直接与规则模式比较
  if (!urlLower.includes("://")) {
    if (urlLower === pattern || urlLower.startsWith(`${pattern}/`)) {
      return true;
    }
  }

  const hostname = extractHostname(url);
  if (!hostname) return false;

  // 域名后缀匹配，避免 "foo.example.com" 命中 "com" 这类误匹配
  if (!pattern.includes(".")) {
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  }
  return hostname === pattern || hostname.endsWith(`.${pattern}`);
}

/**
 * 为 URL 解析应使用的浏览器
 * 返回规则中配置的浏览器标识（"default" | "edge" | "chrome" | "firefox" | 绝对路径）
 * 未命中任何启用规则时返回 "default"
 */
export function resolveBrowserForUrl(
  url: string,
  rules: BrowserRule[] | undefined
): string {
  if (!rules || rules.length === 0) return "default";
  for (const rule of rules) {
    if (isBrowserRuleMatch(rule, url)) {
      return rule.browser || "default";
    }
  }
  return "default";
}
