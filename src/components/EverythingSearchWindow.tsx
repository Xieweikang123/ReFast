import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
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
const DEFAULT_MAX_RESULTS = 500;

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
  const [results, setResults] = useState<EverythingResult[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [currentCount, setCurrentCount] = useState(0);
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
  
  const currentSearchRef = useRef<{ query: string; cancelled: boolean } | null>(null);
  const debounceTimeoutRef = useRef<number | null>(null);
  const previewRequestIdRef = useRef(0);

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

  // 加载偏好
  useEffect(() => {
    try {
      const savedSort = localStorage.getItem(SORT_PREFERENCE_KEY);
      if (savedSort) {
        const parsed = JSON.parse(savedSort) as { key?: SortKey; order?: SortOrder };
        if (parsed.key) setSortKey(parsed.key);
        if (parsed.order) setSortOrder(parsed.order);
      }

      const savedFilterId = localStorage.getItem(FILTER_PREFERENCE_KEY);
      if (savedFilterId) setActiveFilterId(savedFilterId);

      const savedCustom = localStorage.getItem(CUSTOM_FILTER_PREFERENCE_KEY);
      if (savedCustom) {
        try {
          const parsed = JSON.parse(savedCustom) as CustomFilter[];
          if (Array.isArray(parsed)) {
            setCustomFilters(parsed);
            console.log("已加载自定义过滤器:", parsed);
          } else {
            console.warn("自定义过滤器数据格式无效，已忽略");
          }
        } catch (error) {
          console.error("解析自定义过滤器失败:", error);
        }
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
    try {
      const serialized = JSON.stringify(customFilters);
      localStorage.setItem(CUSTOM_FILTER_PREFERENCE_KEY, serialized);
      console.log("自定义过滤器已自动保存:", customFilters);
    } catch (error) {
      console.error("自动保存自定义过滤器失败:", error);
    }
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

  // 监听批次结果事件
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;

    const setupListener = async () => {
      try {
        unlistenFn = await listen<{
          results: EverythingResult[];
          total_count: number;
          current_count: number;
        }>("everything-search-batch", (event) => {
          const { results: batchResults, total_count, current_count } = event.payload;
          
          if (currentSearchRef.current?.cancelled) {
            return;
          }

          // 合并批次结果
          setResults(prev => {
            const seenPaths = new Set(prev.map(r => r.path));
            const newResults = batchResults.filter(r => !seenPaths.has(r.path));
            return [...prev, ...newResults];
          });
          setTotalCount(total_count);
          setCurrentCount(current_count);
        });
      } catch (error) {
        console.error("Failed to setup Everything batch listener:", error);
      }
    };

    setupListener();

    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, []);

  // 搜索函数
  const searchEverything = useCallback(async (searchQuery: string) => {
    if (!searchQuery || searchQuery.trim() === "") {
      setResults([]);
      setTotalCount(null);
      setCurrentCount(0);
      setIsSearching(false);
      if (currentSearchRef.current) {
        currentSearchRef.current.cancelled = true;
        currentSearchRef.current = null;
      }
      return;
    }

    if (!isEverythingAvailable) {
      setResults([]);
      setTotalCount(null);
      setCurrentCount(0);
      setIsSearching(false);
      return;
    }

    const extFilter =
      activeFilter && activeFilter.extensions.length > 0
        ? activeFilter.extensions
        : undefined;
    // searchKey 需要包含所有影响搜索结果的选项，以便正确检测查询是否变化
    const searchKey = `${searchQuery}::${extFilter?.join(",") ?? "all"}::wholeWord:${matchWholeWord}::folderOnly:${matchFolderNameOnly}`;

    // 取消之前的搜索
    if (currentSearchRef.current) {
      if (currentSearchRef.current.query === searchKey) {
        return; // 相同查询，跳过
      }
      currentSearchRef.current.cancelled = true;
    }

    const searchRequest = { query: searchKey, cancelled: false };
    currentSearchRef.current = searchRequest;

    setResults([]);
    setTotalCount(null);
    setCurrentCount(0);
    setIsSearching(true);

    try {
      const response = await tauriApi.searchEverything(searchQuery, {
        extensions: extFilter,
        maxResults: maxResults,
        matchWholeWord: matchWholeWord,
        matchFolderNameOnly: matchFolderNameOnly,
      });
      
      if (currentSearchRef.current?.cancelled || 
          currentSearchRef.current?.query !== searchKey) {
        return;
      }

      // 去重
      const seenPaths = new Map<string, EverythingResult>();
      const uniqueResults: EverythingResult[] = [];
      for (const result of response.results) {
        if (!seenPaths.has(result.path)) {
          seenPaths.set(result.path, result);
          uniqueResults.push(result);
        }
      }

      setResults(uniqueResults);
      setTotalCount(response.total_count);
      setCurrentCount(uniqueResults.length);
    } catch (error) {
      if (currentSearchRef.current?.cancelled) {
        return;
      }
      console.error("Failed to search Everything:", error);
      setResults([]);
      setTotalCount(null);
      setCurrentCount(0);
      
      const errorStr = typeof error === 'string' ? error : String(error);
      if (errorStr.includes('NOT_INSTALLED') || 
          errorStr.includes('SERVICE_NOT_RUNNING')) {
        const status = await tauriApi.getEverythingStatus();
        setIsEverythingAvailable(status.available);
        setEverythingError(status.error || null);
      }
    } finally {
      if (currentSearchRef.current?.query === searchKey && 
          !currentSearchRef.current?.cancelled) {
        setIsSearching(false);
      }
    }
  }, [isEverythingAvailable, activeFilter, matchWholeWord, matchFolderNameOnly, maxResults]);

  // 防抖搜索
  useEffect(() => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery === "") {
      setResults([]);
      setTotalCount(null);
      setCurrentCount(0);
      setIsSearching(false);
      return;
    }

    debounceTimeoutRef.current = setTimeout(() => {
      searchEverything(trimmedQuery);
    }, 300) as unknown as number;

    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [query, searchEverything]);

  // 切换过滤器或搜索选项时重新触发 IPC 搜索（保持与当前关键词一致）
  useEffect(() => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return;
    // 直接触发一次搜索，复用去重/取消逻辑
    searchEverything(trimmedQuery);
  }, [activeFilter, matchWholeWord, matchFolderNameOnly, query, searchEverything]);

  const filteredAndSortedResults = useMemo(() => {
    const extSet =
      activeFilter && activeFilter.extensions.length > 0
        ? new Set(activeFilter.extensions.map((e) => e.toLowerCase()))
        : null;

    const filtered = extSet
      ? results.filter((item) => {
          const ext = getExtension(item.path);
          return ext && extSet.has(ext);
        })
      : results;

    const sorted = [...filtered].sort((a, b) => {
      const compare = (x: number | string | null | undefined, y: number | string | null | undefined) => {
        if (x === undefined || x === null) return 1;
        if (y === undefined || y === null) return -1;
        if (typeof x === "string" && typeof y === "string") return x.localeCompare(y);
        return (x as number) - (y as number);
      };

      let res = 0;
      switch (sortKey) {
        case "name":
          res = a.name.localeCompare(b.name);
          break;
        case "type":
          res = compare(getExtension(a.path) || "", getExtension(b.path) || "");
          break;
        case "size":
          res = compare(a.size, b.size);
          break;
        case "modified":
        default:
          res = compare(parseDate(a.date_modified), parseDate(b.date_modified));
          break;
      }
      return sortOrder === "asc" ? res : -res;
    });

    return sorted;
  }, [results, activeFilter, sortKey, sortOrder]);

  useEffect(() => {
    setSelectedIndex((prev) => {
      if (filteredAndSortedResults.length === 0) return 0;
      return Math.min(prev, filteredAndSortedResults.length - 1);
    });
  }, [filteredAndSortedResults]);

  useEffect(() => {
    if (!filteredAndSortedResults[selectedIndex]) {
      setPreviewData(null);
      return;
    }
    const target = filteredAndSortedResults[selectedIndex];
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
  }, [filteredAndSortedResults, selectedIndex]);

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

  const handleAddCustomFilter = () => {
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
    
    // 立即保存到 localStorage，确保持久化
    try {
      const serialized = JSON.stringify(newFilters);
      localStorage.setItem(CUSTOM_FILTER_PREFERENCE_KEY, serialized);
      console.log("自定义过滤器已保存:", newFilters);
    } catch (error) {
      console.error("保存自定义过滤器失败:", error);
      // 即使保存失败，也继续执行，因为 useEffect 可能会重试
    }
  };

  const handleRemoveCustomFilter = (id: string) => {
    const newFilters = customFilters.filter((f) => f.id !== id);
    setCustomFilters(newFilters);
    if (activeFilterId === id) {
      setActiveFilterId("all");
    }
    
    // 立即保存到 localStorage，确保持久化
    try {
      const serialized = JSON.stringify(newFilters);
      localStorage.setItem(CUSTOM_FILTER_PREFERENCE_KEY, serialized);
      console.log("自定义过滤器已删除并保存:", newFilters);
    } catch (error) {
      console.error("保存自定义过滤器失败:", error);
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

  // 键盘导航
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex(prev => 
          prev < filteredAndSortedResults.length - 1 ? prev + 1 : prev
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(prev => prev > 0 ? prev - 1 : 0);
      } else if (e.key === "Enter" && filteredAndSortedResults[selectedIndex]) {
        e.preventDefault();
        handleLaunch(filteredAndSortedResults[selectedIndex]);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [filteredAndSortedResults, selectedIndex, handleLaunch, handleClose]);

  // 当结果变化时重置选中索引
  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

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
          {isSearching && <span>搜索中...</span>}
          {totalCount !== null && (
            <span>
              找到 {currentCount} / {totalCount} 个结果，当前显示 {filteredAndSortedResults.length} 条
            </span>
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
          <span className="text-xs text-gray-500">条（最小值：1）</span>
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
        <div className="flex-1 overflow-y-auto">
          {filteredAndSortedResults.length === 0 && !isSearching && query.trim() !== "" && (
            <div className="p-8 text-center text-gray-500">未找到结果</div>
          )}
          {filteredAndSortedResults.length === 0 && query.trim() === "" && (
            <div className="p-8 text-center text-gray-500">输入关键词开始搜索</div>
          )}
          {filteredAndSortedResults.map((result, index) => {
            const ext = getExtension(result.path);
            return (
              <div
                key={result.path}
                onClick={() => setSelectedIndex(index)}
                onDoubleClick={() => handleLaunch(result)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  // 可以添加右键菜单
                }}
                className={`p-3 border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${
                  index === selectedIndex ? "bg-blue-50" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-gray-900 truncate">{result.name}</div>
                    <div className="text-sm text-gray-500 truncate mt-1">{result.path}</div>
                    <div className="text-xs text-gray-400 mt-1 flex flex-wrap gap-3">
                      <span>类型：{ext || "未知"}</span>
                      <span>修改：{formatDate(result.date_modified)}</span>
                      {typeof result.size === "number" && <span>大小：{formatFileSize(result.size)}</span>}
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRevealInFolder(result);
                    }}
                    className="ml-2 px-2 py-1 text-xs text-gray-600 hover:text-gray-800 hover:bg-gray-200 rounded"
                  >
                    在文件夹中显示
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Preview Panel */}
        <div className="w-96 border-l border-gray-200 bg-white p-4 overflow-y-auto">
          <div className="text-base font-semibold text-gray-800 mb-2">快速预览</div>
          {!filteredAndSortedResults[selectedIndex] && (
            <div className="text-sm text-gray-500">选择结果查看预览</div>
          )}
          {filteredAndSortedResults[selectedIndex] && (
            <div className="space-y-3">
              <div>
                <div className="text-sm text-gray-900 font-medium truncate">
                  {filteredAndSortedResults[selectedIndex].name}
                </div>
                <div className="text-xs text-gray-500 truncate">
                  {filteredAndSortedResults[selectedIndex].path}
                </div>
              </div>
              <div className="text-xs text-gray-500 flex flex-wrap gap-3">
                {typeof filteredAndSortedResults[selectedIndex].size === "number" && (
                  <span>大小：{formatFileSize(filteredAndSortedResults[selectedIndex].size!)}</span>
                )}
                <span>修改：{formatDate(filteredAndSortedResults[selectedIndex].date_modified)}</span>
                <span>类型：{getExtension(filteredAndSortedResults[selectedIndex].path) || "未知"}</span>
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

function getExtension(path: string): string | null {
  const last = path.split(".").pop();
  if (!last || last.includes("/") || last.includes("\\")) return null;
  return last.toLowerCase();
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

