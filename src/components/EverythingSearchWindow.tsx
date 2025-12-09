import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { tauriApi } from "../api/tauri";
import type { EverythingResult, FilePreview } from "../types";

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
const MATCH_WHOLE_WORD_PREFERENCE_KEY = "everything_match_whole_word";
const MATCH_FOLDER_NAME_ONLY_PREFERENCE_KEY = "everything_match_folder_name_only";
const DEFAULT_MAX_RESULTS = 5000; // 会作为软性展示上限，后端仍可返回更多供分页
const ABS_MAX_RESULTS = 2000000; // 单次会话展示硬上限，防止无限渲染
const SAFE_DISPLAY_LIMIT = 2000000; // 仅作为防护兜底
const PAGE_SIZE = 500; // 后端分段拉取尺寸
const MAX_CACHED_PAGES = 8; // 前端缓存页数上限（LRU）
const ITEM_HEIGHT = 96; // 预估单行高度，用于简单虚拟化
const OVERSCAN = 6; // 额外渲染的行数，降低滚动抖动

const QUICK_FILTERS: FilterItem[] = [
  { id: "all", label: "全部", extensions: [] },
  {
    id: "images",
    label: "图片",
    extensions: ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico"],
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
      "bat",
      "html",
      "css",
      "scss",
      "less",
      "json",
      "jsonc",
      "md",
      "yml",
      "yaml",
      "toml",
      "ini",
      "sql",
    ],
  },
  {
    id: "archive",
    label: "压缩包",
    extensions: ["zip", "rar", "7z", "tar", "gz", "bz2"],
  },
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
  const [matchWholeWord, setMatchWholeWord] = useState(false);
  const [matchFolderNameOnly, setMatchFolderNameOnly] = useState(false);
  const [maxResults, setMaxResults] = useState<number>(DEFAULT_MAX_RESULTS);
  const [showSyntaxHelp, setShowSyntaxHelp] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionMode, setSessionMode] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [cacheVersion, setCacheVersion] = useState(0); // 仅用于触发渲染
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [softLimitWarning, setSoftLimitWarning] = useState<string | null>(null);
  const [currentLoadedCount, setCurrentLoadedCount] = useState(0); // 后端批次事件返回的当前已加载数量

  const debounceTimeoutRef = useRef<number | null>(null);
  const previewRequestIdRef = useRef(0);
  const inflightPagesRef = useRef<Set<number>>(new Set());
  const pageCacheRef = useRef<Map<number, EverythingResult[]>>(new Map());
  const pageOrderRef = useRef<number[]>([]);
  const pendingSessionIdRef = useRef<string | null>(null);
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const batchAccumRef = useRef<EverythingResult[]>([]);
  const currentSearchQueryRef = useRef<string>("");
  const batchUpdateTimerRef = useRef<number | null>(null);

  const activeFilter = useMemo<FilterItem | undefined>(() => {
    const builtIn = QUICK_FILTERS.find((f) => f.id === activeFilterId);
    if (builtIn) return builtIn;
    const custom = customFilters.find((f) => f.id === activeFilterId);
    if (custom) return { ...custom, isCustom: true };
    return QUICK_FILTERS[0];
  }, [activeFilterId, customFilters]);

  // 判断当前是否在编辑现有过滤器
  const isEditingExistingFilter = useMemo(() => {
    return customFilters.some((f) => f.id === activeFilterId);
  }, [activeFilterId, customFilters]);

  const startSessionFn =
    (tauriApi as any).startEverythingSearchSession as
      | ((
          searchQuery: string,
          opts: {
            extensions?: string[];
            maxResults?: number;
            sortKey?: SortKey;
            sortOrder?: SortOrder;
            matchWholeWord?: boolean;
            matchFolderNameOnly?: boolean;
          }
        ) => Promise<{ sessionId: string; totalCount: number; truncated?: boolean }>)
      | undefined;

  const getRangeFn =
    (tauriApi as any).getEverythingSearchRange as
      | ((
          sessionId: string,
          offset: number,
          limit: number,
          opts: {
            sortKey?: SortKey;
            sortOrder?: SortOrder;
            extensions?: string[];
            matchWholeWord?: boolean;
            matchFolderNameOnly?: boolean;
          }
        ) => Promise<{ offset: number; items: EverythingResult[]; totalCount?: number }>)
      | undefined;

  const closeSessionFn =
    (tauriApi as any).closeEverythingSearchSession as
      | ((sessionId: string) => Promise<void>)
      | undefined;

  // 加载偏好
  useEffect(() => {
    const loadPreferences = async () => {
      try {
        const savedSort = localStorage.getItem(SORT_PREFERENCE_KEY);
        if (savedSort) {
          const parsed = JSON.parse(savedSort) as { key?: SortKey; order?: SortOrder };
          if (parsed.key) setSortKey(parsed.key);
          if (parsed.order) setSortOrder(parsed.order);
        }

        const savedFilterId = localStorage.getItem(FILTER_PREFERENCE_KEY);
        if (savedFilterId) setActiveFilterId(savedFilterId);

        // 从 SQLite 加载自定义过滤器
        try {
          const filters = await tauriApi.getEverythingCustomFilters();
          setCustomFilters(filters || []);
          console.log("已从数据库加载自定义过滤器:", filters);
          
          // 如果数据库为空，尝试从 localStorage 迁移一次（仅迁移，不降级）
          if ((!filters || filters.length === 0)) {
            const savedCustom = localStorage.getItem(CUSTOM_FILTER_PREFERENCE_KEY);
            if (savedCustom) {
              try {
                const parsed = JSON.parse(savedCustom) as CustomFilter[];
                if (Array.isArray(parsed) && parsed.length > 0) {
                  // 迁移到数据库
                  await tauriApi.saveEverythingCustomFilters(parsed);
                  setCustomFilters(parsed);
                  // 清除 localStorage 中的数据
                  localStorage.removeItem(CUSTOM_FILTER_PREFERENCE_KEY);
                  console.log("已从 localStorage 迁移自定义过滤器到数据库:", parsed);
                }
              } catch (error) {
                console.error("迁移自定义过滤器失败:", error);
              }
            }
          }
        } catch (error) {
          console.error("加载自定义过滤器失败:", error);
        }

        const savedMaxResults = localStorage.getItem(MAX_RESULTS_PREFERENCE_KEY);
        if (savedMaxResults) {
          const parsed = parseInt(savedMaxResults, 10);
          if (!isNaN(parsed) && parsed > 0) {
            setMaxResults(parsed);
          }
        }

        const savedMatchWholeWord = localStorage.getItem(MATCH_WHOLE_WORD_PREFERENCE_KEY);
        if (savedMatchWholeWord !== null) {
          setMatchWholeWord(savedMatchWholeWord === "true");
        }

        const savedMatchFolderNameOnly = localStorage.getItem(MATCH_FOLDER_NAME_ONLY_PREFERENCE_KEY);
        if (savedMatchFolderNameOnly !== null) {
          setMatchFolderNameOnly(savedMatchFolderNameOnly === "true");
        }
      } catch (error) {
        console.warn("加载 Everything 偏好失败", error);
      }
    };

    loadPreferences();
  }, []);

  // 持久化偏好
  useEffect(() => {
    try {
      localStorage.setItem(
        SORT_PREFERENCE_KEY,
        JSON.stringify({ key: sortKey, order: sortOrder })
      );
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
    // 自动保存到 SQLite（仅在非初始加载时）
    const saveFilters = async () => {
      try {
        await tauriApi.saveEverythingCustomFilters(customFilters);
        console.log("自定义过滤器已自动保存到数据库:", customFilters);
        // 清除 localStorage 中的旧数据（如果存在）
        localStorage.removeItem(CUSTOM_FILTER_PREFERENCE_KEY);
      } catch (error) {
        console.error("自动保存自定义过滤器到数据库失败:", error);
      }
    };

    // 延迟保存，避免在初始加载时触发
    const timer = setTimeout(() => {
      saveFilters();
    }, 100);

    return () => clearTimeout(timer);
  }, [customFilters]);

  useEffect(() => {
    try {
      localStorage.setItem(MATCH_WHOLE_WORD_PREFERENCE_KEY, matchWholeWord.toString());
    } catch {
      // ignore
    }
  }, [matchWholeWord]);

  useEffect(() => {
    try {
      localStorage.setItem(MATCH_FOLDER_NAME_ONLY_PREFERENCE_KEY, matchFolderNameOnly.toString());
    } catch {
      // ignore
    }
  }, [matchFolderNameOnly]);

  useEffect(() => {
    try {
      localStorage.setItem(MAX_RESULTS_PREFERENCE_KEY, maxResults.toString());
    } catch {
      // ignore
    }
  }, [maxResults]);

  // 检查 Everything 状态
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

  // ---------- 会话 & 分页 ----------
  const resetCaches = useCallback(() => {
    // 清除批次更新定时器
    if (batchUpdateTimerRef.current) {
      clearTimeout(batchUpdateTimerRef.current);
      batchUpdateTimerRef.current = null;
    }
    pageCacheRef.current.clear();
    pageOrderRef.current = [];
    inflightPagesRef.current.clear();
    batchAccumRef.current = [];
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
      if (!target || !closeSessionFn) return;
      try {
        await closeSessionFn(target);
      } catch (error) {
        console.warn("关闭搜索会话失败", error);
      }
    },
    [sessionId, closeSessionFn]
  );

  // 判断是否应该忽略"搜索已取消"错误
  // 如果错误是"搜索已取消"，且当前查询已经改变，说明是用户主动切换查询导致的，应该静默忽略
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

  const startSearchSession = useCallback(
    async (searchQuery: string) => {
      if (!searchQuery || searchQuery.trim() === "") {
        await closeSessionSafe();
        resetCaches();
        setSessionId(null);
        setSessionMode(false);
        setTotalCount(null);
        setIsSearching(false);
        return;
      }
      if (!isEverythingAvailable) {
        setSessionMode(false);
        setSessionId(null);
        setTotalCount(null);
        setIsSearching(false);
        return;
      }

      const trimmed = searchQuery.trim();
      const extFilter =
        activeFilter && activeFilter.extensions.length > 0 ? activeFilter.extensions : undefined;
      const maxResultsToUse = Math.min(maxResults, ABS_MAX_RESULTS);

      // 保存当前搜索的 query，用于错误处理时判断是否应该忽略取消错误
      currentSearchQueryRef.current = trimmed;

      // 关闭旧会话
      await closeSessionSafe();
      resetCaches();
      scrollToTop();
      setCurrentLoadedCount(0); // 重置已加载数量
      setIsSearching(true);
      setSessionMode(!!(startSessionFn && getRangeFn));
      setSessionError(null);

      // 若后端尚未升级，回退老的批次接口
      if (!startSessionFn || !getRangeFn) {
        try {
          // 清空批次累积，等待事件逐步填充
          batchAccumRef.current = [];

          const response = await tauriApi.searchEverything(trimmed, {
            extensions: extFilter,
            maxResults: maxResultsToUse,
            matchWholeWord,
            matchFolderNameOnly,
          });
          const limited = response.results.slice(0, Math.min(maxResultsToUse, SAFE_DISPLAY_LIMIT));
          // 限制 totalCount 为用户设置的 maxResults，而不是 Everything 的真实总数
          const fallbackTotal = Math.min(
            response.total_count ?? limited.length,
            maxResultsToUse,
            limited.length,
            SAFE_DISPLAY_LIMIT
          );

          // 最终结果回填一次，确保列表完整（使用 requestIdleCallback 避免阻塞 UI）
          const updateCache = () => {
            // 分批处理，避免一次性处理太多数据阻塞 UI
            const processBatch = (startPage: number, endPage: number) => {
              for (let pageIndex = startPage; pageIndex < endPage; pageIndex += 1) {
                const start = pageIndex * PAGE_SIZE;
                const end = Math.min(start + PAGE_SIZE, limited.length);
                if (start < limited.length) {
                  const slice = limited.slice(start, end);
                  pageCacheRef.current.set(pageIndex, slice);
                  pageOrderRef.current.push(pageIndex);
                }
              }
            };

            pageCacheRef.current.clear();
            pageOrderRef.current = [];
            const pageCount = Math.ceil(limited.length / PAGE_SIZE);
            const BATCH_SIZE = 50; // 每批处理 50 页

            // 分批处理，每批之间让出控制权
            let currentPage = 0;
            const processNextBatch = () => {
              const endPage = Math.min(currentPage + BATCH_SIZE, pageCount);
              processBatch(currentPage, endPage);
              currentPage = endPage;

              if (currentPage < pageCount) {
                // 使用 setTimeout(0) 让出控制权，继续处理下一批
                setTimeout(processNextBatch, 0);
              } else {
                // 全部处理完成，更新版本
                setCacheVersion((v) => v + 1);
              }
            };

            processNextBatch();
          };

          if ('requestIdleCallback' in window) {
            requestIdleCallback(updateCache, { timeout: 200 });
          } else {
            setTimeout(updateCache, 0);
          }

          setTotalCount(fallbackTotal);
          setCurrentLoadedCount(limited.length); // 设置最终已加载数量
          setSessionMode(false);
          applySoftLimitHint(fallbackTotal);
        } catch (error) {
          console.error("legacy 搜索失败:", error);
          if (shouldIgnoreCancelError(error, trimmed)) {
            console.log("搜索被取消（用户切换查询），忽略错误");
            return;
          }
          const errorStr = typeof error === "string" ? error : String(error);
          setSessionError(errorStr);
        } finally {
          setIsSearching(false);
        }
        return;
      }

      try {
        const session = await startSessionFn(trimmed, {
          extensions: extFilter,
          maxResults: maxResultsToUse,
          sortKey,
          sortOrder,
          matchWholeWord,
          matchFolderNameOnly,
        });
        pendingSessionIdRef.current = session.sessionId;
        setSessionId(session.sessionId);
        setTotalCount(Math.min(session.totalCount ?? 0, SAFE_DISPLAY_LIMIT));
        applySoftLimitHint(session.totalCount ?? 0);
        // 预取首屏页
        const pageIndex = 0;
        const offset = pageIndex * PAGE_SIZE;
        inflightPagesRef.current.add(pageIndex);
        getRangeFn(session.sessionId, offset, PAGE_SIZE, {
          extensions: extFilter,
          sortKey,
          sortOrder,
          matchWholeWord,
          matchFolderNameOnly,
        })
          .then((res) => {
            if (pendingSessionIdRef.current !== session.sessionId) return;
            pageCacheRef.current.set(pageIndex, res.items);
            pageOrderRef.current = [pageIndex];
            setCacheVersion((v) => v + 1);
          })
          .catch((error) => {
            if (pendingSessionIdRef.current !== session.sessionId) return;
            console.error("加载首屏页失败:", error);
            if (shouldIgnoreCancelError(error, trimmed)) {
              console.log("搜索被取消（用户切换查询），忽略错误");
              return;
            }
            const errorStr = typeof error === "string" ? error : String(error);
            setSessionError(errorStr);
          })
          .finally(() => {
            inflightPagesRef.current.delete(pageIndex);
            if (pendingSessionIdRef.current === session.sessionId) {
              setIsSearching(false);
            }
          });
      } catch (error) {
        console.error("开启会话失败:", error);
        if (shouldIgnoreCancelError(error, trimmed)) {
          console.log("搜索被取消（用户切换查询），忽略错误");
          return;
        }
        const errorStr = typeof error === "string" ? error : String(error);
        setSessionError(errorStr);
        setSessionMode(false);
        setIsSearching(false);
      }
    },
    [
      activeFilter,
      applySoftLimitHint,
      closeSessionSafe,
      getRangeFn,
      isEverythingAvailable,
      matchFolderNameOnly,
      matchWholeWord,
      maxResults,
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
      if (pageCacheRef.current.has(pageIndex)) {
        touchPageOrder(pageIndex);
        return;
      }
      if (inflightPagesRef.current.has(pageIndex)) return;
      inflightPagesRef.current.add(pageIndex);
      const extFilter =
        activeFilter && activeFilter.extensions.length > 0 ? activeFilter.extensions : undefined;
      // 使用 ref 获取当前查询，避免闭包问题
      const currentQuery = currentSearchQueryRef.current;
      try {
        const offset = pageIndex * PAGE_SIZE;
        const res = await getRangeFn(sessionId, offset, PAGE_SIZE, {
          extensions: extFilter,
          sortKey,
          sortOrder,
          matchWholeWord,
          matchFolderNameOnly,
        });
        pageCacheRef.current.set(pageIndex, res.items);
        touchPageOrder(pageIndex);
        pruneLRU();
        setCacheVersion((v) => v + 1);
        if (typeof res.totalCount === "number") {
          setTotalCount(Math.min(res.totalCount, SAFE_DISPLAY_LIMIT));
        } else if (res.items.length === 0) {
          // 后端可能截断或无更多结果，收敛总数避免无限"加载中"
          const inferredTotal = Math.max(0, pageIndex * PAGE_SIZE);
          setTotalCount((prev) => {
            if (prev === null) return inferredTotal;
            return Math.min(prev, inferredTotal);
          });
        }
      } catch (error) {
        console.error("加载分页失败:", error);
        if (shouldIgnoreCancelError(error, currentQuery)) {
          console.log("搜索被取消（用户切换查询），忽略分页错误");
          return;
        }
        const errorStr = typeof error === "string" ? error : String(error);
        setSessionError(errorStr);
      } finally {
        inflightPagesRef.current.delete(pageIndex);
      }
    },
    [
      activeFilter,
      getRangeFn,
      matchFolderNameOnly,
      matchWholeWord,
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
      // 异步请求缺失页
      fetchPage(pageIndex);
      return null;
    },
    [fetchPage, touchPageOrder]
  );

  // 防抖触发搜索
  useEffect(() => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }
    const trimmed = query.trim();
    if (trimmed === "") {
      debounceTimeoutRef.current = window.setTimeout(() => {
        startSearchSession("");
      }, 150) as unknown as number;
      return;
    }
    debounceTimeoutRef.current = window.setTimeout(() => {
      startSearchSession(trimmed);
    }, 320) as unknown as number;
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [query, startSearchSession]);

  // 选中项变化时触发预览
  useEffect(() => {
    const target = getItemByIndex(selectedIndex);
    if (!target) {
      setPreviewData(null);
      setIsPreviewLoading(false);
      return;
    }
    const requestId = ++previewRequestIdRef.current;
    setIsPreviewLoading(true);
    setPreviewData(null);
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
  }, [getItemByIndex, selectedIndex, cacheVersion]);

  const handleChangeSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortOrder("desc");
    }
  };

  const handleSelectFilter = (id: string) => {
    setActiveFilterId(id);
    
    // 如果选择的是自定义过滤器，将值回填到输入框以便编辑
    const customFilter = customFilters.find((f) => f.id === id);
    if (customFilter) {
      setNewFilterName(customFilter.label);
      setNewFilterExts(customFilter.extensions.join(", "));
    } else {
      // 选择内置过滤器时，清空输入框
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
    
    // 如果当前选择的是自定义过滤器，则更新它；否则创建新的
    const existingFilter = customFilters.find((f) => f.id === activeFilterId);
    if (existingFilter) {
      // 更新现有过滤器
      filterId = existingFilter.id;
      newFilters = customFilters.map((f) =>
        f.id === filterId
          ? { id: filterId, label: name, extensions: extList }
          : f
      );
      console.log("更新自定义过滤器:", filterId);
    } else {
      // 创建新过滤器
      filterId = `custom-${Date.now()}`;
      const filter: CustomFilter = { id: filterId, label: name, extensions: extList };
      newFilters = [...customFilters, filter];
      console.log("创建新自定义过滤器:", filterId);
    }
    
    setCustomFilters(newFilters);
    setActiveFilterId(filterId);
    setNewFilterName("");
    setNewFilterExts("");
    
    // 立即保存到 SQLite，确保持久化
    try {
      await tauriApi.saveEverythingCustomFilters(newFilters);
      console.log("自定义过滤器已保存到数据库:", newFilters);
      // 清除 localStorage 中的旧数据（如果存在）
      localStorage.removeItem(CUSTOM_FILTER_PREFERENCE_KEY);
    } catch (error) {
      console.error("保存自定义过滤器到数据库失败:", error);
    }
  };

  const handleRemoveCustomFilter = async (id: string) => {
    const newFilters = customFilters.filter((f) => f.id !== id);
    setCustomFilters(newFilters);
    if (activeFilterId === id) {
      setActiveFilterId("all");
    }
    
    // 立即保存到 SQLite，确保持久化
    try {
      await tauriApi.saveEverythingCustomFilters(newFilters);
      console.log("自定义过滤器已删除并保存到数据库:", newFilters);
      // 清除 localStorage 中的旧数据（如果存在）
      localStorage.removeItem(CUSTOM_FILTER_PREFERENCE_KEY);
    } catch (error) {
      console.error("保存自定义过滤器到数据库失败:", error);
    }
  };

  // 定义处理函数（必须在 useEffect 之前）
  const handleLaunch = useCallback(async (result: EverythingResult) => {
    try {
      await tauriApi.launchFile(result.path);
      await tauriApi.addFileToHistory(result.path);
    } catch (error) {
      console.error("Failed to launch file:", error);
    }
  }, []);

  const handleClose = useCallback(async () => {
    const window = getCurrentWindow();
    await window.close();
  }, []);

  const handleRevealInFolder = useCallback(async (result: EverythingResult) => {
    try {
      await tauriApi.revealInFolder(result.path);
    } catch (error) {
      console.error("Failed to reveal in folder:", error);
    }
  }, []);

  // 虚拟列表尺寸监听
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

  // 离开页面或窗口关闭时释放会话
  useEffect(() => {
    return () => {
      closeSessionSafe();
    };
  }, [closeSessionSafe]);

  // 监听后端批次事件（仅用于 legacy searchEverything 路径的实时进度）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const setup = async () => {
      unlisten = await listen<{
        results: EverythingResult[];
        total_count: number;
        current_count: number;
      }>("everything-search-batch", (event) => {
        // 会话模式时不处理（session API 不依赖事件）
        if (sessionMode) return;

        const { results, total_count, current_count } = event.payload;
        if (!Array.isArray(results) || results.length === 0) return;

        // 立即更新进度显示（轻量级操作，不阻塞 UI）
        const maxResultsToUse = Math.min(maxResults, ABS_MAX_RESULTS);
        const cappedCurrentCount = Math.min(current_count ?? 0, maxResultsToUse, SAFE_DISPLAY_LIMIT);
        setCurrentLoadedCount(cappedCurrentCount);

        // 限制 totalCount 为用户设置的 maxResults，而不是 Everything 的真实总数
        const cappedTotal = Math.min(
          total_count ?? cappedCurrentCount,
          maxResultsToUse,
          SAFE_DISPLAY_LIMIT
        );
        setTotalCount(cappedTotal);

        // 追加到累积（使用 push 避免创建新数组，减少内存分配）
        const currentLength = batchAccumRef.current.length;
        const remaining = maxResultsToUse - currentLength;
        if (remaining > 0 && results.length > 0) {
          const toAdd = Math.min(remaining, results.length);
          // 使用循环 push 而不是展开运算符，避免参数过多导致性能问题
          for (let i = 0; i < toAdd; i++) {
            batchAccumRef.current.push(results[i]);
          }
          // 如果超出限制，直接截断（避免 slice 创建新数组）
          if (batchAccumRef.current.length > maxResultsToUse) {
            batchAccumRef.current.length = maxResultsToUse;
          }
        }

        // 检查是否已完成
        const isComplete = cappedCurrentCount >= maxResultsToUse || cappedCurrentCount >= cappedTotal;
        if (isComplete) {
          setIsSearching(false);
        } else {
          setIsSearching(true);
        }

        // 延迟更新缓存（使用防抖 + requestIdleCallback，避免频繁重建和阻塞 UI）
        if (batchUpdateTimerRef.current) {
          clearTimeout(batchUpdateTimerRef.current);
        }
        batchUpdateTimerRef.current = window.setTimeout(() => {
          const limited = batchAccumRef.current;
          const updateCache = () => {
            // 分批处理，避免一次性处理太多数据阻塞 UI
            const processBatch = (startPage: number, endPage: number) => {
              for (let pageIndex = startPage; pageIndex < endPage; pageIndex += 1) {
                const start = pageIndex * PAGE_SIZE;
                const end = Math.min(start + PAGE_SIZE, limited.length);
                if (start < limited.length) {
                  const slice = limited.slice(start, end);
                  pageCacheRef.current.set(pageIndex, slice);
                  pageOrderRef.current.push(pageIndex);
                }
              }
            };

            pageCacheRef.current.clear();
            pageOrderRef.current = [];
            const pageCount = Math.ceil(limited.length / PAGE_SIZE);
            const BATCH_SIZE = 50; // 每批处理 50 页

            // 分批处理，每批之间让出控制权
            let currentPage = 0;
            const processNextBatch = () => {
              const endPage = Math.min(currentPage + BATCH_SIZE, pageCount);
              processBatch(currentPage, endPage);
              currentPage = endPage;

              if (currentPage < pageCount) {
                // 使用 setTimeout(0) 让出控制权，继续处理下一批
                setTimeout(processNextBatch, 0);
              } else {
                // 全部处理完成，更新版本
                setCacheVersion((v) => v + 1);
              }
            };

            processNextBatch();
          };

          // 使用 requestIdleCallback 在浏览器空闲时更新缓存
          if ('requestIdleCallback' in window) {
            requestIdleCallback(updateCache, { timeout: 200 });
          } else {
            // 降级到 setTimeout
            setTimeout(updateCache, 0);
          }
          batchUpdateTimerRef.current = null;
        }, 100) as unknown as number; // 100ms 防抖，减少重建频率
      });
    };
    setup();
    return () => {
      if (unlisten) unlisten();
    };
  }, [sessionMode, maxResults]);

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
  }, [displayCount, getItemByIndex, visibleRange.end, visibleRange.start]);

  const paddingTop = visibleRange.start * ITEM_HEIGHT;
  const paddingBottom = Math.max(0, (displayCount - visibleRange.end - 1) * ITEM_HEIGHT);

  const currentSelectedItem = getItemByIndex(selectedIndex);
  // 使用 ref 缓存已加载数量，避免每次遍历所有页面
  const cachedLoadedCountRef = useRef(0);
  const computedLoadedCount = useMemo(() => {
    // 只在 cacheVersion 变化时重新计算，减少计算频率
    let count = 0;
    const cache = pageCacheRef.current;
    // 使用迭代器而不是 forEach，性能稍好
    for (const page of cache.values()) {
      count += page.length;
    }
    cachedLoadedCountRef.current = count;
    const maxResultsToUse = Math.min(maxResults, ABS_MAX_RESULTS);
    return Math.min(count, maxResultsToUse, SAFE_DISPLAY_LIMIT);
  }, [cacheVersion, maxResults]);

  const isIndeterminateProgress = useMemo(
    () => isSearching && computedLoadedCount === 0,
    [computedLoadedCount, isSearching]
  );

  // 键盘导航
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const limit = displayCount > 0 ? displayCount - 1 : 0;
          return prev < limit ? prev + 1 : prev;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const target = getItemByIndex(selectedIndex);
        if (target) {
          handleLaunch(target);
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [displayCount, getItemByIndex, handleClose, handleLaunch, selectedIndex]);

  // 当搜索重新开始时复位选中索引
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, cacheVersion]);

  return (
    <div className="h-screen w-screen flex flex-col bg-gray-50">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-200 bg-white">
        <h2 className="text-lg font-semibold text-gray-800">Everything 文件搜索</h2>
        <button
          onClick={handleClose}
          className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
        >
          关闭
        </button>
      </div>

      {/* Search & Controls */}
      <div className="p-4 border-b border-gray-200 bg-white space-y-3">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索文件或文件夹... (支持 Everything 语法: *, ?, path:, regex: 等)"
            className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            autoFocus
          />
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 cursor-pointer hover:bg-gray-50 rounded-lg border border-gray-200 whitespace-nowrap">
              <input
                type="checkbox"
                checked={matchWholeWord}
                onChange={(e) => setMatchWholeWord(e.target.checked)}
                className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
              <span>全字匹配</span>
            </label>
            <label className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 cursor-pointer hover:bg-gray-50 rounded-lg border border-gray-200 whitespace-nowrap">
              <input
                type="checkbox"
                checked={matchFolderNameOnly}
                onChange={(e) => setMatchFolderNameOnly(e.target.checked)}
                className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
              <span>仅文件夹名</span>
            </label>
          </div>
        </div>
        <div className="text-sm text-gray-500 flex flex-wrap items-center gap-3">
          {isSearching && (
            <div className="flex flex-col gap-1 text-blue-600">
              <div className="flex items-center gap-2">
                <span className="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                <span>
                  {isIndeterminateProgress
                    ? "搜索中... 正在获取首批结果"
                    : totalCount
                    ? `搜索中... ${currentLoadedCount > 0 ? currentLoadedCount : computedLoadedCount}/${totalCount}`
                    : "搜索中..."}
                </span>
              </div>
              <div className="w-full bg-gray-200 h-1 rounded">
                <div
                  className={`h-1 bg-blue-500 rounded transition-all ${
                    isIndeterminateProgress ? "animate-pulse" : ""
                  }`}
                  style={{
                    width: isIndeterminateProgress
                      ? "35%"
                      : `${Math.min(
                          100,
                          totalCount
                            ? ((currentLoadedCount > 0 ? currentLoadedCount : computedLoadedCount) /
                                Math.max(totalCount, 1)) *
                              100
                            : 20
                        )}%`,
                  }}
                />
              </div>
            </div>
          )}
          {totalCount !== null && (
            <span>
              找到 {currentLoadedCount > 0 ? currentLoadedCount : computedLoadedCount} / {totalCount} 个结果，当前展示上限 {displayCount} 条
            </span>
          )}
          {sessionError && (
            <span className="text-red-600">会话错误：{sessionError}</span>
          )}
          <button
            onClick={() => setShowSyntaxHelp(!showSyntaxHelp)}
            className="text-blue-600 hover:text-blue-800 underline text-xs"
          >
            {showSyntaxHelp ? "隐藏" : "显示"} Everything 语法帮助
          </button>
        </div>

        {/* Everything 语法提示 */}
        {showSyntaxHelp && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm">
            <div className="font-semibold text-blue-900 mb-3">常用的 Everything 搜索语法：</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-2">
                <div>
                  <span className="font-mono text-blue-800 bg-blue-100 px-2 py-1 rounded">*</span>
                  <span className="ml-2 text-gray-700">匹配任意字符（通配符）</span>
                  <div className="ml-6 text-xs text-gray-500 mt-1">示例: <code className="bg-gray-100 px-1 rounded">*.jpg</code> 搜索所有 jpg 文件</div>
                </div>
                <div>
                  <span className="font-mono text-blue-800 bg-blue-100 px-2 py-1 rounded">?</span>
                  <span className="ml-2 text-gray-700">匹配单个字符</span>
                  <div className="ml-6 text-xs text-gray-500 mt-1">示例: <code className="bg-gray-100 px-1 rounded">test?.txt</code> 匹配 test1.txt, test2.txt 等</div>
                </div>
                <div>
                  <span className="font-mono text-blue-800 bg-blue-100 px-2 py-1 rounded">path:</span>
                  <span className="ml-2 text-gray-700">限制搜索路径</span>
                  <div className="ml-6 text-xs text-gray-500 mt-1">示例: <code className="bg-gray-100 px-1 rounded">path:C:\Users\*</code> 只搜索 Users 目录</div>
                </div>
                <div>
                  <span className="font-mono text-blue-800 bg-blue-100 px-2 py-1 rounded">parent:</span>
                  <span className="ml-2 text-gray-700">限制父目录</span>
                  <div className="ml-6 text-xs text-gray-500 mt-1">示例: <code className="bg-gray-100 px-1 rounded">parent:Documents</code> 搜索 Documents 下的文件</div>
                </div>
              </div>
              <div className="space-y-2">
                <div>
                  <span className="font-mono text-blue-800 bg-blue-100 px-2 py-1 rounded">file:</span>
                  <span className="ml-2 text-gray-700">只搜索文件</span>
                  <div className="ml-6 text-xs text-gray-500 mt-1">示例: <code className="bg-gray-100 px-1 rounded">file: test</code> 只搜索文件名包含 test 的文件</div>
                </div>
                <div>
                  <span className="font-mono text-blue-800 bg-blue-100 px-2 py-1 rounded">folder:</span>
                  <span className="ml-2 text-gray-700">只搜索文件夹</span>
                  <div className="ml-6 text-xs text-gray-500 mt-1">示例: <code className="bg-gray-100 px-1 rounded">folder: project</code> 只搜索文件夹名</div>
                </div>
                <div>
                  <span className="font-mono text-blue-800 bg-blue-100 px-2 py-1 rounded">ext:</span>
                  <span className="ml-2 text-gray-700">按扩展名过滤</span>
                  <div className="ml-6 text-xs text-gray-500 mt-1">示例: <code className="bg-gray-100 px-1 rounded">ext:jpg;png</code> 只搜索 jpg 和 png</div>
                </div>
                <div>
                  <span className="font-mono text-blue-800 bg-blue-100 px-2 py-1 rounded">regex:</span>
                  <span className="ml-2 text-gray-700">使用正则表达式</span>
                  <div className="ml-6 text-xs text-gray-500 mt-1">示例: <code className="bg-gray-100 px-1 rounded">regex:^test.*\.txt$</code> 正则匹配</div>
                </div>
                <div>
                  <span className="font-mono text-blue-800 bg-blue-100 px-2 py-1 rounded">|</span>
                  <span className="ml-2 text-gray-700">或运算符（空格表示与）</span>
                  <div className="ml-6 text-xs text-gray-500 mt-1">示例: <code className="bg-gray-100 px-1 rounded">jpg | png</code> 搜索包含 jpg 或 png 的文件</div>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-700 whitespace-nowrap">
            查询条数限制：
          </label>
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
            className="w-24 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <span className="text-xs text-gray-500">条（最小值：1，最多自动截断至 {ABS_MAX_RESULTS}）</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {[
            { key: "modified" as SortKey, label: "时间" },
            { key: "size" as SortKey, label: "大小" },
            { key: "type" as SortKey, label: "类型" },
            { key: "name" as SortKey, label: "名称" },
          ].map(({ key, label }) => {
            const active = sortKey === key;
            const arrow = active ? (sortOrder === "asc" ? "↑" : "↓") : "";
            return (
              <button
                key={key}
                onClick={() => handleChangeSort(key)}
                className={`px-3 py-1 text-sm rounded border ${
                  active ? "bg-blue-50 border-blue-200 text-blue-700" : "border-gray-200 text-gray-700"
                }`}
              >
                {label} {arrow}
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {[...QUICK_FILTERS, ...customFilters.map((f) => ({ ...f, isCustom: true }))].map((filter) => (
              <button
                key={filter.id}
                onClick={() => handleSelectFilter(filter.id)}
                className={`px-3 py-1 text-sm rounded-full border ${
                  activeFilterId === filter.id
                    ? "bg-blue-50 border-blue-200 text-blue-700"
                    : "border-gray-200 text-gray-700"
                }`}
                title={filter.extensions.join(", ")}
              >
                {filter.label}
                {filter.isCustom && "（自定义）"}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <input
              value={newFilterName}
              onChange={(e) => setNewFilterName(e.target.value)}
              placeholder="自定义过滤名称"
              className="px-3 py-1 border border-gray-200 rounded text-sm"
            />
            <input
              value={newFilterExts}
              onChange={(e) => setNewFilterExts(e.target.value)}
              placeholder="扩展名，逗号分隔，例如: jpg,png"
              className="px-3 py-1 border border-gray-200 rounded text-sm flex-1 min-w-[240px]"
            />
            <button
              onClick={handleAddCustomFilter}
              className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              {isEditingExistingFilter ? "更新过滤器" : "保存过滤器"}
            </button>
            {activeFilter?.isCustom && (
              <button
                onClick={() => handleRemoveCustomFilter(activeFilter.id)}
                className="px-3 py-1 text-sm text-red-600 border border-red-200 rounded hover:bg-red-50"
              >
                删除当前自定义过滤
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Status Message */}
      {!isEverythingAvailable && (
        <div className="p-4 bg-yellow-50 border-b border-yellow-200">
          <div className="text-sm text-yellow-800">
            Everything 不可用: {everythingError || "未知错误"}
          </div>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 flex min-h-0">
        {/* Results List */}
        <div
          className="flex-1 overflow-y-auto relative"
          ref={listContainerRef}
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        >
          {displayCount === 0 && !isSearching && query.trim() !== "" && (
            <div className="p-8 text-center text-gray-500">未找到结果</div>
          )}
          {displayCount === 0 && query.trim() === "" && (
            <div className="p-8 text-center text-gray-500">输入关键词开始搜索</div>
          )}
          {softLimitWarning && (
            <div className="p-3 bg-yellow-50 border-b border-yellow-200 text-xs text-yellow-800">
              {softLimitWarning}
            </div>
          )}
          <div style={{ paddingTop, paddingBottom }}>
            {visibleItems.map(({ index, item }) => {
              const ext = item ? getExtension(item.name) : null;
              const isSelected = index === selectedIndex;
              return (
                <div
                  key={item ? item.path : `placeholder-${index}`}
                  onClick={() => setSelectedIndex(index)}
                  onDoubleClick={() => item && handleLaunch(item)}
                  className={`p-3 border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${
                    isSelected ? "bg-blue-50" : ""
                  }`}
                  style={{ minHeight: ITEM_HEIGHT }}
                >
                  {!item && (
                    <div className="text-sm text-gray-400">加载中... #{index + 1}</div>
                  )}
                  {item && (
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-400 w-10 shrink-0 text-right">
                            #{index + 1}
                          </span>
                          <div className="font-medium text-gray-900 truncate">{item.name}</div>
                        </div>
                        <div className="text-sm text-gray-500 truncate mt-1">{item.path}</div>
                        <div className="text-xs text-gray-400 mt-1 flex flex-wrap gap-3">
                          <span>类型：{ext || "未知"}</span>
                          <span>修改：{formatDate(item.date_modified)}</span>
                          {typeof item.size === "number" && (
                            <span>大小：{formatFileSize(item.size)}</span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (item) handleRevealInFolder(item);
                        }}
                        className="ml-2 px-2 py-1 text-xs text-gray-600 hover:text-gray-800 hover:bg-gray-200 rounded"
                      >
                        在文件夹中显示
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Preview Panel */}
        <div className="w-96 border-l border-gray-200 bg-white p-4 overflow-y-auto">
          <div className="text-base font-semibold text-gray-800 mb-2">快速预览</div>
          {!currentSelectedItem && <div className="text-sm text-gray-500">选择结果查看预览</div>}
          {currentSelectedItem && (
            <div className="space-y-3">
              <div>
                <div className="text-sm text-gray-900 font-medium truncate">
                  {currentSelectedItem.name}
                </div>
                <div className="text-xs text-gray-500 truncate">{currentSelectedItem.path}</div>
              </div>
              <div className="text-xs text-gray-500 flex flex-wrap gap-3">
                {typeof currentSelectedItem.size === "number" && (
                  <span>大小：{formatFileSize(currentSelectedItem.size!)}</span>
                )}
                <span>修改：{formatDate(currentSelectedItem.date_modified)}</span>
                <span>类型：{getExtension(currentSelectedItem.path) || "未知"}</span>
              </div>

              {isPreviewLoading && <div className="text-sm text-gray-500">加载预览...</div>}
              {!isPreviewLoading && previewData?.kind === "text" && (
                <div className="text-sm text-gray-800 border border-gray-200 rounded p-2 bg-gray-50 max-h-64 overflow-auto whitespace-pre-wrap">
                  {previewData.content || "（空文件）"}
                  {previewData.truncated && <div className="text-xs text-gray-400 mt-1">已截断</div>}
                </div>
              )}
              {!isPreviewLoading && previewData?.kind === "image" && previewData.imageDataUrl && (
                <div className="border border-gray-200 rounded p-2 bg-gray-50">
                  <img
                    src={previewData.imageDataUrl}
                    alt="预览图"
                    className="max-h-72 w-full object-contain bg-white"
                  />
                  {previewData.truncated && <div className="text-xs text-gray-400 mt-1">已截断</div>}
                </div>
              )}
              {!isPreviewLoading && previewData?.kind === "media" && (
                <div className="text-sm text-gray-700 border border-gray-200 rounded p-2 bg-gray-50">
                  音视频文件，暂不内嵌播放
                </div>
              )}
              {!isPreviewLoading && previewData?.kind === "folder" && (
                <div className="text-sm text-gray-700 border border-gray-200 rounded p-2 bg-gray-50">
                  文件夹无法直接预览
                </div>
              )}
              {!isPreviewLoading &&
                previewData &&
                (previewData.kind === "binary" || previewData.kind === "unsupported") && (
                  <div className="text-sm text-gray-700 border border-gray-200 rounded p-2 bg-gray-50">
                    暂不支持该类型预览
                  </div>
                )}
              {!isPreviewLoading && previewData?.kind === "error" && (
                <div className="text-sm text-red-600 border border-red-200 rounded p-2 bg-red-50">
                  预览失败：{previewData.error || "未知错误"}
                </div>
              )}
              {!isPreviewLoading && !previewData && (
                <div className="text-sm text-gray-500">未获取到预览数据</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getExtension(pathOrName: string): string | null {
  // 找到最后一个点的位置
  const lastDotIndex = pathOrName.lastIndexOf(".");
  // 如果没找到点，或者点是第一个字符（隐藏文件如 .gitignore），返回 null
  if (lastDotIndex === -1 || lastDotIndex === 0) return null;
  // 提取点后面的部分
  const ext = pathOrName.substring(lastDotIndex + 1);
  // 如果扩展名包含路径分隔符，说明这不是扩展名
  if (ext.includes("/") || ext.includes("\\")) return null;
  // 如果扩展名为空，返回 null
  if (ext.length === 0) return null;
  return ext.toLowerCase();
}

function parseDate(dateStr?: string): number | null {
  if (!dateStr) return null;
  const ts = Date.parse(dateStr);
  if (Number.isNaN(ts)) return null;
  return ts;
}

function formatDate(dateStr?: string): string {
  const ts = parseDate(dateStr);
  if (!ts) return "-";
  const d = new Date(ts);
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d
    .getDate()
    .toString()
    .padStart(2, "0")} ${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}


