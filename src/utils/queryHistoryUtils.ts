/**
 * 启动器查询历史（localStorage）
 * 写入时机：用户成功启动某条结果时（见 launchUtils）
 */

import { parseSearchFilter } from "./searchFilterUtils";

export const QUERY_HISTORY_KEY = "re-fast:query-history";
export const QUERY_HISTORY_MAX = 50;
/** 关键词最短长度（过滤器前缀后的 keyword） */
export const QUERY_HISTORY_MIN_KEYWORD = 2;

function safeParse(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

export function getQueryHistory(): string[] {
  if (typeof localStorage === "undefined") return [];
  return safeParse(localStorage.getItem(QUERY_HISTORY_KEY));
}

/**
 * 从原始输入生成可写入历史的条目；不满足条件时返回 null
 */
export function buildQueryHistoryEntry(query: string): string | null {
  const parsed = parseSearchFilter(query);
  if (parsed.keyword.length < QUERY_HISTORY_MIN_KEYWORD) {
    return null;
  }
  if (parsed.hasFilter) {
    return `${parsed.matchedPrefix ?? ""}${parsed.keyword}`;
  }
  return parsed.keyword;
}

/**
 * 写入一条查询历史：去重后置顶，最多保留 QUERY_HISTORY_MAX 条
 * 关键词短于 QUERY_HISTORY_MIN_KEYWORD 时不写入
 */
export function pushQueryHistory(query: string): string[] {
  const entry = buildQueryHistoryEntry(query);
  if (!entry) return getQueryHistory();

  const existing = getQueryHistory().filter(
    (item) => item.toLowerCase() !== entry.toLowerCase()
  );
  const next = [entry, ...existing].slice(0, QUERY_HISTORY_MAX);

  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(QUERY_HISTORY_KEY, JSON.stringify(next));
    } catch {
      // 忽略配额等错误
    }
  }
  return next;
}

export function clearQueryHistory(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(QUERY_HISTORY_KEY);
}
