/**
 * 搜索逻辑相关的自定义 Hook
 * 负责处理查询防抖、URL/Email/JSON 检测、Everything 搜索会话管理等
 */

import { useEffect } from "react";
import { startTransition } from "react";
import {
  extractUrls,
  extractEmails,
  isValidJson,
  isLikelyAbsolutePath,
} from "../utils/launcherUtils";
import type { AppInfo, FileHistoryItem, MemoItem, EverythingResult } from "../types";

export interface UseSearchOptions {
  // 查询状态
  query: string;
  isEverythingAvailable: boolean;
  
  // 状态设置函数
  setFilteredApps: React.Dispatch<React.SetStateAction<AppInfo[]>>;
  setFilteredFiles: React.Dispatch<React.SetStateAction<FileHistoryItem[]>>;
  setFilteredMemos: React.Dispatch<React.SetStateAction<MemoItem[]>>;
  setFilteredPlugins: React.Dispatch<React.SetStateAction<Array<{ id: string; name: string; description?: string }>>>;
  setEverythingResults: React.Dispatch<React.SetStateAction<EverythingResult[]>>;
  setEverythingTotalCount: React.Dispatch<React.SetStateAction<number | null>>;
  setEverythingCurrentCount: React.Dispatch<React.SetStateAction<number>>;
  setDirectPathResult: React.Dispatch<React.SetStateAction<FileHistoryItem | null>>;
  setDetectedUrls: React.Dispatch<React.SetStateAction<string[]>>;
  setDetectedEmails: React.Dispatch<React.SetStateAction<string[]>>;
  setDetectedJson: React.Dispatch<React.SetStateAction<string | null>>;
  setAiAnswer: React.Dispatch<React.SetStateAction<string | null>>;
  setShowAiAnswer: React.Dispatch<React.SetStateAction<boolean>>;
  setIsAiLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setResults: React.Dispatch<React.SetStateAction<any[]>>;
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  setIsSearchingEverything: React.Dispatch<React.SetStateAction<boolean>>;
  
  // 状态读取（用于检查）
  showAiAnswer: boolean;
  
  // Refs
  lastSearchQueryRef: React.MutableRefObject<string>;
  debounceTimeoutRef: React.MutableRefObject<number | null>;
  hasResultsRef: React.MutableRefObject<boolean>;
  pendingSessionIdRef: React.MutableRefObject<string | null>;
  currentSearchQueryRef: React.MutableRefObject<string>;
  displayedSearchQueryRef: React.MutableRefObject<string>;
  
  // 搜索函数
  searchSystemFoldersWrapper: (query: string) => Promise<void>;
  searchFileHistoryWrapper: (query: string) => Promise<void>;
  searchApplicationsWrapper: (query: string) => Promise<void>;
  searchMemosWrapper: (query: string) => Promise<void>;
  handleSearchPlugins: (query: string) => void;
  handleDirectPathLookup: (path: string) => Promise<void>;
  startSearchSession: (query: string) => Promise<void>;
  closeSessionSafe: (id?: string | null) => Promise<void>;
}

/**
 * 搜索逻辑 Hook
 * 处理查询防抖、URL/Email/JSON 检测、Everything 搜索会话管理等
 */
export function useSearch(options: UseSearchOptions): void {
  const {
    query,
    isEverythingAvailable,
    setFilteredApps,
    setFilteredFiles,
    setFilteredMemos,
    setFilteredPlugins,
    setEverythingResults,
    setEverythingTotalCount,
    setEverythingCurrentCount,
    setDirectPathResult,
    setDetectedUrls,
    setDetectedEmails,
    setDetectedJson,
    setAiAnswer,
    setShowAiAnswer,
    setIsAiLoading,
    setResults,
    setSelectedIndex,
    setIsSearchingEverything,
    showAiAnswer,
    lastSearchQueryRef,
    debounceTimeoutRef,
    hasResultsRef,
    pendingSessionIdRef,
    currentSearchQueryRef,
    displayedSearchQueryRef,
    searchSystemFoldersWrapper,
    searchFileHistoryWrapper,
    searchApplicationsWrapper,
    searchMemosWrapper,
    handleSearchPlugins,
    handleDirectPathLookup,
    startSearchSession,
    closeSessionSafe,
  } = options;

  // Search applications, file history, and Everything when query changes (with debounce)
  useEffect(() => {
    const trimmedQuery = query.trim();
    
    // 优化：如果 trimmedQuery 没有真正变化（例如 "a " → "a"），直接返回，避免不必要的操作
    // 这样可以避免退格时因为空格变化导致的卡顿
    if (trimmedQuery === lastSearchQueryRef.current) {
      // 如果查询为空且之前也为空，直接返回
      if (trimmedQuery === "") {
        return;
      }
      // 如果查询相同且有结果，直接返回，不重置防抖定时器
      if (hasResultsRef.current) {
        return;
      }
      // 如果查询相同但没有结果，继续执行搜索逻辑（可能是结果被清空了）
    }
    
    // 清除之前的防抖定时器（只有在查询真正变化时才清除）
    if (debounceTimeoutRef.current !== null) {
      clearTimeout(debounceTimeoutRef.current);
      debounceTimeoutRef.current = null;
    }
    
    if (trimmedQuery === "") {
      // 关闭当前 Everything 搜索会话
      const oldSessionId = pendingSessionIdRef.current;
      if (oldSessionId) {
        closeSessionSafe(oldSessionId);
      }
      pendingSessionIdRef.current = null;
      currentSearchQueryRef.current = "";
      displayedSearchQueryRef.current = "";
      lastSearchQueryRef.current = "";
      
      // React 会自动批处理 useEffect 中的状态更新，不需要 flushSync
      setFilteredApps([]);
      setFilteredFiles([]);
      setFilteredMemos([]);
      setFilteredPlugins([]);
      setEverythingResults([]);
      setEverythingTotalCount(null);
      setEverythingCurrentCount(0);
      setDetectedUrls([]);
      setDetectedEmails([]);
      setDetectedJson(null);
      setAiAnswer(null); // 清空 AI 回答
      setShowAiAnswer(false); // 退出 AI 回答模式
      setResults([]);
      setSelectedIndex(0);
      setIsSearchingEverything(false);
      hasResultsRef.current = false;
      return;
    }
    
    // If user is typing new content while in AI answer mode, exit AI answer mode
    if (showAiAnswer) {
      setShowAiAnswer(false);
      setAiAnswer(null);
      setIsAiLoading(false);
    }
    
    // Debounce search to avoid too many requests
    // 优化防抖时间：与 EverythingSearchWindow 保持一致，提升响应速度
    // Short queries (1-2 chars): 320ms (与 EverythingSearchWindow 一致)
    // Medium queries (3-5 chars): 300ms
    // Long queries (6+ chars): 200ms (仍然较快响应长查询)
    const queryLength = trimmedQuery.length;
    let debounceTime = 320; // default for short queries (与 EverythingSearchWindow 一致)
    if (queryLength >= 3 && queryLength <= 5) {
      debounceTime = 300; // medium queries
    } else if (queryLength >= 6) {
      debounceTime = 200; // long queries
    }

    const timeoutId = setTimeout(() => {
      // 再次检查查询是否仍然有效（可能在防抖期间已被清空或改变）
      const currentQuery = query.trim();
      if (currentQuery === "" || currentQuery !== trimmedQuery) {
        return;
      }
      
      // 在防抖定时器触发时清空结果，而不是在输入时清空
      // 使用 startTransition 包装清空操作，避免阻塞后续的输入
      if (trimmedQuery !== lastSearchQueryRef.current) {
        startTransition(() => {
          setFilteredApps([]);
          setFilteredFiles([]);
          setFilteredMemos([]);
          setFilteredPlugins([]);
          setEverythingResults([]);
          setEverythingTotalCount(null);
          setEverythingCurrentCount(0);
          setDirectPathResult(null);
        });
        hasResultsRef.current = false;
      }
      
      // Extract URLs from query（移到防抖内部，避免每次输入都执行）
      // 使用 startTransition 包装，避免阻塞后续的输入
      startTransition(() => {
        const urls = extractUrls(query);
        setDetectedUrls(urls);
        
        // Extract email addresses from query（移到防抖内部）
        const emails = extractEmails(query);
        setDetectedEmails(emails);
        
        // Check if query is valid JSON（移到防抖内部）
        if (isValidJson(query)) {
          setDetectedJson(query.trim());
        } else {
          setDetectedJson(null);
        }
      });
      
      const isPathQuery = isLikelyAbsolutePath(trimmedQuery);
      
      // 检查是否已有相同查询的活跃会话（快速检查，避免重复搜索）
      const hasActiveSession = pendingSessionIdRef.current && currentSearchQueryRef.current === trimmedQuery;
      // 使用 ref 而不是直接读取状态，避免触发不必要的重新渲染
      const hasResults = hasResultsRef.current;
      
      // 如果已有相同查询的活跃会话且有结果，跳过重复搜索
      if (hasActiveSession && hasResults) {
        return;
      }
      
      // 如果查询不同，关闭旧会话（不阻塞，异步执行）
      if (pendingSessionIdRef.current && currentSearchQueryRef.current !== trimmedQuery) {
        const oldSessionId = pendingSessionIdRef.current;
        // 不阻塞等待，立即开始新搜索
        closeSessionSafe(oldSessionId).catch(() => {
          // 静默处理错误
        });
        pendingSessionIdRef.current = null;
        currentSearchQueryRef.current = "";
        displayedSearchQueryRef.current = "";
      }
      
      // 如果会话存在但结果为空，说明结果被清空了，需要重新搜索
      if (hasActiveSession && !hasResults) {
        // 重置会话状态，强制重新搜索
        const oldSessionId = pendingSessionIdRef.current;
        if (oldSessionId) {
          closeSessionSafe(oldSessionId).catch(() => {
            // 静默处理错误
          });
        }
        pendingSessionIdRef.current = null;
        currentSearchQueryRef.current = "";
        displayedSearchQueryRef.current = "";
      }
      
      // 标记当前查询为已搜索
      lastSearchQueryRef.current = trimmedQuery;
      
      // 处理绝对路径查询
      if (isPathQuery) {
        handleDirectPathLookup(trimmedQuery);
        // 绝对路径查询不需要 Everything 结果
        setEverythingResults([]);
        setEverythingTotalCount(null);
        setEverythingCurrentCount(0);
        setIsSearchingEverything(false);
        hasResultsRef.current = false;
        // 关闭当前会话
        const oldSessionId = pendingSessionIdRef.current;
        if (oldSessionId) {
          closeSessionSafe(oldSessionId).catch(() => {
            // 静默处理错误
          });
        }
        pendingSessionIdRef.current = null;
        currentSearchQueryRef.current = "";
        displayedSearchQueryRef.current = "";
      } else {
        // 使用 startTransition 包装，避免阻塞后续的输入
        startTransition(() => {
          setDirectPathResult(null);
        });
        
        // Everything 搜索立即执行，不延迟
        if (isEverythingAvailable) {
          startSearchSession(trimmedQuery).catch(() => {
            // 静默处理错误
          });
        }
      }
      
      // ========== 性能优化：并行执行所有搜索 ==========
      // 使用 setTimeout(0) 将搜索操作推迟到下一个事件循环，避免阻塞防抖定时器
      // 这样可以让输入框更快响应，即使搜索函数正在执行
      setTimeout(() => {
        // 系统文件夹和文件历史搜索立即执行
        Promise.all([
          searchSystemFoldersWrapper(trimmedQuery),
          searchFileHistoryWrapper(trimmedQuery),
        ]).catch((error) => {
          console.error("[搜索错误] 并行搜索失败:", error);
        });
        
        console.log(`[搜索流程] 准备调用 searchApplications: query="${trimmedQuery}"`);
        searchApplicationsWrapper(trimmedQuery).catch((error) => {
          console.error("[搜索错误] searchApplications 调用失败:", error);
        });
        
        // 备忘录和插件搜索是纯前端过滤，立即执行（不会阻塞）
        searchMemosWrapper(trimmedQuery);
        handleSearchPlugins(trimmedQuery);
      }, 0);
    }, debounceTime) as unknown as number;
    
    debounceTimeoutRef.current = timeoutId;
    
    return () => {
      if (debounceTimeoutRef.current !== null) {
        clearTimeout(debounceTimeoutRef.current);
        debounceTimeoutRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, isEverythingAvailable]);
}

