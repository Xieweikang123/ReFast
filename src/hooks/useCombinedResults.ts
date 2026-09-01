/**
 * 结果合并相关的自定义 Hook
 * 负责将各种搜索结果合并为统一的结果列表
 */

import { startTransition, useEffect, useRef, useState } from "react";
import { computeCombinedResults } from "../utils/combineResultsUtils";
import { shouldAutoSearchEverything } from "../utils/searchFilterUtils";
import {
  EVERYTHING_LAUNCHER_MERGE_LIMIT,
  getEffectiveSearchKeyword,
} from "../utils/searchHintUtils";
import type { SearchResult } from "../utils/resultUtils";
import type { AppInfo, FileHistoryItem, MemoItem, SearchEngineConfig, BrowserRule } from "../types";
import type { EverythingResult } from "../types";
import { perfMarkStart, perfMarkEnd, perfReport } from "../utils/searchPerf";

export interface UseCombinedResultsOptions {
  query: string;
  aiAnswer: string | null;
  filteredApps: AppInfo[];
  filteredFiles: FileHistoryItem[];
  filteredMemos: MemoItem[];
  systemFolders: Array<{ name: string; path: string; display_name: string; is_folder: boolean; icon?: string; name_pinyin?: string; name_pinyin_initials?: string }>;
  everythingResults: EverythingResult[];
  filteredPlugins: Array<{ id: string; name: string; description?: string }>;
  detectedUrls: string[];
  detectedEmails: string[];
  detectedJson: string | null;
  directPathResult: FileHistoryItem | null;
  openHistory: Record<string, number>;
  urlRemarks: Record<string, string>;
  searchEngines: SearchEngineConfig[];
  browserRules: BrowserRule[];
  apps: AppInfo[];
  extractedFileIconsRef: React.MutableRefObject<Map<string, string>>;
  /** Incremented when extractedFileIconsRef contents change (forces recombine) */
  extractedIconsVersion?: number;
  suppressedBrokenPathsRef?: React.MutableRefObject<Set<string>>;
  /** 用户对当前短关键词手动点过 Everything 时，允许把磁盘结果并入列表 */
  forceEverythingKeyword?: string | null;
  /** 搜索引擎前缀命中时仍合并本地/磁盘结果 */
  includeLocalWithSearchEngine?: boolean;
}

/**
 * 结果合并 Hook
 * 不随每个按键重算：合并只在搜索源变化时进行，输入框保持跟手
 */
export function useCombinedResults(options: UseCombinedResultsOptions) {
  const {
    query,
    aiAnswer,
    filteredApps,
    filteredFiles,
    filteredMemos,
    systemFolders,
    everythingResults,
    filteredPlugins,
    detectedUrls,
    detectedEmails,
    detectedJson,
    directPathResult,
    openHistory,
    urlRemarks,
    searchEngines,
    browserRules,
    apps,
    extractedFileIconsRef,
    extractedIconsVersion = 0,
    suppressedBrokenPathsRef,
    forceEverythingKeyword = null,
    includeLocalWithSearchEngine = false,
  } = options;

  const queryRef = useRef(query);
  queryRef.current = query;
  const combineTimerRef = useRef<number | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [combinedResults, setCombinedResults] = useState<SearchResult[]>([]);
  const [combinedResultsQuery, setCombinedResultsQuery] = useState("");
  const debouncedResultsQueryRef = useRef<string>("");

  const applyCombinedResults = (queryForCombine: string, useTransition: boolean) => {
    const opts = optionsRef.current;
    perfMarkStart("合并:computeCombinedResults");
    const everythingForCombine = shouldAutoSearchEverything(
      getEffectiveSearchKeyword(queryForCombine, opts.searchEngines),
      opts.forceEverythingKeyword
    )
      ? opts.everythingResults.slice(0, EVERYTHING_LAUNCHER_MERGE_LIMIT)
      : [];
    const results = computeCombinedResults({
      query: queryForCombine,
      aiAnswer: opts.aiAnswer,
      filteredApps: opts.filteredApps,
      filteredFiles: opts.filteredFiles,
      filteredMemos: opts.filteredMemos,
      systemFolders: opts.systemFolders,
      everythingResults: everythingForCombine,
      filteredPlugins: opts.filteredPlugins,
      detectedUrls: opts.detectedUrls,
      detectedEmails: opts.detectedEmails,
      detectedJson: opts.detectedJson,
      directPathResult: opts.directPathResult,
      openHistory: opts.openHistory,
      urlRemarks: opts.urlRemarks,
      searchEngines: opts.searchEngines,
      browserRules: opts.browserRules,
      apps: opts.apps,
      extractedFileIconsRef: opts.extractedFileIconsRef,
      suppressedBrokenPathsRef: opts.suppressedBrokenPathsRef,
      includeLocalWithSearchEngine: opts.includeLocalWithSearchEngine,
    });

    const commit = () => {
      perfMarkEnd("合并:computeCombinedResults");
      setCombinedResults(results);
      setCombinedResultsQuery(queryForCombine);
      debouncedResultsQueryRef.current = queryForCombine;
      // 结果与当前输入一致 → 本地首帧呈现；延迟输出汇总，等 Everything 阶段闭合
      perfMarkEnd("本地首帧呈现");
      window.setTimeout(() => perfReport(), 1500);
    };

    if (useTransition) {
      startTransition(commit);
    } else {
      commit();
    }
  };

  // 备注 / 打开历史变化：立即重算，保证保存备注后标题马上更新
  useEffect(() => {
    applyCombinedResults(queryRef.current, false);
  }, [urlRemarks, openHistory]);

  // 搜索源变化：短防抖，避免输入卡顿
  useEffect(() => {
    if (combineTimerRef.current !== null) {
      clearTimeout(combineTimerRef.current);
    }
    combineTimerRef.current = window.setTimeout(() => {
      combineTimerRef.current = null;
      applyCombinedResults(queryRef.current, true);
    }, 32);
    return () => {
      if (combineTimerRef.current !== null) {
        clearTimeout(combineTimerRef.current);
        combineTimerRef.current = null;
      }
    };
  }, [
    filteredApps,
    filteredFiles,
    filteredMemos,
    filteredPlugins,
    everythingResults,
    detectedUrls,
    detectedEmails,
    detectedJson,
    aiAnswer,
    searchEngines,
    browserRules,
    systemFolders,
    directPathResult,
    apps,
    extractedFileIconsRef,
    extractedIconsVersion,
    suppressedBrokenPathsRef,
    forceEverythingKeyword,
    includeLocalWithSearchEngine,
  ]);

  const isStable = combinedResultsQuery === query;

  return {
    combinedResults,
    queryRef,
    debouncedResultsQueryRef,
    combinedResultsQuery,
    isStable,
  };
}
