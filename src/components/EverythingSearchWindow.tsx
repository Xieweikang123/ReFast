import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { tauriApi } from "../api/tauri";
import type { EverythingResult, FilePreview } from "../types";
import { formatStandardDateTime } from "../utils/dateUtils";
import { useWindowClose } from "../hooks/useWindowClose";
import {
  classifyFileKind,
  composeEverythingQuery,
  formatFileSize,
  getFileKindLabel,
  highlightSegments,
  parseDate,
  pushRecentQuery,
  readRecentQueries,
  type FileKind,
  type ItemKindFilter,
} from "../utils/everythingSearchWindowUtils";

type SortKey = "modified" | "size" | "type" | "name";
type SortOrder = "asc" | "desc";

type FilterItem = {
  id: string;
  label: string;
  extensions: string[];
  isCustom?: boolean;
};

type CustomFilter = Omit<FilterItem, "isCustom">;

const SORT_PREFERENCE_KEY = "everything_sort_pref";
const FILTER_PREFERENCE_KEY = "everything_filter_pref";
const CUSTOM_FILTER_PREFERENCE_KEY = "everything_custom_filters";
const MAX_RESULTS_PREFERENCE_KEY = "everything_max_results_pref";
const MATCH_FOLDER_NAME_ONLY_PREFERENCE_KEY = "everything_match_folder_name_only";
const ITEM_KIND_PREFERENCE_KEY = "everything_item_kind";
const PATH_SCOPE_PREFERENCE_KEY = "everything_path_scope";
const CASE_SENSITIVE_PREFERENCE_KEY = "everything_case_sensitive";
const MATCH_WHOLE_WORD_PREFERENCE_KEY = "everything_match_whole_word";
const PREVIEW_OPEN_PREFERENCE_KEY = "everything_preview_open";
const RECENT_QUERIES_KEY = "everything_recent_queries";
const DEFAULT_MAX_RESULTS = 5000;
const ABS_MAX_RESULTS = 2000000;
const SAFE_DISPLAY_LIMIT = 2000000;
const PAGE_SIZE = 500;
const MAX_CACHED_PAGES = 8;
const ITEM_HEIGHT = 64;
const OVERSCAN = 8;
const MAX_RECENT_QUERIES = 8;

const QUICK_FILTERS: FilterItem[] = [
  { id: "all", label: "全部类型", extensions: [] },
  {
    id: "images",
    label: "图片",
    extensions: ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico", "tif", "heic"],
  },
  {
    id: "documents",
    label: "文档",
    extensions: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "odt", "csv", "md"],
  },
  {
    id: "video",
    label: "视频",
    extensions: ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v"],
  },
  {
    id: "audio",
    label: "音频",
    extensions: ["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma"],
  },
  {
    id: "code",
    label: "代码",
    extensions: [
      "ts",
      "tsx",
      "js",
      "jsx",
      "py",
      "java",
      "c",
      "cpp",
      "cs",
      "rs",
      "go",
      "rb",
      "php",
      "kt",
      "swift",
      "sh",
      "html",
      "css",
      "scss",
      "json",
      "md",
      "yml",
      "yaml",
      "toml",
      "sql",
    ],
  },
  {
    id: "archive",
    label: "压缩包",
    extensions: ["zip", "rar", "7z", "tar", "gz", "bz2"],
  },
  {
    id: "programs",
    label: "程序",
    extensions: ["exe", "msi", "bat", "cmd", "ps1", "lnk"],
  },
];

const SORT_OPTIONS: { key: SortKey; label: string; defaultOrder: SortOrder }[] = [
  { key: "modified", label: "修改时间", defaultOrder: "desc" },
  { key: "name", label: "名称", defaultOrder: "asc" },
  { key: "size", label: "大小", defaultOrder: "desc" },
  { key: "type", label: "类型", defaultOrder: "asc" },
];

const ITEM_KIND_OPTIONS: { id: ItemKindFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "file", label: "文件" },
  { id: "folder", label: "文件夹" },
];

export function EverythingSearchWindow() {
  const [query, setQuery] = useState("");
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isEverythingAvailable, setIsEverythingAvailable] = useState(false);
  const [everythingError, setEverythingError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("modified");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [activeFilterId, setActiveFilterId] = useState<string>("all");
  const [customFilters, setCustomFilters] = useState<CustomFilter[]>([]);
  const [newFilterName, setNewFilterName] = useState("");
  const [newFilterExts, setNewFilterExts] = useState("");
  const [previewData, setPreviewData] = useState<FilePreview | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [selectedIcon, setSelectedIcon] = useState<string | null>(null);
  const [matchFolderNameOnly, setMatchFolderNameOnly] = useState(false);
  const [itemKind, setItemKind] = useState<ItemKindFilter>("all");
  const [pathScope, setPathScope] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matchWholeWord, setMatchWholeWord] = useState(false);
  const [maxResults, setMaxResults] = useState<number>(DEFAULT_MAX_RESULTS);
  const [showSyntaxHelp, setShowSyntaxHelp] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [showRecent, setShowRecent] = useState(false);
  const [recentQueries, setRecentQueries] = useState<string[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionMode, setSessionMode] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [cacheVersion, setCacheVersion] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [softLimitWarning, setSoftLimitWarning] = useState<string | null>(null);
  const [currentLoadedCount, setCurrentLoadedCount] = useState(0);

  const debounceTimeoutRef = useRef<number | null>(null);
  const previewRequestIdRef = useRef(0);
  const inflightPagesRef = useRef<Set<number>>(new Set());
  const pageCacheRef = useRef<Map<number, EverythingResult[]>>(new Map());
  const pageOrderRef = useRef<number[]>([]);
  const pendingSessionIdRef = useRef<string | null>(null);
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const currentSearchQueryRef = useRef<string>("");
  const startSearchSessionRef = useRef<typeof startSearchSession | null>(null);
  const creatingSessionQueryRef = useRef<string | null>(null);
  const filtersReadyRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
  const activeSessionParamsRef = useRef<{
    query: string;
    extensions?: string[];
    maxResults: number;
    sortKey: SortKey;
    sortOrder: SortOrder;
    matchFolderNameOnly: boolean;
    itemKind: ItemKindFilter;
    pathScope: string;
    caseSensitive: boolean;
    matchWholeWord: boolean;
  } | null>(null);

  const activeFilter = useMemo<FilterItem | undefined>(() => {
    const builtIn = QUICK_FILTERS.find((f) => f.id === activeFilterId);
    if (builtIn) return builtIn;
    const custom = customFilters.find((f) => f.id === activeFilterId);
    if (custom) return { ...custom, isCustom: true };
    return QUICK_FILTERS[0];
  }, [activeFilterId, customFilters]);

  const isEditingExistingFilter = useMemo(() => {
    return customFilters.some((f) => f.id === activeFilterId);
  }, [activeFilterId, customFilters]);

  const startSessionFn = tauriApi.startEverythingSearchSession;
  const getRangeFn = tauriApi.getEverythingSearchRange;
  const closeSessionFn = tauriApi.closeEverythingSearchSession;

  const closeSessionFnRef = useRef(closeSessionFn);
  useEffect(() => {
    closeSessionFnRef.current = closeSessionFn;
  }, [closeSessionFn]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => setToast(null), 1800);
  }, []);

  useEffect(() => {
    const loadPreferences = async () => {
      try {
        const savedSort = localStorage.getItem(SORT_PREFERENCE_KEY);
        if (savedSort) {
          const parsed = JSON.parse(savedSort) as { key?: SortKey; order?: SortOrder };
          if (parsed.key === "modified" || parsed.key === "size" || parsed.key === "type" || parsed.key === "name") {
            setSortKey(parsed.key);
          }
          if (parsed.order === "asc" || parsed.order === "desc") {
            setSortOrder(parsed.order);
          }
        }

        const savedFilterId = localStorage.getItem(FILTER_PREFERENCE_KEY);
        if (savedFilterId) setActiveFilterId(savedFilterId);

        try {
          const filters = await tauriApi.getEverythingCustomFilters();
          setCustomFilters(filters || []);

          if (!filters || filters.length === 0) {
            const savedCustom = localStorage.getItem(CUSTOM_FILTER_PREFERENCE_KEY);
            if (savedCustom) {
              try {
                const parsed = JSON.parse(savedCustom) as CustomFilter[];
                if (Array.isArray(parsed) && parsed.length > 0) {
                  await tauriApi.saveEverythingCustomFilters(parsed);
                  setCustomFilters(parsed);
                  localStorage.removeItem(CUSTOM_FILTER_PREFERENCE_KEY);
                }
              } catch (error) {
                console.error("迁移自定义过滤器失败:", error);
              }
            }
          }
        } catch (error) {
          console.error("加载自定义过滤器失败:", error);
        } finally {
          filtersReadyRef.current = true;
        }

        const savedMaxResults = localStorage.getItem(MAX_RESULTS_PREFERENCE_KEY);
        if (savedMaxResults) {
          const parsed = parseInt(savedMaxResults, 10);
          if (!isNaN(parsed) && parsed > 0) {
            setMaxResults(parsed);
          }
        }

        const savedMatchFolderNameOnly = localStorage.getItem(MATCH_FOLDER_NAME_ONLY_PREFERENCE_KEY);
        if (savedMatchFolderNameOnly !== null) {
          setMatchFolderNameOnly(savedMatchFolderNameOnly === "true");
        }

        const savedItemKind = localStorage.getItem(ITEM_KIND_PREFERENCE_KEY);
        if (savedItemKind === "file" || savedItemKind === "folder" || savedItemKind === "all") {
          setItemKind(savedItemKind);
        }

        const savedPathScope = localStorage.getItem(PATH_SCOPE_PREFERENCE_KEY);
        if (savedPathScope) setPathScope(savedPathScope);

        const savedCase = localStorage.getItem(CASE_SENSITIVE_PREFERENCE_KEY);
        if (savedCase !== null) setCaseSensitive(savedCase === "true");

        const savedWholeWord = localStorage.getItem(MATCH_WHOLE_WORD_PREFERENCE_KEY);
        if (savedWholeWord !== null) setMatchWholeWord(savedWholeWord === "true");

        const savedPreview = localStorage.getItem(PREVIEW_OPEN_PREFERENCE_KEY);
        if (savedPreview !== null) setShowPreview(savedPreview === "true");

        setRecentQueries(readRecentQueries(localStorage.getItem(RECENT_QUERIES_KEY), MAX_RECENT_QUERIES));
      } catch (error) {
        console.warn("加载 Everything 偏好失败", error);
        filtersReadyRef.current = true;
      }
    };

    loadPreferences();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SORT_PREFERENCE_KEY, JSON.stringify({ key: sortKey, order: sortOrder }));
    } catch {
      // ignore
    }
  }, [sortKey, sortOrder]);

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_PREFERENCE_KEY, activeFilterId);
    } catch {
      // ignore
    }
  }, [activeFilterId]);

  useEffect(() => {
    if (!filtersReadyRef.current) return;
    const saveFilters = async () => {
      try {
        await tauriApi.saveEverythingCustomFilters(customFilters);
        localStorage.removeItem(CUSTOM_FILTER_PREFERENCE_KEY);
      } catch (error) {
        console.error("自动保存自定义过滤器到数据库失败:", error);
      }
    };
    const timer = setTimeout(saveFilters, 200);
    return () => clearTimeout(timer);
  }, [customFilters]);

  useEffect(() => {
    try {
      localStorage.setItem(MATCH_FOLDER_NAME_ONLY_PREFERENCE_KEY, matchFolderNameOnly.toString());
      localStorage.setItem(ITEM_KIND_PREFERENCE_KEY, itemKind);
      localStorage.setItem(PATH_SCOPE_PREFERENCE_KEY, pathScope);
      localStorage.setItem(CASE_SENSITIVE_PREFERENCE_KEY, caseSensitive.toString());
      localStorage.setItem(MATCH_WHOLE_WORD_PREFERENCE_KEY, matchWholeWord.toString());
      localStorage.setItem(PREVIEW_OPEN_PREFERENCE_KEY, showPreview.toString());
      localStorage.setItem(MAX_RESULTS_PREFERENCE_KEY, maxResults.toString());
    } catch {
      // ignore
    }
  }, [
    matchFolderNameOnly,
    itemKind,
    pathScope,
    caseSensitive,
    matchWholeWord,
    showPreview,
    maxResults,
  ]);

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const status = await tauriApi.getEverythingStatus();
        setIsEverythingAvailable(status.available);
        setEverythingError(status.error || null);
      } catch (error) {
        console.error("Failed to check Everything status:", error);
        setIsEverythingAvailable(false);
      }
    };
    checkStatus();
  }, []);

  const resetCaches = useCallback(() => {
    pageCacheRef.current.clear();
    pageOrderRef.current = [];
    inflightPagesRef.current.clear();
    setCacheVersion((v) => v + 1);
    setSessionError(null);
  }, []);

  const scrollToTop = useCallback(() => {
    setScrollTop(0);
    const node = listContainerRef.current;
    if (node) {
      node.scrollTo({ top: 0, behavior: "auto" });
    }
  }, []);

  const closeSessionSafe = useCallback(
    async (id?: string | null) => {
      const target = id ?? sessionId;
      if (!target || !closeSessionFnRef.current) return;
      try {
        await closeSessionFnRef.current(target);
      } catch (error) {
        console.warn("关闭搜索会话失败", error);
      }
    },
    [sessionId]
  );

  const shouldIgnoreCancelError = useCallback((error: unknown, currentQuery: string): boolean => {
    const errorStr = typeof error === "string" ? error : String(error);
    return errorStr.includes("搜索已取消") && currentSearchQueryRef.current !== currentQuery;
  }, []);

  const applySoftLimitHint = useCallback(
    (count: number) => {
      const maxDisplayable = Math.min(maxResults || ABS_MAX_RESULTS, ABS_MAX_RESULTS);
      if (count > maxDisplayable) {
        setSoftLimitWarning(
          `出于性能考虑，仅展示前 ${maxDisplayable.toLocaleString()} 条结果，请通过关键词或过滤器缩小范围。`
        );
      } else {
        setSoftLimitWarning(null);
      }
    },
    [maxResults]
  );

  const rememberQuery = useCallback((value: string) => {
    setRecentQueries((prev) => {
      const next = pushRecentQuery(prev, value, MAX_RECENT_QUERIES);
      try {
        localStorage.setItem(RECENT_QUERIES_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const startSearchSession = useCallback(
    async (searchQuery: string) => {
      const composed = composeEverythingQuery(searchQuery, {
        pathScope,
        caseSensitive,
        matchWholeWord,
      });
      const extFilter =
        activeFilter && activeFilter.extensions.length > 0 ? activeFilter.extensions : undefined;
      const maxResultsToUse = Math.min(maxResults, ABS_MAX_RESULTS);
      const currentParams = {
        query: composed,
        extensions: extFilter,
        maxResults: maxResultsToUse,
        sortKey,
        sortOrder,
        matchFolderNameOnly,
        itemKind,
        pathScope,
        caseSensitive,
        matchWholeWord,
      };

      if (!composed) {
        const oldSessionId = pendingSessionIdRef.current;
        if (oldSessionId) {
          await closeSessionSafe(oldSessionId);
        }
        pendingSessionIdRef.current = null;
        activeSessionParamsRef.current = null;
        resetCaches();
        setSessionId(null);
        setSessionMode(false);
        setTotalCount(null);
        setIsSearching(false);
        setCurrentLoadedCount(0);
        return;
      }
      if (!isEverythingAvailable) {
        const oldSessionId = pendingSessionIdRef.current;
        if (oldSessionId) {
          await closeSessionSafe(oldSessionId);
        }
        pendingSessionIdRef.current = null;
        activeSessionParamsRef.current = null;
        setSessionMode(false);
        setSessionId(null);
        setTotalCount(null);
        setIsSearching(false);
        return;
      }

      currentSearchQueryRef.current = composed;

      if (creatingSessionQueryRef.current === composed) {
        return;
      }

      if (
        pendingSessionIdRef.current &&
        sessionMode &&
        activeSessionParamsRef.current &&
        activeSessionParamsRef.current.query === currentParams.query &&
        JSON.stringify(activeSessionParamsRef.current.extensions || []) ===
          JSON.stringify(currentParams.extensions || []) &&
        activeSessionParamsRef.current.maxResults === currentParams.maxResults &&
        activeSessionParamsRef.current.sortKey === currentParams.sortKey &&
        activeSessionParamsRef.current.sortOrder === currentParams.sortOrder &&
        activeSessionParamsRef.current.matchFolderNameOnly === currentParams.matchFolderNameOnly &&
        activeSessionParamsRef.current.itemKind === currentParams.itemKind &&
        activeSessionParamsRef.current.pathScope === currentParams.pathScope &&
        activeSessionParamsRef.current.caseSensitive === currentParams.caseSensitive &&
        activeSessionParamsRef.current.matchWholeWord === currentParams.matchWholeWord
      ) {
        return;
      }

      creatingSessionQueryRef.current = composed;

      const oldSessionId = pendingSessionIdRef.current;
      if (oldSessionId) {
        await closeSessionSafe(oldSessionId);
      }
      pendingSessionIdRef.current = null;
      activeSessionParamsRef.current = null;
      resetCaches();
      scrollToTop();
      setSelectedIndex(0);
      setCurrentLoadedCount(0);
      setIsSearching(true);
      setSessionMode(true);
      setSessionError(null);

      try {
        const sessionTimeoutMs = 60000;
        const sessionTimeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`创建搜索会话超时（${sessionTimeoutMs}ms）`));
          }, sessionTimeoutMs);
        });

        const session = await Promise.race([
          startSessionFn(composed, {
            extensions: extFilter,
            maxResults: maxResultsToUse,
            sortKey,
            sortOrder,
            matchFolderNameOnly,
            onlyFiles: itemKind === "file",
            onlyFolders: itemKind === "folder" || matchFolderNameOnly,
          }),
          sessionTimeoutPromise,
        ]);

        if (currentSearchQueryRef.current !== composed) {
          await closeSessionSafe(session.sessionId);
          pendingSessionIdRef.current = null;
          activeSessionParamsRef.current = null;
          creatingSessionQueryRef.current = null;
          setIsSearching(false);
          return;
        }

        pendingSessionIdRef.current = session.sessionId;
        creatingSessionQueryRef.current = null;
        activeSessionParamsRef.current = currentParams;
        setSessionId(session.sessionId);
        setTotalCount(Math.min(session.totalCount ?? 0, SAFE_DISPLAY_LIMIT));
        applySoftLimitHint(session.totalCount ?? 0);
        if (searchQuery.trim()) {
          rememberQuery(searchQuery.trim());
        }

        const pageIndex = 0;
        const offset = pageIndex * PAGE_SIZE;
        const currentSessionId = session.sessionId;
        const currentQueryForPage = composed;
        inflightPagesRef.current.add(pageIndex);

        const timeoutMs = 30000;
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`获取首屏页超时（${timeoutMs}ms）`));
          }, timeoutMs);
        });

        Promise.race([
          getRangeFn(currentSessionId, offset, PAGE_SIZE, {
            extensions: extFilter,
            sortKey,
            sortOrder,
            matchFolderNameOnly,
          }),
          timeoutPromise,
        ])
          .then((res) => {
            const isSessionStillValid = pendingSessionIdRef.current === currentSessionId;
            const isQueryStillValid = currentSearchQueryRef.current === currentQueryForPage;
            if (!isSessionStillValid || !isQueryStillValid) {
              if (!pendingSessionIdRef.current) {
                setIsSearching(false);
              }
              return;
            }
            pageCacheRef.current.set(pageIndex, res.items);
            pageOrderRef.current = [pageIndex];
            setCacheVersion((v) => v + 1);
            setCurrentLoadedCount((prev) => (prev > 0 ? prev : res.items.length));
            setIsSearching(false);
          })
          .catch((error) => {
            const isSessionStillValid = pendingSessionIdRef.current === currentSessionId;
            const isQueryStillValid = currentSearchQueryRef.current === currentQueryForPage;
            if (!isSessionStillValid || !isQueryStillValid) {
              if (!pendingSessionIdRef.current) {
                setIsSearching(false);
              }
              return;
            }
            console.error("加载首屏页失败:", error);
            if (shouldIgnoreCancelError(error, currentQueryForPage)) {
              setIsSearching(false);
              return;
            }
            const errorStr = typeof error === "string" ? error : String(error);
            setSessionError(errorStr);
            setIsSearching(false);
          })
          .finally(() => {
            inflightPagesRef.current.delete(pageIndex);
          });
      } catch (error) {
        console.error("开启会话失败:", error);
        creatingSessionQueryRef.current = null;
        if (shouldIgnoreCancelError(error, composed)) {
          if (!pendingSessionIdRef.current) {
            setIsSearching(false);
          }
          return;
        }
        const errorStr = typeof error === "string" ? error : String(error);
        setSessionError(errorStr);
        pendingSessionIdRef.current = null;
        activeSessionParamsRef.current = null;
        setSessionMode(false);
        setIsSearching(false);
      }
    },
    [
      activeFilter,
      applySoftLimitHint,
      caseSensitive,
      closeSessionSafe,
      getRangeFn,
      isEverythingAvailable,
      itemKind,
      matchFolderNameOnly,
      matchWholeWord,
      maxResults,
      pathScope,
      rememberQuery,
      resetCaches,
      shouldIgnoreCancelError,
      sortKey,
      sortOrder,
      startSessionFn,
    ]
  );

  const pruneLRU = useCallback(() => {
    const order = pageOrderRef.current;
    while (order.length > MAX_CACHED_PAGES) {
      const removed = order.shift();
      if (removed !== undefined) {
        pageCacheRef.current.delete(removed);
      }
    }
  }, []);

  const touchPageOrder = useCallback((pageIndex: number) => {
    const order = pageOrderRef.current.filter((p) => p !== pageIndex);
    order.push(pageIndex);
    pageOrderRef.current = order;
  }, []);

  const fetchPage = useCallback(
    async (pageIndex: number) => {
      if (!sessionMode) return;
      if (!sessionId || !getRangeFn) return;

      const currentSessionId = pendingSessionIdRef.current;
      if (!currentSessionId || currentSessionId !== sessionId) {
        return;
      }

      if (pageCacheRef.current.has(pageIndex)) {
        touchPageOrder(pageIndex);
        return;
      }
      if (inflightPagesRef.current.has(pageIndex)) return;
      inflightPagesRef.current.add(pageIndex);
      const extFilter =
        activeFilter && activeFilter.extensions.length > 0 ? activeFilter.extensions : undefined;
      const currentQuery = currentSearchQueryRef.current;
      try {
        const offset = pageIndex * PAGE_SIZE;
        const res = await getRangeFn(currentSessionId, offset, PAGE_SIZE, {
          extensions: extFilter,
          sortKey,
          sortOrder,
          matchFolderNameOnly,
        });

        if (pendingSessionIdRef.current !== currentSessionId) {
          return;
        }

        pageCacheRef.current.set(pageIndex, res.items);
        touchPageOrder(pageIndex);
        pruneLRU();
        setCacheVersion((v) => v + 1);
      } catch (error) {
        if (pendingSessionIdRef.current !== currentSessionId) {
          return;
        }
        console.error("加载分页失败:", error);
        if (shouldIgnoreCancelError(error, currentQuery)) {
          return;
        }
        const errorStr = typeof error === "string" ? error : String(error);
        if (pendingSessionIdRef.current === currentSessionId) {
          setSessionError(errorStr);
        }
      } finally {
        inflightPagesRef.current.delete(pageIndex);
      }
    },
    [
      activeFilter,
      getRangeFn,
      matchFolderNameOnly,
      pruneLRU,
      sessionId,
      sessionMode,
      sortKey,
      sortOrder,
      touchPageOrder,
      shouldIgnoreCancelError,
    ]
  );

  const getItemByIndex = useCallback(
    (index: number): EverythingResult | null => {
      if (index < 0) return null;
      const pageIndex = Math.floor(index / PAGE_SIZE);
      const indexInPage = index % PAGE_SIZE;
      const page = pageCacheRef.current.get(pageIndex);
      if (page && page[indexInPage]) {
        touchPageOrder(pageIndex);
        return page[indexInPage];
      }
      fetchPage(pageIndex);
      return null;
    },
    [fetchPage, touchPageOrder]
  );

  startSearchSessionRef.current = startSearchSession;

  useEffect(() => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }
    debounceTimeoutRef.current = window.setTimeout(() => {
      startSearchSessionRef.current?.(query.trim());
    }, query.trim() ? 320 : 160) as unknown as number;
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [query]);

  const prevParamsRef = useRef<{
    activeFilterId: string;
    sortKey: SortKey;
    sortOrder: SortOrder;
    matchFolderNameOnly: boolean;
    maxResults: number;
    itemKind: ItemKindFilter;
    pathScope: string;
    caseSensitive: boolean;
    matchWholeWord: boolean;
    query: string;
  } | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    const currentParams = {
      activeFilterId,
      sortKey,
      sortOrder,
      matchFolderNameOnly,
      maxResults,
      itemKind,
      pathScope,
      caseSensitive,
      matchWholeWord,
      query: trimmed,
    };

    if (prevParamsRef.current === null) {
      prevParamsRef.current = currentParams;
      return;
    }

    if (prevParamsRef.current.query !== trimmed) {
      prevParamsRef.current = currentParams;
      return;
    }

    const paramsChanged =
      prevParamsRef.current.activeFilterId !== currentParams.activeFilterId ||
      prevParamsRef.current.sortKey !== currentParams.sortKey ||
      prevParamsRef.current.sortOrder !== currentParams.sortOrder ||
      prevParamsRef.current.matchFolderNameOnly !== currentParams.matchFolderNameOnly ||
      prevParamsRef.current.maxResults !== currentParams.maxResults ||
      prevParamsRef.current.itemKind !== currentParams.itemKind ||
      prevParamsRef.current.pathScope !== currentParams.pathScope ||
      prevParamsRef.current.caseSensitive !== currentParams.caseSensitive ||
      prevParamsRef.current.matchWholeWord !== currentParams.matchWholeWord;

    if (!paramsChanged) {
      return;
    }

    prevParamsRef.current = currentParams;
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }
    debounceTimeoutRef.current = window.setTimeout(() => {
      startSearchSessionRef.current?.(trimmed);
    }, 150) as unknown as number;
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [
    activeFilterId,
    sortKey,
    sortOrder,
    matchFolderNameOnly,
    maxResults,
    itemKind,
    pathScope,
    caseSensitive,
    matchWholeWord,
    query,
  ]);

  useEffect(() => {
    const target = getItemByIndex(selectedIndex);
    if (!target) {
      setPreviewData(null);
      setIsPreviewLoading(false);
      setSelectedIcon(null);
      return;
    }
    const requestId = ++previewRequestIdRef.current;
    setIsPreviewLoading(true);
    setPreviewData(null);
    setSelectedIcon(null);
    tauriApi
      .getFilePreview(target.path)
      .then((res) => {
        if (previewRequestIdRef.current !== requestId) return;
        setPreviewData(res);
      })
      .catch((error) => {
        if (previewRequestIdRef.current !== requestId) return;
        setPreviewData({
          kind: "error",
          error: typeof error === "string" ? error : String(error),
        });
      })
      .finally(() => {
        if (previewRequestIdRef.current === requestId) {
          setIsPreviewLoading(false);
        }
      });
    tauriApi
      .extractIconFromPath(target.path)
      .then((icon) => {
        if (previewRequestIdRef.current !== requestId) return;
        setSelectedIcon(icon);
      })
      .catch(() => {
        if (previewRequestIdRef.current === requestId) {
          setSelectedIcon(null);
        }
      });
  }, [getItemByIndex, selectedIndex, cacheVersion]);

  const handleChangeSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      const option = SORT_OPTIONS.find((item) => item.key === key);
      setSortKey(key);
      setSortOrder(option?.defaultOrder ?? "desc");
    }
  };

  const handleSelectFilter = (id: string) => {
    setActiveFilterId(id);
    const customFilter = customFilters.find((f) => f.id === id);
    if (customFilter) {
      setNewFilterName(customFilter.label);
      setNewFilterExts(customFilter.extensions.join(", "));
      setShowAdvanced(true);
    } else {
      setNewFilterName("");
      setNewFilterExts("");
    }
  };

  const handleAddCustomFilter = async () => {
    const name = newFilterName.trim();
    const extList = newFilterExts
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (!name || extList.length === 0) return;

    let newFilters: CustomFilter[];
    let filterId: string;

    const existingFilter = customFilters.find((f) => f.id === activeFilterId);
    if (existingFilter) {
      filterId = existingFilter.id;
      newFilters = customFilters.map((f) =>
        f.id === filterId ? { id: filterId, label: name, extensions: extList } : f
      );
    } else {
      filterId = `custom-${Date.now()}`;
      const filter: CustomFilter = { id: filterId, label: name, extensions: extList };
      newFilters = [...customFilters, filter];
    }

    filtersReadyRef.current = true;
    setCustomFilters(newFilters);
    setActiveFilterId(filterId);
    setNewFilterName("");
    setNewFilterExts("");

    try {
      await tauriApi.saveEverythingCustomFilters(newFilters);
      localStorage.removeItem(CUSTOM_FILTER_PREFERENCE_KEY);
      showToast(existingFilter ? "已更新过滤器" : "已保存过滤器");
    } catch (error) {
      console.error("保存自定义过滤器到数据库失败:", error);
    }
  };

  const handleRemoveCustomFilter = async (id: string) => {
    const newFilters = customFilters.filter((f) => f.id !== id);
    setCustomFilters(newFilters);
    if (activeFilterId === id) {
      setActiveFilterId("all");
      setNewFilterName("");
      setNewFilterExts("");
    }

    try {
      await tauriApi.saveEverythingCustomFilters(newFilters);
      localStorage.removeItem(CUSTOM_FILTER_PREFERENCE_KEY);
      showToast("已删除过滤器");
    } catch (error) {
      console.error("保存自定义过滤器到数据库失败:", error);
    }
  };

  const handleLaunch = useCallback(async (result: EverythingResult) => {
    try {
      await tauriApi.addFileToHistory(result.path);
      await tauriApi.launchFile(result.path);
    } catch (error) {
      console.error("Failed to launch file:", error);
    }
  }, []);

  const handleClose = useWindowClose();

  const handleRevealInFolder = useCallback(async (result: EverythingResult) => {
    try {
      await tauriApi.revealInFolder(result.path);
    } catch (error) {
      console.error("Failed to reveal in folder:", error);
    }
  }, []);

  const handleCopyText = useCallback(
    async (text: string, successMessage: string) => {
      try {
        await navigator.clipboard.writeText(text);
        showToast(successMessage);
      } catch (error) {
        console.error("复制失败:", error);
        showToast("复制失败");
      }
    },
    [showToast]
  );

  const handleCopyToDownloads = useCallback(
    async (result: EverythingResult) => {
      try {
        const dest = await tauriApi.copyFileToDownloads(result.path);
        showToast(`已复制到下载目录`);
        return dest;
      } catch (error) {
        console.error("复制到下载失败:", error);
        showToast("复制到下载失败");
      }
    },
    [showToast]
  );

  const handlePickPathScope = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择搜索目录",
      });
      if (selected && typeof selected === "string") {
        setPathScope(selected);
        setShowAdvanced(true);
      }
    } catch (error) {
      console.error("选择目录失败:", error);
    }
  }, []);

  useEffect(() => {
    const node = listContainerRef.current;
    if (!node) return;
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry && entry.contentRect) {
        setViewportHeight(entry.contentRect.height);
      }
    });
    resizeObserver.observe(node);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;

    const setupBatchListener = async () => {
      try {
        const unlisten = await listen<{
          results: EverythingResult[];
          total_count: number;
          current_count: number;
        }>("everything-search-batch", (event) => {
          const { current_count } = event.payload;
          const hasActiveSession = pendingSessionIdRef.current !== null;
          const hasActiveQuery = currentSearchQueryRef.current !== "";
          const isCreatingSession = creatingSessionQueryRef.current !== null;

          if (sessionMode && (hasActiveSession || isCreatingSession) && hasActiveQuery) {
            setCurrentLoadedCount(current_count);
          }
        });

        unlistenFn = unlisten;
      } catch (error) {
        console.error("设置批次事件监听失败:", error);
      }
    };

    setupBatchListener();

    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, [sessionMode]);

  useEffect(() => {
    return () => {
      const oldSessionId = pendingSessionIdRef.current;
      if (oldSessionId && closeSessionFnRef.current) {
        closeSessionFnRef.current(oldSessionId).catch((error) => {
          console.warn("组件卸载时关闭搜索会话失败", error);
        });
      }
      pendingSessionIdRef.current = null;
      activeSessionParamsRef.current = null;
    };
  }, []);

  const displayCount = useMemo(() => {
    if (!totalCount) return 0;
    const maxDisplayable = Math.min(maxResults || ABS_MAX_RESULTS, SAFE_DISPLAY_LIMIT);
    return Math.min(totalCount, maxDisplayable);
  }, [maxResults, totalCount]);

  const visibleRange = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
    const visibleRows = Math.ceil(viewportHeight / ITEM_HEIGHT) + OVERSCAN * 2;
    const end = Math.min(displayCount - 1, start + visibleRows);
    return { start, end };
  }, [displayCount, scrollTop, viewportHeight]);

  const visibleItems = useMemo(() => {
    const items: { index: number; item: EverythingResult | null }[] = [];
    if (displayCount === 0) return items;
    for (let i = visibleRange.start; i <= visibleRange.end; i += 1) {
      items.push({ index: i, item: getItemByIndex(i) });
    }
    return items;
  }, [displayCount, getItemByIndex, visibleRange.end, visibleRange.start, cacheVersion]);

  const paddingTop = visibleRange.start * ITEM_HEIGHT;
  const paddingBottom = Math.max(0, (displayCount - visibleRange.end - 1) * ITEM_HEIGHT);

  const currentSelectedItem = getItemByIndex(selectedIndex);
  const computedLoadedCount = useMemo(() => {
    let count = 0;
    for (const page of pageCacheRef.current.values()) {
      count += page.length;
    }
    const maxResultsToUse = Math.min(maxResults, ABS_MAX_RESULTS);
    return Math.min(count, maxResultsToUse, SAFE_DISPLAY_LIMIT);
  }, [cacheVersion, maxResults]);

  const loadedCount = Math.max(currentLoadedCount, computedLoadedCount);
  const isIndeterminateProgress = isSearching && computedLoadedCount === 0;

  useEffect(() => {
    const node = listContainerRef.current;
    if (!node || displayCount === 0) return;
    const top = selectedIndex * ITEM_HEIGHT;
    const bottom = top + ITEM_HEIGHT;
    if (top < node.scrollTop) {
      node.scrollTo({ top });
    } else if (bottom > node.scrollTop + node.clientHeight) {
      node.scrollTo({ top: bottom - node.clientHeight });
    }
  }, [selectedIndex, displayCount, viewportHeight]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;
      const isSearchInput = target === searchInputRef.current;

      if ((e.ctrlKey || e.metaKey) && (e.key === "l" || e.key === "L" || e.key === "f" || e.key === "F")) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (e.key === "Escape") {
        if (showSyntaxHelp) {
          setShowSyntaxHelp(false);
          return;
        }
        if (showRecent) {
          setShowRecent(false);
          return;
        }
        handleClose();
        return;
      }

      if (!isField || isSearchInput) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIndex((prev) => {
            const limit = displayCount > 0 ? displayCount - 1 : 0;
            return prev < limit ? prev + 1 : prev;
          });
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : 0));
          return;
        }
      }

      const targetItem = getItemByIndex(selectedIndex);
      if (!targetItem) return;

      if (e.key === "Enter" && e.altKey) {
        e.preventDefault();
        handleRevealInFolder(targetItem);
        return;
      }
      if (e.key === "Enter" && (!isField || isSearchInput)) {
        e.preventDefault();
        handleLaunch(targetItem);
        return;
      }
      if (!isField && (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        handleCopyText(targetItem.name, "已复制文件名");
        return;
      }
      if (!isField && (e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        handleCopyText(targetItem.path, "已复制路径");
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    displayCount,
    getItemByIndex,
    handleClose,
    handleCopyText,
    handleLaunch,
    handleRevealInFolder,
    selectedIndex,
    showRecent,
    showSyntaxHelp,
  ]);

  const allFilters = useMemo(
    () => [...QUICK_FILTERS, ...customFilters.map((f) => ({ ...f, isCustom: true as const }))],
    [customFilters]
  );

  const emptyHint = !query.trim() && !pathScope.trim()
    ? "输入关键词开始搜索"
    : isSearching
    ? "正在搜索..."
    : "未找到结果";

  return (
    <div className="relative h-screen w-screen flex flex-col bg-gradient-to-br from-slate-50 via-white to-blue-50/40 text-slate-800">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200/70 bg-white/90 backdrop-blur-sm">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white flex items-center justify-center shadow-md shadow-blue-500/30 shrink-0">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-800 leading-tight">Everything 文件搜索</h2>
            <p className="text-xs text-slate-400 truncate">
              {isEverythingAvailable ? "实时索引 · 支持 * ? path: ext: regex:" : "等待 Everything 服务"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowPreview((prev) => !prev)}
            className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
              showPreview
                ? "bg-blue-50 border-blue-200 text-blue-700"
                : "border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
          >
            {showPreview ? "隐藏预览" : "显示预览"}
          </button>
          <button
            onClick={handleClose}
            className="px-2.5 py-1.5 text-xs text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors"
          >
            关闭
          </button>
        </div>
      </div>

      <div className="px-4 pt-3 pb-2 border-b border-slate-200/70 bg-white/80 space-y-2.5">
        <div className="relative">
          <svg
            className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setShowRecent(true)}
            onBlur={() => window.setTimeout(() => setShowRecent(false), 150)}
            placeholder="搜索文件或文件夹，支持 Everything 语法"
            className="w-full pl-10 pr-24 py-2.5 border border-slate-200 rounded-xl bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-400 text-sm"
            autoFocus
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {query && (
              <button
                onClick={() => {
                  setQuery("");
                  searchInputRef.current?.focus();
                }}
                className="px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 rounded-md"
              >
                清空
              </button>
            )}
            <button
              onMouseDown={(e) => {
                e.preventDefault();
                setShowRecent((prev) => !prev);
              }}
              className="px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 rounded-md"
              title="最近搜索"
            >
              最近
            </button>
          </div>
          {showRecent && recentQueries.length > 0 && (
            <div className="absolute z-20 left-0 right-0 top-[calc(100%+6px)] bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
              {recentQueries.map((item) => (
                <button
                  key={item}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setQuery(item);
                    setShowRecent(false);
                    searchInputRef.current?.focus();
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-blue-50 truncate"
                >
                  {item}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {ITEM_KIND_OPTIONS.map((option) => (
            <button
              key={option.id}
              onClick={() => setItemKind(option.id)}
              className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                itemKind === option.id
                  ? "bg-slate-800 text-white border-slate-800"
                  : "border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
            >
              {option.label}
            </button>
          ))}
          <span className="w-px h-4 bg-slate-200 mx-1" />
          {allFilters.map((filter) => (
            <button
              key={filter.id}
              onClick={() => handleSelectFilter(filter.id)}
              className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                activeFilterId === filter.id
                  ? "bg-blue-50 border-blue-200 text-blue-700"
                  : "border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
              title={filter.extensions.join(", ")}
            >
              {filter.label}
            </button>
          ))}
          <button
            onClick={() => setShowAdvanced((prev) => !prev)}
            className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
              showAdvanced || pathScope || caseSensitive || matchWholeWord
                ? "bg-indigo-50 border-indigo-200 text-indigo-700"
                : "border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
          >
            更多
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {SORT_OPTIONS.map(({ key, label }) => {
              const active = sortKey === key;
              const arrow = active ? (sortOrder === "asc" ? "↑" : "↓") : "";
              return (
                <button
                  key={key}
                  onClick={() => handleChangeSort(key)}
                  className={`px-2.5 py-1 text-xs rounded-lg border ${
                    active
                      ? "bg-blue-50 border-blue-200 text-blue-700"
                      : "border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {label} {arrow}
                </button>
              );
            })}
          </div>
          <div className="text-xs text-slate-500 flex items-center gap-2 min-h-[20px]">
            {isSearching && (
              <span className="flex items-center gap-1.5 text-blue-600">
                <span className="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                {isIndeterminateProgress
                  ? "正在获取首批结果"
                  : totalCount
                  ? `${loadedCount.toLocaleString()} / ${totalCount.toLocaleString()}`
                  : "搜索中"}
              </span>
            )}
            {!isSearching && totalCount !== null && (
              <span>
                {loadedCount.toLocaleString()} / {totalCount.toLocaleString()} 条
                {displayCount < (totalCount || 0) ? ` · 展示 ${displayCount.toLocaleString()}` : ""}
              </span>
            )}
            {sessionError && <span className="text-red-600">会话错误：{sessionError}</span>}
            <button
              onClick={() => setShowSyntaxHelp((prev) => !prev)}
              className="text-blue-600 hover:text-blue-800"
            >
              语法
            </button>
          </div>
        </div>

        {isSearching && (
          <div className="w-full bg-slate-100 h-1 rounded overflow-hidden">
            <div
              className={`h-1 bg-blue-500 rounded transition-all ${isIndeterminateProgress ? "animate-pulse" : ""}`}
              style={{
                width: isIndeterminateProgress
                  ? "35%"
                  : `${Math.min(
                      100,
                      totalCount ? (loadedCount / Math.max(totalCount, 1)) * 100 : 20
                    )}%`,
              }}
            />
          </div>
        )}

        {showAdvanced && (
          <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-500 shrink-0">限定目录</span>
              <input
                value={pathScope}
                onChange={(e) => setPathScope(e.target.value)}
                placeholder="例如 D:\project"
                className="flex-1 min-w-[220px] px-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white"
              />
              <button
                onClick={handlePickPathScope}
                className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg hover:bg-white"
              >
                浏览
              </button>
              {pathScope && (
                <button
                  onClick={() => setPathScope("")}
                  className="px-2.5 py-1.5 text-xs text-slate-500 hover:bg-white rounded-lg"
                >
                  清除
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={caseSensitive}
                  onChange={(e) => setCaseSensitive(e.target.checked)}
                />
                区分大小写
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={matchWholeWord}
                  onChange={(e) => setMatchWholeWord(e.target.checked)}
                />
                全词匹配
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={matchFolderNameOnly}
                  onChange={(e) => setMatchFolderNameOnly(e.target.checked)}
                />
                仅文件夹名
              </label>
              <label className="flex items-center gap-1.5">
                上限
                <input
                  type="number"
                  min="1"
                  value={maxResults}
                  onChange={(e) => {
                    const value = parseInt(e.target.value, 10);
                    if (!isNaN(value) && value > 0) {
                      setMaxResults(value);
                    }
                  }}
                  className="w-24 px-2 py-1 border border-slate-200 rounded-lg bg-white"
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <input
                value={newFilterName}
                onChange={(e) => setNewFilterName(e.target.value)}
                placeholder="自定义过滤名称"
                className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white"
              />
              <input
                value={newFilterExts}
                onChange={(e) => setNewFilterExts(e.target.value)}
                placeholder="扩展名，逗号分隔，例如 pdf,docx"
                className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm flex-1 min-w-[200px] bg-white"
              />
              <button
                onClick={handleAddCustomFilter}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                {isEditingExistingFilter ? "更新" : "保存"}
              </button>
              {activeFilter?.isCustom && (
                <button
                  onClick={() => handleRemoveCustomFilter(activeFilter.id)}
                  className="px-3 py-1.5 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50"
                >
                  删除
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {showSyntaxHelp && (
        <div className="px-4 py-3 border-b border-blue-100 bg-blue-50/80 text-sm">
          <div className="font-medium text-blue-900 mb-2">常用语法</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-slate-700">
            <SyntaxTip code="*.jpg" text="通配符，匹配任意字符" />
            <SyntaxTip code="path:D:\docs" text="限制搜索路径" />
            <SyntaxTip code="ext:png;pdf" text="按扩展名过滤" />
            <SyntaxTip code="file: / folder:" text="只搜文件或文件夹" />
            <SyntaxTip code="regex:^test" text="正则表达式" />
            <SyntaxTip code="jpg | png" text="或运算，空格表示与" />
          </div>
        </div>
      )}

      {!isEverythingAvailable && (
        <div className="px-4 py-2.5 bg-amber-50 border-b border-amber-200 text-sm text-amber-800">
          Everything 不可用：{everythingError || "请先启动 Everything 主程序"}
        </div>
      )}

      {softLimitWarning && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-800">
          {softLimitWarning}
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        <div
          className="flex-1 overflow-y-auto relative bg-white/60"
          ref={listContainerRef}
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        >
          {displayCount === 0 && (
            <div className="h-full min-h-[240px] flex flex-col items-center justify-center text-slate-400 px-6 text-center">
              <div className="w-14 h-14 mb-3 rounded-2xl bg-slate-100 flex items-center justify-center">
                <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <div className="text-sm font-medium text-slate-500">{emptyHint}</div>
              <div className="text-xs mt-1">试试 `*.pdf`、`path:D:\` 或点「更多」限定目录</div>
            </div>
          )}
          <div style={{ paddingTop, paddingBottom }}>
            {visibleItems.map(({ index, item }) => {
              const isSelected = index === selectedIndex;
              const kind = item ? classifyFileKind(item.name, item.is_folder) : "file";
              return (
                <div
                  key={item ? `${item.path}-${index}` : `placeholder-${index}`}
                  onClick={() => setSelectedIndex(index)}
                  onDoubleClick={() => item && handleLaunch(item)}
                  className={`group px-3 border-b border-slate-100 cursor-pointer ${
                    isSelected ? "bg-blue-50" : "bg-transparent hover:bg-slate-50"
                  }`}
                  style={{ height: ITEM_HEIGHT }}
                >
                  {!item && (
                    <div className="h-full flex items-center text-sm text-slate-400">加载中... #{index + 1}</div>
                  )}
                  {item && (
                    <div className="h-full flex items-center gap-3">
                      <FileKindBadge kind={kind} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="font-medium text-slate-900 truncate text-sm">
                            {highlightSegments(item.name, query).map((segment, i) => (
                              <span
                                key={`${segment.text}-${i}`}
                                className={segment.match ? "text-blue-700 bg-blue-100 rounded-sm px-0.5" : undefined}
                              >
                                {segment.text}
                              </span>
                            ))}
                          </div>
                          <span className="text-[10px] text-slate-400 shrink-0">
                            {getFileKindLabel(kind)}
                          </span>
                        </div>
                        <div className="text-xs text-slate-500 truncate mt-0.5" title={item.path}>
                          {item.path}
                        </div>
                      </div>
                      <div className="hidden sm:flex flex-col items-end text-[11px] text-slate-400 shrink-0 w-28">
                        <span>{typeof item.size === "number" ? formatFileSize(item.size) : kind === "folder" ? "文件夹" : "—"}</span>
                        <span>{formatStandardDateTime(item.date_modified, parseDate)}</span>
                      </div>
                      <div className={`flex items-center gap-1 shrink-0 ${isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
                        <IconActionButton label="打开" onClick={() => handleLaunch(item)}>
                          打开
                        </IconActionButton>
                        <IconActionButton label="打开所在文件夹" onClick={() => handleRevealInFolder(item)}>
                          位置
                        </IconActionButton>
                        <IconActionButton label="复制路径" onClick={() => handleCopyText(item.path, "已复制路径")}>
                          复制
                        </IconActionButton>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {showPreview && (
          <div className="w-[360px] border-l border-slate-200 bg-white p-4 overflow-y-auto shrink-0">
            <div className="text-sm font-semibold text-slate-800 mb-3">预览</div>
            {!currentSelectedItem && <div className="text-sm text-slate-500">选择结果查看预览</div>}
            {currentSelectedItem && (
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  {selectedIcon ? (
                    <img
                      src={selectedIcon.startsWith("data:image") ? selectedIcon : `data:image/png;base64,${selectedIcon}`}
                      alt=""
                      className="w-10 h-10 object-contain rounded-lg bg-slate-50 border border-slate-100"
                    />
                  ) : (
                    <FileKindBadge kind={classifyFileKind(currentSelectedItem.name, currentSelectedItem.is_folder)} large />
                  )}
                  <div className="min-w-0">
                    <div className="text-sm text-slate-900 font-medium break-all">
                      {currentSelectedItem.name}
                    </div>
                    <button
                      className="text-xs text-slate-500 hover:text-blue-600 break-all text-left"
                      onClick={() => handleCopyText(currentSelectedItem.path, "已复制路径")}
                      title="点击复制路径"
                    >
                      {currentSelectedItem.path}
                    </button>
                  </div>
                </div>
                <div className="text-xs text-slate-500 flex flex-wrap gap-2">
                  <span className="px-2 py-0.5 rounded bg-slate-100">
                    {getFileKindLabel(classifyFileKind(currentSelectedItem.name, currentSelectedItem.is_folder))}
                  </span>
                  {typeof currentSelectedItem.size === "number" && (
                    <span className="px-2 py-0.5 rounded bg-slate-100">
                      {formatFileSize(currentSelectedItem.size)}
                    </span>
                  )}
                  <span className="px-2 py-0.5 rounded bg-slate-100">
                    {formatStandardDateTime(currentSelectedItem.date_modified, parseDate)}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    onClick={() => handleLaunch(currentSelectedItem)}
                    className="px-2.5 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                  >
                    打开
                  </button>
                  <button
                    onClick={() => handleRevealInFolder(currentSelectedItem)}
                    className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg hover:bg-slate-50"
                  >
                    打开位置
                  </button>
                  <button
                    onClick={() => handleCopyText(currentSelectedItem.path, "已复制路径")}
                    className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg hover:bg-slate-50"
                  >
                    复制路径
                  </button>
                  <button
                    onClick={() => handleCopyText(currentSelectedItem.name, "已复制文件名")}
                    className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg hover:bg-slate-50"
                  >
                    复制名称
                  </button>
                  {!currentSelectedItem.is_folder && (
                    <button
                      onClick={() => handleCopyToDownloads(currentSelectedItem)}
                      className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg hover:bg-slate-50"
                    >
                      复制到下载
                    </button>
                  )}
                </div>

                {isPreviewLoading && <div className="text-sm text-slate-500">加载预览...</div>}
                {!isPreviewLoading && previewData?.kind === "text" && (
                  <div className="text-xs text-slate-800 border border-slate-200 rounded-lg p-2 bg-slate-50 max-h-72 overflow-auto whitespace-pre-wrap">
                    {previewData.content || "（空文件）"}
                    {previewData.truncated && <div className="text-[11px] text-slate-400 mt-1">已截断</div>}
                  </div>
                )}
                {!isPreviewLoading && previewData?.kind === "image" && previewData.imageDataUrl && (
                  <div className="border border-slate-200 rounded-lg p-2 bg-slate-50">
                    <img
                      src={previewData.imageDataUrl}
                      alt="预览图"
                      className="max-h-72 w-full object-contain bg-white"
                    />
                  </div>
                )}
                {!isPreviewLoading && previewData?.kind === "media" && (
                  <PreviewPlaceholder text="音视频文件，暂不内嵌播放" />
                )}
                {!isPreviewLoading && previewData?.kind === "folder" && (
                  <PreviewPlaceholder text="文件夹无法直接预览，可打开位置查看内容" />
                )}
                {!isPreviewLoading &&
                  previewData &&
                  (previewData.kind === "binary" || previewData.kind === "unsupported") && (
                    <PreviewPlaceholder text="暂不支持该类型预览" />
                  )}
                {!isPreviewLoading && previewData?.kind === "error" && (
                  <div className="text-sm text-red-600 border border-red-200 rounded-lg p-2 bg-red-50">
                    预览失败：{previewData.error || "未知错误"}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="px-4 py-1.5 border-t border-slate-200/70 bg-white/90 text-[11px] text-slate-400 flex flex-wrap gap-x-4 gap-y-1">
        <span>Enter 打开</span>
        <span>Alt+Enter 打开位置</span>
        <span>Ctrl+C 复制路径</span>
        <span>Ctrl+L 聚焦搜索</span>
        <span>Esc 关闭</span>
      </div>

      {toast && (
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-slate-800 text-white text-xs shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

function SyntaxTip({ code, text }: { code: string; text: string }) {
  return (
    <div>
      <span className="font-mono text-blue-800 bg-blue-100 px-1.5 py-0.5 rounded">{code}</span>
      <span className="ml-2">{text}</span>
    </div>
  );
}

function PreviewPlaceholder({ text }: { text: string }) {
  return (
    <div className="text-sm text-slate-600 border border-slate-200 rounded-lg p-2 bg-slate-50">
      {text}
    </div>
  );
}

function IconActionButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="px-2 py-1 text-[11px] text-slate-600 hover:text-blue-700 hover:bg-white border border-transparent hover:border-slate-200 rounded-md"
    >
      {children}
    </button>
  );
}

const KIND_STYLES: Record<FileKind, string> = {
  folder: "bg-amber-100 text-amber-700",
  image: "bg-sky-100 text-sky-700",
  video: "bg-violet-100 text-violet-700",
  audio: "bg-pink-100 text-pink-700",
  code: "bg-emerald-100 text-emerald-700",
  archive: "bg-orange-100 text-orange-700",
  document: "bg-blue-100 text-blue-700",
  program: "bg-rose-100 text-rose-700",
  file: "bg-slate-100 text-slate-600",
};

function FileKindBadge({ kind, large }: { kind: FileKind; large?: boolean }) {
  const size = large ? "w-10 h-10" : "w-9 h-9";
  return (
    <div className={`${size} rounded-xl flex items-center justify-center shrink-0 ${KIND_STYLES[kind]}`}>
      {kind === "folder" ? (
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path d="M2 6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
        </svg>
      ) : (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M7 3h8l4 4v14a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z" />
        </svg>
      )}
    </div>
  );
}
