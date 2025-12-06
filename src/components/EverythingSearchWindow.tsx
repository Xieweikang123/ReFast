import { useState, useEffect, useRef, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { tauriApi } from "../api/tauri";
import type { EverythingResult } from "../types";

export function EverythingSearchWindow() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EverythingResult[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [currentCount, setCurrentCount] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [isEverythingAvailable, setIsEverythingAvailable] = useState(false);
  const [everythingError, setEverythingError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  
  const currentSearchRef = useRef<{ query: string; cancelled: boolean } | null>(null);
  const debounceTimeoutRef = useRef<number | null>(null);

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

    // 取消之前的搜索
    if (currentSearchRef.current) {
      if (currentSearchRef.current.query === searchQuery) {
        return; // 相同查询，跳过
      }
      currentSearchRef.current.cancelled = true;
    }

    const searchRequest = { query: searchQuery, cancelled: false };
    currentSearchRef.current = searchRequest;

    setResults([]);
    setTotalCount(null);
    setCurrentCount(0);
    setIsSearching(true);

    try {
      const response = await tauriApi.searchEverything(searchQuery);
      
      if (currentSearchRef.current?.cancelled || 
          currentSearchRef.current?.query !== searchQuery) {
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
      if (currentSearchRef.current?.query === searchQuery && 
          !currentSearchRef.current?.cancelled) {
        setIsSearching(false);
      }
    }
  }, [isEverythingAvailable]);

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
          prev < results.length - 1 ? prev + 1 : prev
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(prev => prev > 0 ? prev - 1 : 0);
      } else if (e.key === "Enter" && results[selectedIndex]) {
        e.preventDefault();
        handleLaunch(results[selectedIndex]);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [results, selectedIndex, handleLaunch, handleClose]);

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

      {/* Search Input */}
      <div className="p-4 border-b border-gray-200 bg-white">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索文件或文件夹..."
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          autoFocus
        />
        {isSearching && (
          <div className="mt-2 text-sm text-gray-500">
            搜索中...
          </div>
        )}
        {totalCount !== null && (
          <div className="mt-2 text-sm text-gray-500">
            找到 {currentCount} / {totalCount} 个结果
          </div>
        )}
      </div>

      {/* Status Message */}
      {!isEverythingAvailable && (
        <div className="p-4 bg-yellow-50 border-b border-yellow-200">
          <div className="text-sm text-yellow-800">
            Everything 不可用: {everythingError || "未知错误"}
          </div>
        </div>
      )}

      {/* Results List */}
      <div className="flex-1 overflow-y-auto">
        {results.length === 0 && !isSearching && query.trim() !== "" && (
          <div className="p-8 text-center text-gray-500">
            未找到结果
          </div>
        )}
        {results.length === 0 && query.trim() === "" && (
          <div className="p-8 text-center text-gray-500">
            输入关键词开始搜索
          </div>
        )}
        {results.map((result, index) => (
          <div
            key={result.path}
            onClick={() => handleLaunch(result)}
            onContextMenu={(e) => {
              e.preventDefault();
              // 可以添加右键菜单
            }}
            className={`p-3 border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${
              index === selectedIndex ? "bg-blue-50" : ""
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-900 truncate">
                  {result.name}
                </div>
                <div className="text-sm text-gray-500 truncate mt-1">
                  {result.path}
                </div>
                {result.size !== undefined && (
                  <div className="text-xs text-gray-400 mt-1">
                    {formatFileSize(result.size)}
                  </div>
                )}
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
        ))}
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

