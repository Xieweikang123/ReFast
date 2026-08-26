/**
 * 结果合并相关的自定义 Hook
 * 负责将各种搜索结果合并为统一的结果列表
 */

import { startTransition, useEffect, useRef, useState } from "react";
import { computeCombinedResults } from "../utils/combineResultsUtils";
import type { SearchResult } from "../utils/resultUtils";
import type { AppInfo, FileHistoryItem, MemoItem, SearchEngineConfig, BrowserRule } from "../types";
import type { EverythingResult } from "../types";

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
  } = options;

  const queryRef = useRef(query);
  queryRef.current = query;
  const combineTimerRef = useRef<number | null>(null);

  const [combinedResults, setCombinedResults] = useState<SearchResult[]>([]);
  const [combinedResultsQuery, setCombinedResultsQuery] = useState("");
  const debouncedResultsQueryRef = useRef<string>("");

  useEffect(() => {
    if (combineTimerRef.current !== null) {
      clearTimeout(combineTimerRef.current);
    }
    combineTimerRef.current = window.setTimeout(() => {
      combineTimerRef.current = null;
      const queryForCombine = queryRef.current;
      const everythingForCombine =
        queryForCombine.trim().length <= 1
          ? []
          : everythingResults.slice(0, 40);
      startTransition(() => {
        const results = computeCombinedResults({
          query: queryForCombine,
          aiAnswer,
          filteredApps,
          filteredFiles,
          filteredMemos,
          systemFolders,
          everythingResults: everythingForCombine,
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
          suppressedBrokenPathsRef,
        });
        setCombinedResults(results);
        setCombinedResultsQuery(queryForCombine);
        debouncedResultsQueryRef.current = queryForCombine;
      });
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
    openHistory,
    urlRemarks,
    aiAnswer,
    searchEngines,
    browserRules,
    systemFolders,
    directPathResult,
    apps,
    extractedFileIconsRef,
    extractedIconsVersion,
    suppressedBrokenPathsRef,
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
