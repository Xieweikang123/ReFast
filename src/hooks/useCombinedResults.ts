/**
 * 结果合并相关的自定义 Hook
 * 负责将各种搜索结果合并为统一的结果列表
 */

import { useState, useEffect, useRef, useDeferredValue, useCallback } from "react";
import { startTransition } from "react";
import { computeCombinedResults } from "../utils/combineResultsUtils";
import type { SearchResult } from "../utils/resultUtils";
import type { AppInfo, FileHistoryItem, MemoItem, SearchEngineConfig } from "../types";
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
  apps: AppInfo[];
  extractedFileIconsRef: React.MutableRefObject<Map<string, string>>;
}

/**
 * 结果合并 Hook
 * 使用 startTransition 和 useDeferredValue 优化性能，避免阻塞输入响应
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
    apps,
    extractedFileIconsRef,
  } = options;

  // 使用 useState + useEffect 替代 useMemo，在 useEffect 中使用 startTransition 异步计算
  // 这样可以避免 useMemo 的同步计算阻塞输入响应
  const [combinedResultsRaw, setCombinedResultsRaw] = useState<SearchResult[]>([]);
  
  useEffect(() => {
    // 使用 requestIdleCallback 或 setTimeout 延迟计算，避免阻塞输入响应
    // 这样可以让输入框保持响应，不会因为结果计算而卡顿
    const scheduleCompute = () => {
      // 使用 startTransition 标记状态更新为非紧急更新
      startTransition(() => {
        const results = computeCombinedResults({
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
          apps,
          extractedFileIconsRef,
        });
        setCombinedResultsRaw(results);
      });
    };
    
    // 使用 requestIdleCallback 或 setTimeout 延迟计算，避免阻塞输入响应
    if (window.requestIdleCallback) {
      window.requestIdleCallback(scheduleCompute, { timeout: 100 });
    } else {
      setTimeout(scheduleCompute, 0);
    }
  }, [filteredApps, filteredFiles, filteredMemos, filteredPlugins, everythingResults, detectedUrls, detectedEmails, detectedJson, openHistory, urlRemarks, query, aiAnswer, searchEngines, systemFolders, directPathResult, apps, extractedFileIconsRef]);

  // 使用 useDeferredValue 延迟 combinedResults 的更新，让输入框保持响应
  // 当用户快速输入时，React 会延迟更新 combinedResults，优先处理输入事件
  // 这样可以避免 combinedResults 的耗时计算（66-76ms）阻塞输入响应
  const combinedResults = useDeferredValue(combinedResultsRaw);
  
  // 防抖延迟更新 debouncedCombinedResults，避免多个搜索结果异步返回时频繁重新排序
  const [debouncedCombinedResults, setDebouncedCombinedResults] = useState<SearchResult[]>([]);
  const combinedResultsUpdateTimeoutRef = useRef<number | null>(null);
  
  useEffect(() => {
    // 清除之前的定时器
    if (combinedResultsUpdateTimeoutRef.current !== null) {
      clearTimeout(combinedResultsUpdateTimeoutRef.current);
      combinedResultsUpdateTimeoutRef.current = null;
    }
    
    // 优化：如果有应用搜索结果，立即更新（0ms延迟），让应用列表快速显示
    // 如果没有应用搜索结果，使用5ms延迟等待其他搜索结果
    const delay = filteredApps.length > 0 ? 0 : 5;
    
    combinedResultsUpdateTimeoutRef.current = setTimeout(() => {
      // 使用 startTransition 标记结果更新为非紧急更新
      // 这样可以让输入框保持响应，不会因为结果列表更新而卡顿
      startTransition(() => {
        setDebouncedCombinedResults(combinedResults);
        // 更新 debouncedResultsQueryRef 为当前查询，用于验证结果是否与当前查询匹配
        debouncedResultsQueryRef.current = queryRef.current;
      });
    }, delay) as unknown as number;
    
    return () => {
      if (combinedResultsUpdateTimeoutRef.current !== null) {
        clearTimeout(combinedResultsUpdateTimeoutRef.current);
        combinedResultsUpdateTimeoutRef.current = null;
      }
    };
  }, [combinedResults, filteredApps.length]);

  // 使用 ref 来跟踪当前的 query，避免闭包问题
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  // 使用 ref 跟踪 debouncedCombinedResults 对应的查询，用于验证结果是否与当前查询匹配
  const debouncedResultsQueryRef = useRef<string>("");

  return {
    combinedResults: debouncedCombinedResults,
    queryRef,
    debouncedResultsQueryRef,
  };
}

