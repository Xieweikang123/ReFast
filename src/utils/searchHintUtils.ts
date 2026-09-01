/**
 * 启动器搜索提示：静默少搜时给原因和可点操作
 */

import type { SearchEngineConfig } from "../types";
import { detectSearchIntent } from "./searchUtils";
import {
  hasSearchKeyword,
  parseSearchFilter,
  shouldSearchSource,
  shouldShowEverythingSkippedHint,
} from "./searchFilterUtils";

/** 启动器合并进列表的 Everything 条数上限（首包后再截断展示） */
export const EVERYTHING_LAUNCHER_MERGE_LIMIT = 40;

export type SearchHintKind =
  | "engine-local-hidden"
  | "everything-skipped"
  | "everything-unavailable"
  | "everything-truncated";

export function getSearchEngineIntent(
  query: string,
  searchEngines: SearchEngineConfig[]
) {
  const parsed = parseSearchFilter(query);
  if (parsed.hasFilter) return null;
  return detectSearchIntent(query, searchEngines);
}

/** 实际拿去搜本地/磁盘的关键词：命中搜索引擎前缀时去掉前缀 */
export function getEffectiveSearchKeyword(
  query: string,
  searchEngines: SearchEngineConfig[]
): string {
  const parsed = parseSearchFilter(query);
  const intent = getSearchEngineIntent(query, searchEngines);
  if (intent?.keyword) return intent.keyword;
  return parsed.keyword;
}

export function shouldShowSearchEngineLocalHiddenHint(options: {
  query: string;
  searchEngines: SearchEngineConfig[];
  includeLocalWithSearchEngine: boolean;
}): boolean {
  if (options.includeLocalWithSearchEngine) return false;
  return getSearchEngineIntent(options.query, options.searchEngines) !== null;
}

export function shouldShowEverythingUnavailableHint(options: {
  query: string;
  isEverythingAvailable: boolean;
  searchEngines?: SearchEngineConfig[];
  includeLocalWithSearchEngine?: boolean;
}): boolean {
  if (options.isEverythingAvailable) return false;
  if (
    shouldShowSearchEngineLocalHiddenHint({
      query: options.query,
      searchEngines: options.searchEngines ?? [],
      includeLocalWithSearchEngine: options.includeLocalWithSearchEngine ?? false,
    })
  ) {
    return false;
  }
  const parsed = parseSearchFilter(options.query);
  if (!hasSearchKeyword(parsed)) return false;
  if (!shouldSearchSource(parsed.scope, "everything")) return false;
  const keyword = getEffectiveSearchKeyword(
    options.query,
    options.searchEngines ?? []
  );
  return keyword.length >= 2;
}

export function shouldShowEverythingTruncatedHint(options: {
  everythingTotalCount: number | null;
  mergeLimit?: number;
}): boolean {
  const total = options.everythingTotalCount;
  if (total == null || total <= 0) return false;
  const limit = options.mergeLimit ?? EVERYTHING_LAUNCHER_MERGE_LIMIT;
  return total > limit;
}

/** 同时只展示一条，优先级：网页搜索 > 单字跳过 > 未运行 > 截断 */
export function resolveSearchHintKind(options: {
  query: string;
  searchEngines: SearchEngineConfig[];
  includeLocalWithSearchEngine: boolean;
  isEverythingAvailable: boolean;
  isSearchingEverything: boolean;
  forceEverythingKeyword?: string | null;
  everythingTotalCount: number | null;
}): SearchHintKind | null {
  if (
    shouldShowSearchEngineLocalHiddenHint({
      query: options.query,
      searchEngines: options.searchEngines,
      includeLocalWithSearchEngine: options.includeLocalWithSearchEngine,
    })
  ) {
    return "engine-local-hidden";
  }

  if (
    shouldShowEverythingSkippedHint({
      query: options.query,
      isEverythingAvailable: options.isEverythingAvailable,
      isSearchingEverything: options.isSearchingEverything,
      forceKeyword: options.forceEverythingKeyword,
    })
  ) {
    return "everything-skipped";
  }

  if (
    shouldShowEverythingUnavailableHint({
      query: options.query,
      isEverythingAvailable: options.isEverythingAvailable,
      searchEngines: options.searchEngines,
      includeLocalWithSearchEngine: options.includeLocalWithSearchEngine,
    })
  ) {
    return "everything-unavailable";
  }

  if (
    shouldShowEverythingTruncatedHint({
      everythingTotalCount: options.everythingTotalCount,
    })
  ) {
    return "everything-truncated";
  }

  return null;
}
