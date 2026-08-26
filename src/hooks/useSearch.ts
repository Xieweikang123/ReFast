/**
 * 搜索逻辑相关的自定义 Hook
 * 负责处理查询防抖、URL/Email/JSON 检测、Everything 搜索会话管理等
 */

import { useEffect, useRef } from "react";
import { startTransition } from "react";
import {
  extractUrls,
  extractEmails,
  isValidJson,
  isLikelyAbsolutePath,
} from "../utils/launcherUtils";
import {
  parseSearchFilter,
  hasSearchKeyword,
  shouldSearchSource,
} from "../utils/searchFilterUtils";
import type { AppInfo, FileHistoryItem, MemoItem, EverythingResult } from "../types";

/** 本地源（应用/历史/插件等）短防抖，保证打字后尽快出首屏 */
const LOCAL_DEBOUNCE_MS = 80;

function everythingDebounceMs(keywordLength: number): number {
  if (keywordLength >= 6) {
    return 200;
  }
  if (keywordLength >= 3) {
    return 300;
  }
  return 320;
}

export interface UseSearchOptions {
  // 查询状态
  query: string;
  isEverythingAvailable: boolean;
  /** 粘贴图片的临时路径；与 query 相同时跳过 Everything */
  pastedImagePath?: string | null;
  
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
  setIsDebouncePending?: React.Dispatch<React.SetStateAction<boolean>>;
  setIsLocalSearchPending?: React.Dispatch<React.SetStateAction<boolean>>;
  
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

function buildSearchIdentity(query: string): string {
  const parsed = parseSearchFilter(query);
  if (parsed.hasFilter) {
    return `${parsed.matchedPrefix ?? ""}${parsed.keyword}`;
  }
  return parsed.keyword;
}

function clearTimer(ref: React.MutableRefObject<number | null>): void {
  if (ref.current !== null) {
    clearTimeout(ref.current);
    ref.current = null;
  }
}

/**
 * 搜索逻辑 Hook
 * 本地源与 Everything 分开防抖：先出应用/历史，磁盘索引稍后合并
 */
export function useSearch(options: UseSearchOptions): void {
  const {
    query,
    isEverythingAvailable,
    pastedImagePath = null,
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
    setIsDebouncePending,
    setIsLocalSearchPending,
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

  const everythingDebounceTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const parsed = parseSearchFilter(query);
    const searchIdentity = buildSearchIdentity(query);
    const keyword = parsed.keyword;
    
    if (searchIdentity === lastSearchQueryRef.current) {
      if (searchIdentity === "") {
        return;
      }
      if (hasResultsRef.current) {
        return;
      }
    }
    
    clearTimer(debounceTimeoutRef);
    clearTimer(everythingDebounceTimeoutRef);

    if (searchIdentity !== "" && searchIdentity !== lastSearchQueryRef.current) {
      setIsDebouncePending?.(true);
      setIsLocalSearchPending?.(false);
    }
    
    if (!hasSearchKeyword(parsed)) {
      const oldSessionId = pendingSessionIdRef.current;
      if (oldSessionId) {
        closeSessionSafe(oldSessionId);
      }
      pendingSessionIdRef.current = null;
      currentSearchQueryRef.current = "";
      displayedSearchQueryRef.current = "";
      lastSearchQueryRef.current = "";
      
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
      setAiAnswer(null);
      setShowAiAnswer(false);
      setResults([]);
      setSelectedIndex(0);
      setIsSearchingEverything(false);
      hasResultsRef.current = false;
      setIsDebouncePending?.(false);
      setIsLocalSearchPending?.(false);
      return;
    }
    
    if (showAiAnswer) {
      setShowAiAnswer(false);
      setAiAnswer(null);
      setIsAiLoading(false);
    }

    // 查询已变：取消进行中的 Everything，避免旧 IPC 占着通道
    if (
      pendingSessionIdRef.current &&
      currentSearchQueryRef.current !== keyword
    ) {
      closeSessionSafe(pendingSessionIdRef.current).catch(() => {});
      pendingSessionIdRef.current = null;
      currentSearchQueryRef.current = "";
      displayedSearchQueryRef.current = "";
      setIsSearchingEverything(false);
    }

    const localTimeoutId = window.setTimeout(() => {
      setIsDebouncePending?.(false);

      const currentParsed = parseSearchFilter(query);
      const currentIdentity = buildSearchIdentity(query);
      if (!hasSearchKeyword(currentParsed) || currentIdentity !== searchIdentity) {
        setIsLocalSearchPending?.(false);
        return;
      }

      const currentKeyword = currentParsed.keyword;
      const currentScope = currentParsed.scope;
      
      setIsLocalSearchPending?.(true);

      startTransition(() => {
        try {
          if (shouldSearchSource(currentScope, "url")) {
            setDetectedUrls(extractUrls(currentKeyword));
          } else {
            setDetectedUrls([]);
          }
          
          if (shouldSearchSource(currentScope, "email")) {
            setDetectedEmails(extractEmails(currentKeyword));
          } else {
            setDetectedEmails([]);
          }
          
          try {
            if (
              shouldSearchSource(currentScope, "json") &&
              isValidJson(currentKeyword)
            ) {
              setDetectedJson(currentKeyword.trim());
            } else {
              setDetectedJson(null);
            }
          } catch (error) {
            console.warn('[JSON检测] 检测失败，跳过JSON识别:', error);
            setDetectedJson(null);
          }
        } catch (error) {
          console.warn('[搜索] URL/Email提取失败:', error);
          setDetectedUrls([]);
          setDetectedEmails([]);
          setDetectedJson(null);
        }
      });

      const isPastedImageQuery =
        !!pastedImagePath && currentKeyword === pastedImagePath.trim();
      const isPathQuery =
        shouldSearchSource(currentScope, "path") &&
        (isLikelyAbsolutePath(currentKeyword) || isPastedImageQuery);

      lastSearchQueryRef.current = searchIdentity;

      if (isPathQuery) {
        handleDirectPathLookup(currentKeyword);
        setEverythingResults([]);
        setEverythingTotalCount(null);
        setEverythingCurrentCount(0);
        setIsSearchingEverything(false);
        hasResultsRef.current = false;
        const oldSessionId = pendingSessionIdRef.current;
        if (oldSessionId) {
          closeSessionSafe(oldSessionId).catch(() => {});
        }
        pendingSessionIdRef.current = null;
        currentSearchQueryRef.current = "";
        displayedSearchQueryRef.current = "";
      } else {
        startTransition(() => {
          setDirectPathResult(null);
        });
      }

      const localSearchGeneration = searchIdentity;
      const tasks: Promise<void>[] = [];

      if (shouldSearchSource(currentScope, "systemFolder")) {
        tasks.push(searchSystemFoldersWrapper(currentKeyword));
      }

      if (shouldSearchSource(currentScope, "file")) {
        tasks.push(searchFileHistoryWrapper(currentKeyword));
      } else {
        startTransition(() => setFilteredFiles([]));
      }

      if (shouldSearchSource(currentScope, "app")) {
        tasks.push(searchApplicationsWrapper(currentKeyword));
      } else {
        startTransition(() => setFilteredApps([]));
      }

      if (shouldSearchSource(currentScope, "memo")) {
        tasks.push(searchMemosWrapper(currentKeyword));
      } else {
        startTransition(() => setFilteredMemos([]));
      }

      if (shouldSearchSource(currentScope, "plugin")) {
        handleSearchPlugins(currentKeyword);
      } else {
        startTransition(() => setFilteredPlugins([]));
      }

      const finishLocal = () => {
        if (lastSearchQueryRef.current === localSearchGeneration) {
          setIsLocalSearchPending?.(false);
        }
      };

      if (tasks.length > 0) {
        Promise.all(tasks)
          .catch((error) => {
            console.error("[搜索错误] 并行搜索失败:", error);
          })
          .finally(finishLocal);
      } else {
        finishLocal();
      }
    }, LOCAL_DEBOUNCE_MS);

    const everythingTimeoutId = window.setTimeout(() => {
      const currentParsed = parseSearchFilter(query);
      const currentIdentity = buildSearchIdentity(query);
      if (!hasSearchKeyword(currentParsed) || currentIdentity !== searchIdentity) {
        return;
      }

      const currentKeyword = currentParsed.keyword;
      const currentScope = currentParsed.scope;
      const isPastedImageQuery =
        !!pastedImagePath && currentKeyword === pastedImagePath.trim();
      const isPathQuery =
        shouldSearchSource(currentScope, "path") &&
        (isLikelyAbsolutePath(currentKeyword) || isPastedImageQuery);

      if (isPathQuery) {
        return;
      }

      const hasActiveSession =
        pendingSessionIdRef.current &&
        currentSearchQueryRef.current === currentKeyword;
      const hasResults = hasResultsRef.current;

      if (hasActiveSession && hasResults) {
        return;
      }

      if (
        pendingSessionIdRef.current &&
        currentSearchQueryRef.current !== currentKeyword
      ) {
        closeSessionSafe(pendingSessionIdRef.current).catch(() => {});
        pendingSessionIdRef.current = null;
        currentSearchQueryRef.current = "";
        displayedSearchQueryRef.current = "";
      }

      if (hasActiveSession && !hasResults) {
        const oldSessionId = pendingSessionIdRef.current;
        if (oldSessionId) {
          closeSessionSafe(oldSessionId).catch(() => {});
        }
        pendingSessionIdRef.current = null;
        currentSearchQueryRef.current = "";
        displayedSearchQueryRef.current = "";
      }

      if (
        isEverythingAvailable &&
        shouldSearchSource(currentScope, "everything") &&
        currentKeyword.length >= 2
      ) {
        startSearchSession(currentKeyword).catch(() => {});
      } else {
        setEverythingResults([]);
        setEverythingTotalCount(null);
        setEverythingCurrentCount(0);
        setIsSearchingEverything(false);
        const oldSessionId = pendingSessionIdRef.current;
        if (oldSessionId) {
          closeSessionSafe(oldSessionId).catch(() => {});
        }
        pendingSessionIdRef.current = null;
        currentSearchQueryRef.current = "";
        displayedSearchQueryRef.current = "";
      }
    }, everythingDebounceMs(keyword.length));
    
    debounceTimeoutRef.current = localTimeoutId;
    everythingDebounceTimeoutRef.current = everythingTimeoutId;
    
    return () => {
      clearTimer(debounceTimeoutRef);
      clearTimer(everythingDebounceTimeoutRef);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, isEverythingAvailable, pastedImagePath]);
}
