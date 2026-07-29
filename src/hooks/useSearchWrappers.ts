/**
 * 搜索相关的 wrapper 函数 Hook
 * 负责管理所有搜索相关的包装函数
 */

import { useCallback, type MutableRefObject } from "react";
import { startTransition } from "react";
import { tauriApi } from "../api/tauri";
import { searchMemos, searchSystemFolders, searchApplications, searchFileHistory } from "../utils/searchUtils";
import { searchPlugins } from "../plugins";
import type { AppInfo, FileHistoryItem, MemoItem } from "../types";

/**
 * 搜索 Wrappers Hook 的选项接口
 */
export interface UseSearchWrappersOptions {
  // States
  query: string;
  memos: MemoItem[];
  apps: AppInfo[];

  // Refs
  allFileHistoryCacheRef: MutableRefObject<FileHistoryItem[]>;
  allFileHistoryCacheLoadedRef: MutableRefObject<boolean>;
  allAppsCacheRef: MutableRefObject<AppInfo[]>;
  allAppsCacheLoadedRef: MutableRefObject<boolean>;
  systemFoldersListRef: MutableRefObject<Array<{ name: string; path: string; display_name: string; is_folder: boolean; icon?: string; name_pinyin?: string; name_pinyin_initials?: string }>>;
  systemFoldersListLoadedRef: MutableRefObject<boolean>;
  extractedFileIconsRef: MutableRefObject<Map<string, string>>;

  // Functions
  updateSearchResults: <T>(setter: (value: T) => void, value: T) => void;
  filterWindowsApps: (apps: AppInfo[]) => AppInfo[];

  // Setters
  setFilteredMemos: React.Dispatch<React.SetStateAction<MemoItem[]>>;
  setFilteredFiles: React.Dispatch<React.SetStateAction<FileHistoryItem[]>>;
  setFilteredApps: React.Dispatch<React.SetStateAction<AppInfo[]>>;
  setFilteredPlugins: React.Dispatch<React.SetStateAction<Array<{ id: string; name: string; description?: string }>>>;
  setSystemFolders: React.Dispatch<React.SetStateAction<Array<{ name: string; path: string; display_name: string; is_folder: boolean; icon?: string; name_pinyin?: string; name_pinyin_initials?: string }>>>;
  setApps: React.Dispatch<React.SetStateAction<AppInfo[]>>;
  setDirectPathResult: React.Dispatch<React.SetStateAction<FileHistoryItem | null>>;
}

/**
 * 搜索 Wrappers Hook
 */
export function useSearchWrappers(
  options: UseSearchWrappersOptions
): {
  searchMemosWrapper: (q: string) => Promise<void>;
  searchSystemFoldersWrapper: (searchQuery: string) => Promise<void>;
  searchApplicationsWrapper: (searchQuery: string) => Promise<void>;
  searchFileHistoryWrapper: (searchQuery: string) => Promise<void>;
  handleSearchPlugins: (q: string) => void;
  handleDirectPathLookup: (rawPath: string) => Promise<void>;
  refreshFileHistoryCache: () => Promise<void>;
} {
  const {
    query,
    memos,
    apps,
    allFileHistoryCacheRef,
    allFileHistoryCacheLoadedRef,
    allAppsCacheRef,
    allAppsCacheLoadedRef,
    systemFoldersListRef,
    systemFoldersListLoadedRef,
    extractedFileIconsRef,
    updateSearchResults,
    filterWindowsApps,
    setFilteredMemos,
    setFilteredFiles,
    setFilteredApps,
    setFilteredPlugins,
    setSystemFolders,
    setApps,
    setDirectPathResult,
  } = options;

  const searchMemosWrapper = useCallback(
    async (q: string) => {
      await searchMemos(q, {
        memos,
        currentQuery: query,
        updateSearchResults,
        setFilteredMemos,
      });
    },
    [memos, query, updateSearchResults, setFilteredMemos]
  );

  const searchSystemFoldersWrapper = useCallback(
    async (searchQuery: string) => {
      await searchSystemFolders(searchQuery, {
        currentQuery: query,
        updateSearchResults,
        setSystemFolders,
        systemFoldersListRef,
        systemFoldersListLoadedRef,
      });
    },
    [query, updateSearchResults, setSystemFolders, systemFoldersListRef, systemFoldersListLoadedRef]
  );

  const searchApplicationsWrapper = useCallback(
    async (searchQuery: string) => {
      await searchApplications(searchQuery, {
        currentQuery: query,
        updateSearchResults,
        setFilteredApps,
        setApps,
        allAppsCacheRef,
        allAppsCacheLoadedRef,
        apps,
        filterWindowsApps,
      });
    },
    [query, updateSearchResults, setFilteredApps, setApps, allAppsCacheRef, allAppsCacheLoadedRef, apps, filterWindowsApps]
  );

  const searchFileHistoryWrapper = useCallback(
    async (searchQuery: string) => {
      await searchFileHistory(searchQuery, {
        currentQuery: query,
        updateSearchResults,
        setFilteredFiles,
        allFileHistoryCacheRef,
        allFileHistoryCacheLoadedRef,
        extractedFileIconsRef,
        apps,
      });
    },
    [query, updateSearchResults, setFilteredFiles, allFileHistoryCacheRef, allFileHistoryCacheLoadedRef, extractedFileIconsRef, apps]
  );

  const handleSearchPlugins = useCallback(
    (q: string) => {
      // Don't search if query is empty
      if (!q || q.trim() === "") {
        updateSearchResults(setFilteredPlugins, []);
        return;
      }

      let filtered;
      try {
        filtered = searchPlugins(q);
      } catch (err) {
        console.error(`[handleSearchPlugins] searchPlugins threw:`, err);
        updateSearchResults(setFilteredPlugins, []);
        return;
      }

      // Only update if query hasn't changed
      if (query.trim() === q.trim()) {
        updateSearchResults(
          setFilteredPlugins,
          filtered.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
          }))
        );
      } else {
        updateSearchResults(setFilteredPlugins, []);
      }
    },
    [query, updateSearchResults, setFilteredPlugins]
  );

  const handleDirectPathLookup = useCallback(
    async (rawPath: string) => {
      try {
        const result = await tauriApi.checkPathExists(rawPath);
        // 只在查询未变化时更新，使用 startTransition 避免阻塞输入
        if (query.trim() === rawPath.trim() && result) {
          startTransition(() => {
            setDirectPathResult(result);
          });
        } else if (query.trim() === rawPath.trim()) {
          startTransition(() => {
            setDirectPathResult(null);
          });
        }
      } catch (error) {
        console.error("Direct path lookup failed:", error);
        if (query.trim() === rawPath.trim()) {
          startTransition(() => {
            setDirectPathResult(null);
          });
        }
      }
    },
    [query, setDirectPathResult]
  );

  const refreshFileHistoryCache = useCallback(async () => {
    try {
      const allFileHistory = await tauriApi.getAllFileHistory();
      allFileHistoryCacheRef.current = allFileHistory;
      allFileHistoryCacheLoadedRef.current = true;
    } catch (error) {
      console.error("Failed to refresh file history cache:", error);
    }
  }, [allFileHistoryCacheRef, allFileHistoryCacheLoadedRef]);

  return {
    searchMemosWrapper,
    searchSystemFoldersWrapper,
    searchApplicationsWrapper,
    searchFileHistoryWrapper,
    handleSearchPlugins,
    handleDirectPathLookup,
    refreshFileHistoryCache,
  };
}

