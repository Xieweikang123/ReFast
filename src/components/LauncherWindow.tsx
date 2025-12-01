import { useState, useEffect, useRef, useMemo } from "react";
import { tauriApi } from "../api/tauri";
import type { AppInfo, FileHistoryItem, EverythingResult } from "../types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

type SearchResult = {
  type: "app" | "file" | "everything" | "url";
  app?: AppInfo;
  file?: FileHistoryItem;
  everything?: EverythingResult;
  url?: string;
  displayName: string;
  path: string;
};

export function LauncherWindow() {
  const [query, setQuery] = useState("");
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [filteredApps, setFilteredApps] = useState<AppInfo[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<FileHistoryItem[]>([]);
  const [everythingResults, setEverythingResults] = useState<EverythingResult[]>([]);
  const [everythingTotalCount, setEverythingTotalCount] = useState<number | null>(null);
  const [everythingCurrentCount, setEverythingCurrentCount] = useState<number>(0); // 当前已加载的数量
  const [displayedResultsCount, setDisplayedResultsCount] = useState<number>(500); // 当前显示的结果数量
  
  // 限制显示的结果数量，避免 DOM 节点过多导致卡顿
  const MAX_DISPLAY_RESULTS = 500; // 每次加载 500 条结果
  const [isEverythingAvailable, setIsEverythingAvailable] = useState(false);
  const [everythingPath, setEverythingPath] = useState<string | null>(null);
  const [everythingVersion, setEverythingVersion] = useState<string | null>(null);
  const [everythingError, setEverythingError] = useState<string | null>(null);
  const [isSearchingEverything, setIsSearchingEverything] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isHoveringConfigIcon, setIsHoveringConfigIcon] = useState(false);
  const [detectedUrls, setDetectedUrls] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; result: SearchResult } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const shouldPreserveScrollRef = useRef(false); // 标记是否需要保持滚动位置
  const finalResultsSetRef = useRef(false); // 方案 B 中仅用于调试/校验，不再阻止批次更新

  // Check if Everything is available on mount
  useEffect(() => {
    const checkEverything = async () => {
      try {
        const status = await tauriApi.getEverythingStatus();
        setIsEverythingAvailable(status.available);
        setEverythingError(status.error || null);
        
        // Get Everything path and version for debugging
        if (status.available) {
          try {
            const path = await tauriApi.getEverythingPath();
            setEverythingPath(path);
            if (path) {
              console.log("Everything found at:", path);
            }
            
            // Get Everything version
            try {
              const version = await tauriApi.getEverythingVersion();
              setEverythingVersion(version);
              if (version) {
                console.log("Everything version:", version);
              }
            } catch (error) {
              console.error("Failed to get Everything version:", error);
            }
          } catch (error) {
            console.error("Failed to get Everything path:", error);
          }
        } else {
          console.warn("Everything is not available:", status.error);
          setEverythingPath(null);
          setEverythingVersion(null);
        }
      } catch (error) {
        console.error("Failed to check Everything availability:", error);
        setIsEverythingAvailable(false);
        setEverythingPath(null);
        setEverythingVersion(null);
        setEverythingError("检查失败");
      }
    };
    checkEverything();
  }, []);

  // Listen for download progress events
  useEffect(() => {
    if (!isDownloading) return;

    let unlistenFn1: (() => void) | null = null;
    let unlistenFn2: (() => void) | null = null;
    
    const setupProgressListener = async () => {
      const unlisten1 = await listen<number>("everything-download-progress", (event) => {
        setDownloadProgress(event.payload);
      });
      unlistenFn1 = unlisten1;
      
      const unlisten2 = await listen<number>("es-download-progress", (event) => {
        setDownloadProgress(event.payload);
      });
      unlistenFn2 = unlisten2;
    };

    setupProgressListener();

    return () => {
      if (unlistenFn1) {
        unlistenFn1();
      }
      if (unlistenFn2) {
        unlistenFn2();
      }
    };
  }, [isDownloading]);

  // Adjust window size when download modal is shown
  useEffect(() => {
    if (!showDownloadModal) return;

    const adjustWindowForModal = () => {
      const window = getCurrentWindow();
      
      // Get the main container width to maintain consistent width
      const whiteContainer = document.querySelector('.bg-white');
      const containerWidth = whiteContainer ? whiteContainer.scrollWidth : 600;
      // Limit max width to prevent window from being too wide
      const maxWidth = 600;
      const targetWidth = Math.min(containerWidth, maxWidth);
      
      // Find the modal element and calculate its actual height
      const modalElement = document.querySelector('[class*="bg-white"][class*="rounded-lg"][class*="shadow-xl"]');
      if (modalElement) {
        const modalRect = modalElement.getBoundingClientRect();
        const modalHeight = modalRect.height;
        // Add padding for margins (my-4 = 16px top + 16px bottom = 32px)
        const requiredHeight = modalHeight + 32;
        
        window.setSize(new LogicalSize(targetWidth, requiredHeight)).catch(console.error);
      } else {
        // Fallback: use estimated height
        const estimatedHeight = 450;
        window.setSize(new LogicalSize(targetWidth, estimatedHeight)).catch(console.error);
      }
    };

    // Wait for modal to render, use double requestAnimationFrame for accurate measurement
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(adjustWindowForModal, 50);
      });
    });
  }, [showDownloadModal, isDownloading, downloadedPath]);

  // Focus input when window becomes visible and adjust window size
  useEffect(() => {
    const window = getCurrentWindow();
    
    // Ensure window has no decorations
    window.setDecorations(false).catch(console.error);
    
    // Set initial window size to match white container
    const setWindowSize = () => {
      const whiteContainer = document.querySelector('.bg-white');
      if (whiteContainer) {
        // Use scrollHeight to get the full content height including overflow
        const containerWidth = whiteContainer.scrollWidth;
        const containerHeight = whiteContainer.scrollHeight;
        // Limit max width to prevent window from being too wide
        const maxWidth = 600;
        const targetWidth = Math.min(containerWidth, maxWidth);
        // Use setSize to match content area exactly (decorations are disabled)
        window.setSize(new LogicalSize(targetWidth, containerHeight)).catch(console.error);
      }
    };
    
    // Set initial size after a short delay to ensure DOM is ready
    setTimeout(setWindowSize, 100);
    
    // Global keyboard listener for Escape key
    const handleGlobalKeyDown = async (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.keyCode === 27) {
        e.preventDefault();
        e.stopPropagation();
        try {
          await tauriApi.hideLauncher();
          setQuery("");
          setSelectedIndex(0);
        } catch (error) {
          console.error("Failed to hide window:", error);
        }
      }
    };
    
    // Use document with capture phase to catch Esc key early
    document.addEventListener("keydown", handleGlobalKeyDown, true);
    
    // Focus input when window gains focus
    const unlistenFocus = window.onFocusChanged(({ payload: focused }) => {
      if (focused && inputRef.current) {
        setTimeout(() => {
          inputRef.current?.focus();
          // Only select text if input is empty
          if (inputRef.current && !inputRef.current.value) {
            inputRef.current.select();
          }
        }, 100);
      }
    });

    // Focus input when window becomes visible (check periodically, but don't select text)
    let focusInterval: ReturnType<typeof setInterval> | null = null;
    let lastVisibilityState = false;
    const checkVisibilityAndFocus = async () => {
      try {
        const isVisible = await window.isVisible();
        if (isVisible && !lastVisibilityState && inputRef.current) {
          // Only focus when window becomes visible (transition from hidden to visible)
          inputRef.current.focus();
          // Only select text if input is empty
          if (!inputRef.current.value) {
            inputRef.current.select();
          }
        }
        lastVisibilityState = isVisible;
      } catch (error) {
        // Ignore errors
      }
    };
    focusInterval = setInterval(checkVisibilityAndFocus, 300);

    // Also focus on mount
    const focusInput = () => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    };
    setTimeout(focusInput, 100);

    return () => {
      document.removeEventListener("keydown", handleGlobalKeyDown, true);
      if (focusInterval) {
        clearInterval(focusInterval);
      }
      unlistenFocus.then((fn: () => void) => fn());
    };
  }, []);

  // Extract URLs from text
  const extractUrls = (text: string): string[] => {
    if (!text || text.trim().length === 0) return [];
    
    // URL regex pattern - matches http://, https://, and common URL patterns
    // This pattern matches:
    // - http:// or https:// URLs
    // - www. URLs
    // - Domain-like patterns (e.g., example.com, github.com/user/repo)
    const urlPattern = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}[^\s<>"']*)/gi;
    const matches = text.match(urlPattern);
    if (!matches) return [];
    
    // Normalize URLs (add https:// if missing)
    return matches.map(url => {
      url = url.trim();
      // Remove trailing punctuation that might not be part of the URL
      // But keep /, ?, #, &, = which are valid URL characters
      url = url.replace(/[.,;:!?]+(?![\/?#&=])$/, '');
      
      // Validate and normalize URL
      if (!url.match(/^https?:\/\//i)) {
        if (url.startsWith('www.')) {
          return 'https://' + url;
        }
        // For domain-like patterns, add https://
        // Match patterns like: domain.com, subdomain.domain.com, domain.com/path
        if (url.match(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}/)) {
          return 'https://' + url;
        }
        // If it doesn't match domain pattern, skip it
        return null;
      }
      return url;
    })
    .filter((url): url is string => url !== null && url.length > 0) // Remove nulls and empty strings
    .filter((url, index, self) => self.indexOf(url) === index); // Remove duplicates
  };

  // Search applications, file history, and Everything when query changes (with debounce)
  useEffect(() => {
    if (query.trim() === "") {
      // Cancel any ongoing search
      if (currentSearchRef.current) {
        currentSearchRef.current.cancelled = true;
        currentSearchRef.current = null;
      }
      setFilteredApps([]);
      setFilteredFiles([]);
      setEverythingResults([]);
      setEverythingTotalCount(null);
      setEverythingCurrentCount(0);
      setDisplayedResultsCount(MAX_DISPLAY_RESULTS); // 重置显示数量
      setDetectedUrls([]);
      setResults([]);
      setSelectedIndex(0);
      setIsSearchingEverything(false);
      return;
    }
    
    // Extract URLs from query
    const urls = extractUrls(query);
    setDetectedUrls(urls);
    
    // Debounce search to avoid too many requests
    const timeoutId = setTimeout(() => {
      searchApplications(query);
      searchFileHistory(query);
      if (isEverythingAvailable) {
        console.log("Everything is available, calling searchEverything with query:", query);
        searchEverything(query);
      } else {
        console.log("Everything is not available, skipping search. isEverythingAvailable:", isEverythingAvailable);
      }
    }, 500); // 500ms debounce
    
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, isEverythingAvailable]);

  // Combine apps, files, Everything results, and URLs into results when they change
  // 使用 useMemo 优化，避免不必要的重新计算
  const combinedResults = useMemo(() => {
    const results: SearchResult[] = [
      // URLs first (highest priority when detected)
      ...detectedUrls.map((url) => ({
        type: "url" as const,
        url,
        displayName: url,
        path: url,
      })),
      ...filteredApps.map((app) => ({
        type: "app" as const,
        app,
        displayName: app.name,
        path: app.path,
      })),
      ...filteredFiles.map((file) => ({
        type: "file" as const,
        file,
        displayName: file.name,
        path: file.path,
      })),
      // 限制 Everything 结果显示数量，支持滚动加载更多
      ...everythingResults.slice(0, displayedResultsCount).map((everything) => ({
        type: "everything" as const,
        everything,
        displayName: everything.name,
        path: everything.path,
      })),
    ];
    return results;
  }, [filteredApps, filteredFiles, everythingResults, detectedUrls, displayedResultsCount]);

  useEffect(() => {
    // 保存当前滚动位置（如果需要保持）
    const needPreserveScroll = shouldPreserveScrollRef.current;
    const savedScrollTop = needPreserveScroll && listRef.current 
      ? listRef.current.scrollTop 
      : null;
    const savedScrollHeight = needPreserveScroll && listRef.current
      ? listRef.current.scrollHeight
      : null;
    
    // 只有在结果真正变化时才更新，避免不必要的重新渲染
    setResults(combinedResults);
    
    // 如果需要保持滚动位置，在 DOM 更新后恢复
    if (needPreserveScroll && savedScrollTop !== null && savedScrollHeight !== null) {
      // 使用多个 requestAnimationFrame 确保 DOM 完全更新
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (listRef.current) {
              const newScrollHeight = listRef.current.scrollHeight;
              // 计算新的滚动位置（保持相对位置）
              const scrollRatio = savedScrollTop / savedScrollHeight;
              const newScrollTop = newScrollHeight * scrollRatio;
              listRef.current.scrollTop = newScrollTop;
              shouldPreserveScrollRef.current = false;
              console.log(`[滚动保持] 恢复滚动位置: ${savedScrollTop} -> ${newScrollTop} (ratio: ${scrollRatio.toFixed(3)})`);
            }
          });
        });
      });
    } else if (!needPreserveScroll && listRef.current) {
      // 如果不是保持滚动位置，且列表有滚动，不要重置滚动位置
      // 这样可以避免意外的滚动重置
    }
    
    // 使用节流优化窗口大小调整，避免频繁调用导致卡顿
    // 如果正在保持滚动位置，延迟窗口大小调整，让滚动位置先恢复
    const delay = needPreserveScroll ? 600 : 300;
    const timeoutId = setTimeout(() => {
      const adjustWindowSize = () => {
        const window = getCurrentWindow();
        const whiteContainer = document.querySelector('.bg-white');
        if (whiteContainer && !showDownloadModal) {
          // Use double requestAnimationFrame to ensure DOM is fully updated
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              // Use scrollWidth/scrollHeight to get the full content size
              const containerWidth = whiteContainer.scrollWidth;
              const containerHeight = whiteContainer.scrollHeight;
              // Limit max width to prevent window from being too wide
              const maxWidth = 600;
              const targetWidth = Math.min(containerWidth, maxWidth);
              // Use setSize to match content area exactly (decorations are disabled)
              window.setSize(new LogicalSize(targetWidth, containerHeight)).catch(console.error);
            });
          });
        }
      };
      adjustWindowSize();
    }, delay);
    
    return () => clearTimeout(timeoutId);
  }, [combinedResults, showDownloadModal]);

    // Adjust window size when results actually change
    useEffect(() => {
      const adjustWindowSize = () => {
        const window = getCurrentWindow();
        const whiteContainer = document.querySelector('.bg-white');
        if (whiteContainer && !showDownloadModal) {
          // Use double requestAnimationFrame to ensure DOM is fully updated
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const containerRect = whiteContainer.getBoundingClientRect();
              const containerWidth = containerRect.width;
              const containerHeight = containerRect.height;
              // Limit max width to prevent window from being too wide
              const maxWidth = 600;
              const targetWidth = Math.min(containerWidth, maxWidth);
              // Use setSize to match content area exactly (decorations are disabled)
              window.setSize(new LogicalSize(targetWidth, containerHeight)).catch(console.error);
            });
          });
        }
      };
      
      // Adjust size after results state updates
      setTimeout(adjustWindowSize, 250);
    }, [results, showDownloadModal]);

  // Scroll selected item into view and adjust window size
  // 只在 selectedIndex 变化时滚动，避免在结果更新时意外滚动
  useEffect(() => {
    // 如果正在保持滚动位置，不要执行 scrollIntoView
    if (shouldPreserveScrollRef.current) {
      return;
    }
    
    if (listRef.current && selectedIndex >= 0 && results.length > 0) {
      const items = listRef.current.children;
      if (items[selectedIndex]) {
        items[selectedIndex].scrollIntoView({
          block: "nearest",
          behavior: "smooth",
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex]); // 只依赖 selectedIndex，避免在结果更新时触发滚动

  const loadApplications = async () => {
    try {
      setIsLoading(true);
      await new Promise<void>((resolve) => {
        setTimeout(async () => {
          try {
            const allApps = await tauriApi.scanApplications();
            setApps(allApps);
            setFilteredApps(allApps.slice(0, 10));
          } catch (error) {
            console.error("Failed to load applications:", error);
            setApps([]);
            setFilteredApps([]);
          } finally {
            setIsLoading(false);
            resolve();
          }
        }, 0);
      });
    } catch (error) {
      console.error("Failed to load applications:", error);
      setApps([]);
      setFilteredApps([]);
      setIsLoading(false);
    }
  };

  const searchApplications = async (searchQuery: string) => {
    try {
      // If apps not loaded yet, load them first
      if (apps.length === 0 && !isLoading) {
        await loadApplications();
      }
      
      const results = await tauriApi.searchApplications(searchQuery);
      setFilteredApps(results);
    } catch (error) {
      console.error("Failed to search applications:", error);
    }
  };

  const searchFileHistory = async (searchQuery: string) => {
    try {
      const results = await tauriApi.searchFileHistory(searchQuery);
      setFilteredFiles(results);
    } catch (error) {
      console.error("Failed to search file history:", error);
    }
  };

  // Use ref to track current search request and allow cancellation
  const currentSearchRef = useRef<{ query: string; cancelled: boolean } | null>(null);

  // 监听 Everything 搜索的批次事件：实时累积结果 + 更新进度（方案 B）
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;

    const setupBatchListener = async () => {
      const unlisten = await listen<{
        results: EverythingResult[];
        total_count: number;
        current_count: number;
      }>("everything-search-batch", (event) => {
        const { results: batchResults, total_count, current_count } = event.payload;

        // 搜索已取消，忽略本批次
        if (currentSearchRef.current?.cancelled) {
          return;
        }

        // 更新总数和当前已加载数量（用于进度显示）
        setEverythingTotalCount(total_count);
        setEverythingCurrentCount(current_count);

        // 累积批次结果，实现真正的流式展示
        setEverythingResults((prev) => {
          // 如果之前已经有完整结果，忽略后续批次
          if (prev.length >= total_count) {
            return prev;
          }

          // 如果这是新搜索的第一批（prev.length === 0），直接用这一批
          if (prev.length === 0) {
            return batchResults.slice(); // 拷贝一份
          }

          // 按顺序追加当前批次结果
          const next = [...prev, ...batchResults];

          // 防止理论误差：如果长度超过 total_count，则截断
          if (next.length > total_count) {
            return next.slice(0, total_count);
          }

          return next;
        });

        // 如果当前显示数量还没初始化，按已加载数量和上限初始化
        setDisplayedResultsCount((prev) => {
          if (prev === 0) {
            return Math.min(current_count, MAX_DISPLAY_RESULTS);
          }
          return prev;
        });
      });

      unlistenFn = unlisten;
    };

    setupBatchListener();

    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, []);

  const searchEverything = async (searchQuery: string) => {
    if (!isEverythingAvailable) {
      setEverythingResults([]);
      setEverythingTotalCount(null);
      setEverythingCurrentCount(0);
      setDisplayedResultsCount(0);
      setIsSearchingEverything(false);
      return;
    }
    
    // 取消上一次搜索
    if (currentSearchRef.current) {
      currentSearchRef.current.cancelled = true;
    }
    
    // 创建新的搜索请求
    const searchRequest = { query: searchQuery, cancelled: false };
    currentSearchRef.current = searchRequest;
    
    // 重置状态，准备新的搜索（结果由批次事件逐步填充）
    setEverythingResults([]);
    setEverythingTotalCount(null);
    setEverythingCurrentCount(0);
    setDisplayedResultsCount(0);
    setIsSearchingEverything(true);
    
    // 标记：最终结果尚未设置，仅用于后面做校验日志
    finalResultsSetRef.current = false;
    
    try {
      console.log("Searching Everything with query (streaming):", searchQuery);
      const response = await tauriApi.searchEverything(searchQuery);
      
      // 检查是否是当前搜索
      if (currentSearchRef.current?.cancelled || currentSearchRef.current?.query !== searchQuery) {
        console.log("Search was cancelled or superseded, ignoring final response");
        return;
      }
      
      // 只做校验：比较批次累积结果与最终结果是否一致
      console.log(
        "[最终结果校验] Everything search results (final):",
        response.results.length,
        "results found (total:",
        response.total_count,
        "), 当前前端 everythingResults.length=",
        everythingResults.length
      );
      
      finalResultsSetRef.current = true;
      
      if (everythingResults.length !== response.total_count) {
        console.warn(
          "[最终结果校验] 累积结果条数与后端 total_count 不一致，累积=",
          everythingResults.length,
          " total_count=",
          response.total_count,
          "（为避免闪烁，暂不强制覆盖，仅输出警告）"
        );
      }
      
      // 如果此时还没有设置显示数量（例如非常快的搜索），初始化一次
      setDisplayedResultsCount((prev) => {
        if (prev === 0) {
          const total = response.total_count ?? everythingResults.length;
          return Math.min(total, MAX_DISPLAY_RESULTS);
        }
        return prev;
      });
    } catch (error) {
      if (currentSearchRef.current?.cancelled || currentSearchRef.current?.query !== searchQuery) {
        console.log("Search was cancelled, ignoring error");
        return;
      }
      
      console.error("Failed to search Everything:", error);
      setEverythingResults([]);
      setEverythingTotalCount(null);
      setEverythingCurrentCount(0);
      setDisplayedResultsCount(0);
      
      // 失败时重查状态
      const errorStr = typeof error === 'string' ? error : String(error);
      if (
        errorStr.includes('NOT_INSTALLED') || 
        errorStr.includes('EXECUTABLE_CORRUPTED') ||
        errorStr.includes('SERVICE_NOT_RUNNING') ||
        errorStr.includes('not found') ||
        errorStr.includes('未找到') ||
        errorStr.includes('未运行')
      ) {
        try {
          const status = await tauriApi.getEverythingStatus();
          setIsEverythingAvailable(status.available);
          setEverythingError(status.error || null);
          
          if (!status.available) {
            console.warn("Everything became unavailable after search failed:", status.error);
          }
        } catch (statusError) {
          console.error("Failed to re-check Everything status:", statusError);
          setIsEverythingAvailable(false);
          setEverythingError("搜索失败后无法重新检查状态");
        }
      }
    } finally {
      // 只有当前仍是本次搜索时才结束 loading 状态
      if (currentSearchRef.current?.query === searchQuery && !currentSearchRef.current?.cancelled) {
        setIsSearchingEverything(false);
      }
    }
  };

  const handleCloseDownloadModal = () => {
    setShowDownloadModal(false);
  };

  const handleStartEverything = async () => {
    try {
      console.log("手动启动 Everything...");
      await tauriApi.startEverything();
      // 等待一下让 Everything 启动并初始化
      await new Promise(resolve => setTimeout(resolve, 2000));
      // 重新检查状态
      await handleCheckAgain();
    } catch (error) {
      console.error("启动 Everything 失败:", error);
      alert(`启动失败: ${error}`);
    }
  };

  const handleDownloadEsExe = async () => {
    try {
      setIsDownloading(true);
      setDownloadProgress(0);
      setDownloadedPath(null);
      setShowDownloadModal(true); // 显示下载进度模态框
      
      const path = await tauriApi.downloadEsExe();
      setDownloadedPath(path);
      setDownloadProgress(100);
      setIsDownloading(false);
      // 下载完成后，自动检测
      await handleCheckAgain();
    } catch (error) {
      console.error("Failed to download es.exe:", error);
      setIsDownloading(false);
      setDownloadProgress(0);
      setShowDownloadModal(false);
      alert(`下载失败: ${error}`);
    }
  };

  const handleCheckAgain = async () => {
    try {
      // Force a fresh check with detailed status
      const status = await tauriApi.getEverythingStatus();
      
      // 如果服务未运行，尝试自动启动
      if (!status.available && status.error === "SERVICE_NOT_RUNNING") {
        try {
          console.log("Everything 服务未运行，尝试自动启动...");
          await tauriApi.startEverything();
          // 等待一下让 Everything 启动并初始化
          await new Promise(resolve => setTimeout(resolve, 2000));
          // 重新检查状态
          const newStatus = await tauriApi.getEverythingStatus();
          setIsEverythingAvailable(newStatus.available);
          setEverythingError(newStatus.error || null);
          
          if (newStatus.available) {
            console.log("Everything 启动成功");
          } else {
            console.warn("Everything 启动后仍未可用:", newStatus.error);
          }
          return;
        } catch (error) {
          console.error("自动启动 Everything 失败:", error);
          setIsEverythingAvailable(false);
          setEverythingError("无法自动启动 Everything，请手动启动");
          return;
        }
      }
      
      setIsEverythingAvailable(status.available);
      setEverythingError(status.error || null);
      
      if (status.available) {
        const path = await tauriApi.getEverythingPath();
        setEverythingPath(path);
        setShowDownloadModal(false);
        if (path) {
          console.log("Everything found at:", path);
        }
      } else {
        // Show helpful message based on error type
        let errorMessage = "Everything 仍未检测到。\n\n";
        if (status.error) {
          if (status.error.startsWith("NOT_INSTALLED")) {
            errorMessage += "es.exe 未找到。\n请点击\"下载 es.exe\"按钮下载并安装。";
          } else if (status.error.startsWith("EXECUTABLE_CORRUPTED")) {
            errorMessage += "es.exe 文件损坏。\n请删除损坏的文件后重新下载。\n\n文件位置：C:\\Program Files\\Everything\\es.exe";
          } else if (status.error.startsWith("SERVICE_NOT_RUNNING")) {
            errorMessage += "Everything 服务未运行。\n已尝试自动启动，如果仍然失败，请手动启动 Everything 主程序后点击\"刷新\"按钮。";
          } else {
            errorMessage += `错误：${status.error}\n\n请确保：\n1. Everything 已正确安装\n2. es.exe 文件存在于 Everything 安装目录中\n3. Everything 主程序正在运行`;
          }
        } else {
          errorMessage += "请确保：\n1. Everything 已正确安装\n2. es.exe 文件存在于 Everything 安装目录中\n3. Everything 主程序正在运行";
        }
        alert(errorMessage);
      }
    } catch (error) {
      console.error("Failed to check Everything:", error);
      alert(`检测失败: ${error}`);
    }
  };

  const handleLaunch = async (result: SearchResult) => {
    try {
      if (result.type === "url" && result.url) {
        await tauriApi.openUrl(result.url);
      } else if (result.type === "app" && result.app) {
        await tauriApi.launchApplication(result.app);
      } else if (result.type === "file" && result.file) {
        await tauriApi.launchFile(result.file.path);
      } else if (result.type === "everything" && result.everything) {
        // Launch Everything result and add to file history
        await tauriApi.launchFile(result.everything.path);
        await tauriApi.addFileToHistory(result.everything.path);
      }
      // Hide launcher window after launch
      await tauriApi.hideLauncher();
      setQuery("");
      setSelectedIndex(0);
    } catch (error) {
      console.error("Failed to launch:", error);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, result: SearchResult) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, result });
  };

  const handleRevealInFolder = async () => {
    if (!contextMenu) return;
    
    try {
      const path = contextMenu.result.path;
      console.log("Revealing in folder:", path);
      // Only reveal for file types (file, everything), not for apps or URLs
      if (contextMenu.result.type === "file" || contextMenu.result.type === "everything") {
        // Use Tauri opener plugin to reveal file in folder
        await revealItemInDir(path);
        console.log("Reveal in folder called successfully");
      }
      setContextMenu(null);
    } catch (error) {
      console.error("Failed to reveal in folder:", error);
      alert(`打开文件夹失败: ${error}`);
      setContextMenu(null);
    }
  };

  // Close context menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setContextMenu(null);
      }
    };

    if (contextMenu) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
        document.removeEventListener("keydown", handleEscape);
      };
    }
  }, [contextMenu]);

  const handlePaste = async (e: React.ClipboardEvent) => {
    const clipboardTypes = Array.from(e.clipboardData.types);
    console.log("Clipboard types:", clipboardTypes);
    
    // Check if clipboard contains files (when copying folders/files in Windows)
    if (clipboardTypes.includes("Files")) {
      e.preventDefault();
      e.stopPropagation();
      
      const files = e.clipboardData.files;
      console.log("Files in clipboard:", files.length);
      
      if (files.length > 0) {
        // Get the first file/folder path
        // Note: In browser, we can't directly get the full path from File object
        // We need to use Tauri's clipboard API or handle it differently
        // For now, let's try to get the path from the file name and use a backend command
        
        // Try to get text representation if available
        let pathText = "";
        try {
          // Some browsers/clipboard implementations might have text representation
          pathText = e.clipboardData.getData("text/uri-list") || 
                     e.clipboardData.getData("text") ||
                     e.clipboardData.getData("text/plain");
        } catch (err) {
          console.log("Could not get text from clipboard:", err);
        }
        
        // If we have a file, we need to get its path from backend
        // Since browser File API doesn't expose full path, we'll need to use Tauri
        // Try to get path from Tauri clipboard API (Windows only)
        if (!pathText) {
          console.log("Getting path from Tauri clipboard API");
          try {
            const clipboardPath = await tauriApi.getClipboardFilePath();
            if (clipboardPath) {
              console.log("Got path from clipboard API:", clipboardPath);
              await processPastedPath(clipboardPath);
              return;
            }
          } catch (error) {
            console.error("Failed to get clipboard file path:", error);
          }
        }
        
        if (pathText) {
          console.log("Processing path from clipboard files:", pathText);
          await processPastedPath(pathText);
        } else {
          console.log("Could not get file path from clipboard");
        }
      }
      return;
    }
    
    // Try to get text from clipboard - Windows may use different formats
    let pastedText = e.clipboardData.getData("text");
    
    // If no text, try text/plain format
    if (!pastedText) {
      pastedText = e.clipboardData.getData("text/plain");
    }
    
    // Handle Windows file paths that might have quotes or be on multiple lines
    if (pastedText) {
      // Remove quotes if present
      pastedText = pastedText.replace(/^["']|["']$/g, '');
      // Take first line if multiple lines
      pastedText = pastedText.split('\n')[0].split('\r')[0];
    }
    
    console.log("Pasted text:", pastedText);
    
    // Check if pasted text looks like a file path
    const isPath = pastedText && pastedText.trim().length > 0 && (
      pastedText.includes("\\") || 
      pastedText.includes("/") || 
      pastedText.match(/^[A-Za-z]:/)
    );
    
    if (isPath) {
      e.preventDefault();
      e.stopPropagation();
      await processPastedPath(pastedText.trim());
    } else {
      console.log("Pasted text doesn't look like a path, allowing default paste behavior");
    }
  };

  const processPastedPath = async (trimmedPath: string) => {
    console.log("Processing path:", trimmedPath);
    
    // Always set the query first so user sees something
    setQuery(trimmedPath);
    
    try {
      // Check if path exists (file or folder)
      console.log("Checking if path exists...");
      const pathItem = await tauriApi.checkPathExists(trimmedPath);
      console.log("Path check result:", pathItem);
      
      if (pathItem) {
        // Path exists, add to history first
        try {
          console.log("Adding to history...");
          await tauriApi.addFileToHistory(trimmedPath);
          // Reload file history to get updated item with use_count
          const searchResults = await tauriApi.searchFileHistory(trimmedPath);
          console.log("Search results:", searchResults);
          if (searchResults.length > 0) {
            setFilteredFiles(searchResults);
          } else {
            // If not found in search, use the item we got from check
            console.log("Using pathItem from check");
            setFilteredFiles([pathItem]);
          }
        } catch (error) {
          // Ignore errors when adding to history, still show the result
          console.error("Failed to add file to history:", error);
          setFilteredFiles([pathItem]);
        }
      } else {
        // Path doesn't exist, search will still run via query change
        console.log("Path doesn't exist, but query is set for search");
      }
    } catch (error) {
      console.error("Failed to check path:", error);
      // Query is already set, search will still run
    }
  };

  // 根据路径粗略判断是否更像“文件夹”
  const isFolderLikePath = (path: string | undefined | null): boolean => {
    if (!path) return false;
    // 去掉末尾的 / 或 \
    const normalized = path.replace(/[\\/]+$/, "");
    const segments = normalized.split(/[\\/]/);
    const last = segments[segments.length - 1] || "";
    if (!last) return false;
    // 如果最后一段里有扩展名（排除以点开头的特殊情况），认为是文件
    const dotIndex = last.indexOf(".");
    if (dotIndex > 0 && dotIndex < last.length - 1) {
      return false;
    }
    return true;
  };

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (e.key === "Escape" || e.keyCode === 27) {
      e.preventDefault();
      e.stopPropagation();
      try {
        await tauriApi.hideLauncher();
        setQuery("");
        setSelectedIndex(0);
      } catch (error) {
        console.error("Failed to hide window:", error);
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        prev < results.length - 1 ? prev + 1 : prev
      );
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : 0));
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (results[selectedIndex]) {
        await handleLaunch(results[selectedIndex]);
      }
      return;
    }
  };

  return (
    <div 
      className="flex flex-col w-full items-center justify-start"
      style={{ 
        backgroundColor: 'transparent',
        margin: 0,
        padding: 0,
        width: '100%',
        minHeight: '100%'
      }}
      tabIndex={-1}
      onMouseDown={async (e) => {
        // Allow dragging from empty areas (not on white container)
        const target = e.target as HTMLElement;
        if (target === e.currentTarget || !target.closest('.bg-white')) {
          const window = getCurrentWindow();
          try {
            await window.startDragging();
          } catch (error) {
            console.error("Failed to start dragging:", error);
          }
        }
      }}
      onKeyDown={async (e) => {
        if (e.key === "Escape" || e.keyCode === 27) {
          e.preventDefault();
          e.stopPropagation();
          try {
            await tauriApi.hideLauncher();
            setQuery("");
            setSelectedIndex(0);
          } catch (error) {
            console.error("Failed to hide window:", error);
          }
        }
      }}
    >
      {/* Main Search Container - utools style */}
      <div className="w-full flex justify-center">
        <div className="bg-white w-full overflow-hidden" style={{ height: 'auto' }}>
          {/* Search Box */}
          <div 
            className="px-6 py-4 border-b border-gray-100"
            onMouseDown={async (e) => {
              // Only start dragging if clicking on the container or search icon, not on input
              const target = e.target as HTMLElement;
              if (target.tagName !== 'INPUT' && !target.closest('input')) {
                const window = getCurrentWindow();
                try {
                  await window.startDragging();
                } catch (error) {
                  console.error("Failed to start dragging:", error);
                }
              }
            }}
            style={{ cursor: 'move' }}
          >
            <div className="flex items-center gap-3">
              <svg
                className="w-5 h-5 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder="输入应用名称或粘贴文件路径..."
                className="flex-1 text-lg border-none outline-none bg-transparent placeholder-gray-400 text-gray-700"
                style={{ cursor: 'text' }}
                autoFocus
                onFocus={(e) => {
                  // Ensure input is focused, but don't select text if user is typing
                  e.target.focus();
                }}
                onMouseDown={(e) => {
                  // Prevent dragging when clicking on input
                  e.stopPropagation();
                }}
              />
              {/* Shortcuts Config Icon Button */}
              <div
                className="relative flex items-center justify-center"
                onMouseEnter={() => setIsHoveringConfigIcon(true)}
                onMouseLeave={() => setIsHoveringConfigIcon(false)}
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    await tauriApi.showShortcutsConfig();
                  } catch (error) {
                    console.error("Failed to show shortcuts config:", error);
                  }
                }}
                onMouseDown={(e) => {
                  // Prevent dragging when clicking on icon
                  e.stopPropagation();
                }}
                style={{ cursor: 'pointer', minWidth: '24px', minHeight: '24px' }}
                title="快捷访问配置"
              >
                <svg
                  className={`w-5 h-5 transition-all ${
                    isHoveringConfigIcon ? 'text-gray-600 opacity-100' : 'text-gray-300 opacity-50'
                  }`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
                  />
                </svg>
              </div>
            </div>
          </div>

          {/* Results List */}
          {results.length > 0 && (
            <div
              ref={listRef}
              className="max-h-96 overflow-y-auto"
              onScroll={(e) => {
                const target = e.currentTarget;
                const scrollTop = target.scrollTop;
                const scrollHeight = target.scrollHeight;
                const clientHeight = target.clientHeight;
                
                // 检测是否滚动到底部（距离底部 50px 内）
                const isNearBottom = scrollHeight - scrollTop - clientHeight < 50;
                
                if (isNearBottom) {
                  // 检查是否有更多 Everything 结果可以加载
                  // 使用 everythingTotalCount 判断总数，而不是依赖当前数组长度，避免中间状态导致无法继续加载
                  const totalCount = everythingTotalCount ?? everythingResults.length;
                  const hasMoreEverythingResults = totalCount > displayedResultsCount;
                  
                  console.log(`[滚动加载] 检查加载更多: totalCount=${totalCount}, displayedResultsCount=${displayedResultsCount}, everythingResults.length=${everythingResults.length}, hasMore=${hasMoreEverythingResults}`);
                  
                  if (hasMoreEverythingResults) {
                    // 标记需要保持滚动位置
                    shouldPreserveScrollRef.current = true;
                    
                    // 加载更多结果（每次增加 500 条）
                    setDisplayedResultsCount((prev) => {
                      const next = prev + MAX_DISPLAY_RESULTS;
                      // 使用 totalCount 和 everythingResults.length 的最小值，确保不超过实际结果数
                      const maxCount = Math.min(totalCount, everythingResults.length || totalCount);
                      const actualNext = Math.min(next, maxCount);
                      console.log(`[滚动加载] 加载更多: ${prev} -> ${actualNext} (max: ${maxCount}, totalCount: ${totalCount}, everythingResults.length: ${everythingResults.length})`);
                      return actualNext;
                    });
                  } else {
                    console.log(`[滚动加载] 没有更多结果可加载: totalCount=${totalCount}, displayedResultsCount=${displayedResultsCount}`);
                  }
                }
              }}
            >
              {results.map((result, index) => (
                <div
                  key={`${result.type}-${result.path}-${index}`}
                  onClick={() => handleLaunch(result)}
                  onContextMenu={(e) => handleContextMenu(e, result)}
                  className={`px-6 py-3 cursor-pointer transition-all ${
                    index === selectedIndex
                      ? "bg-blue-500 text-white"
                      : "hover:bg-gray-50 text-gray-700"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {/* 序号 */}
                    <div className={`text-sm font-medium flex-shrink-0 w-8 text-center ${
                      index === selectedIndex ? "text-white" : "text-gray-400"
                    }`}>
                      {index + 1}
                    </div>
                    <div className={`w-8 h-8 rounded flex items-center justify-center flex-shrink-0 overflow-hidden ${
                      index === selectedIndex ? "bg-blue-400" : "bg-gray-200"
                    }`}>
                      {result.type === "app" && result.app?.icon ? (
                        <img 
                          src={result.app.icon} 
                          alt={result.displayName}
                          className="w-8 h-8 object-contain"
                          style={{ imageRendering: 'auto' as const }}
                          onError={(e) => {
                            // Fallback to default icon if image fails to load
                            const target = e.target as HTMLImageElement;
                            target.style.display = 'none';
                            const parent = target.parentElement;
                            if (parent && !parent.querySelector('svg')) {
                              const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                              svg.setAttribute('class', `w-5 h-5 ${index === selectedIndex ? 'text-white' : 'text-gray-500'}`);
                              svg.setAttribute('fill', 'none');
                              svg.setAttribute('stroke', 'currentColor');
                              svg.setAttribute('viewBox', '0 0 24 24');
                              const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                              path.setAttribute('stroke-linecap', 'round');
                              path.setAttribute('stroke-linejoin', 'round');
                              path.setAttribute('stroke-width', '2');
                              path.setAttribute('d', 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z');
                              svg.appendChild(path);
                              parent.appendChild(svg);
                            }
                          }}
                        />
                      ) : result.type === "url" ? (
                        <svg
                          className={`w-5 h-5 ${
                            index === selectedIndex ? "text-white" : "text-blue-500"
                          }`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                          />
                        </svg>
                      ) : (result.type === "file" &&
                          ((result.file?.is_folder ?? null) !== null
                            ? !!result.file?.is_folder
                            : isFolderLikePath(result.path))) ||
                        (result.type === "everything" &&
                          ((result.everything?.is_folder ?? null) !== null
                            ? !!result.everything?.is_folder
                            : isFolderLikePath(result.path))) ? (
                        // 文件夹（历史记录或 Everything 结果）
                        <svg
                          className={`w-5 h-5 ${
                            index === selectedIndex ? "text-white" : "text-amber-500"
                          }`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M3 7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
                          />
                        </svg>
                      ) : result.type === "file" || result.type === "everything" ? (
                        <svg
                          className={`w-5 h-5 ${
                            index === selectedIndex ? "text-white" : "text-gray-500"
                          }`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                          />
                        </svg>
                      ) : (
                        <svg
                          className={`w-5 h-5 ${
                            index === selectedIndex ? "text-white" : "text-gray-500"
                          }`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{result.displayName}</div>
                      {result.path && (
                        <div
                          className={`text-sm truncate ${
                            index === selectedIndex ? "text-blue-100" : "text-gray-500"
                          }`}
                        >
                          {result.path}
                        </div>
                      )}
                      {result.type === "file" && result.file && (
                        <div
                          className={`text-xs ${
                            index === selectedIndex ? "text-blue-200" : "text-gray-400"
                          }`}
                        >
                          使用 {result.file.use_count} 次
                        </div>
                      )}
                      {result.type === "url" && (
                        <div className="flex items-center gap-2 mt-1">
                          <span
                            className={`text-xs px-2 py-0.5 rounded ${
                              index === selectedIndex
                                ? "bg-blue-400 text-white"
                                : "bg-blue-100 text-blue-700"
                            }`}
                            title="可打开的 URL"
                          >
                            URL
                          </span>
                        </div>
                      )}
                      {result.type === "everything" && (
                        <div className="flex items-center gap-2 mt-1">
                          <span
                            className={`text-xs px-2 py-0.5 rounded ${
                              index === selectedIndex
                                ? "bg-blue-400 text-white"
                                : "bg-green-100 text-green-700"
                            }`}
                            title="来自 Everything 搜索结果"
                          >
                            Everything
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              
              {/* 加载更多提示 - 只在有 Everything 结果且未全部显示时显示 */}
              {everythingResults.length > 0 && everythingResults.length > displayedResultsCount && (
                <div className="px-6 py-4 text-center text-gray-500 text-sm border-t border-gray-100 bg-gray-50">
                  <div className="flex items-center justify-center gap-2">
                    <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                    <span>
                      已显示 {displayedResultsCount.toLocaleString()} / {everythingResults.length.toLocaleString()} 条 Everything 结果
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-gray-400">
                    滚动到底部自动加载更多（每次 {MAX_DISPLAY_RESULTS.toLocaleString()} 条）
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Loading or Empty State */}
          {isLoading && (
            <div className="px-6 py-8 text-center text-gray-500">
              <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-gray-400 mb-2"></div>
              <div>正在扫描应用...</div>
            </div>
          )}

          {!isLoading && results.length === 0 && query && (
            <div className="px-6 py-8 text-center text-gray-500">
              未找到匹配的应用或文件
            </div>
          )}

          {/* Everything Search Status */}
          {query.trim() && isEverythingAvailable && (
            <div className="px-6 py-2 border-t border-gray-200 bg-gray-50">
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-xs text-gray-600">
                  <div className="flex items-center gap-2">
                    {isSearchingEverything ? (
                      <>
                        <div className="inline-block animate-spin rounded-full h-3 w-3 border-b-2 border-blue-500"></div>
                        <span className="text-blue-600">Everything 搜索中...</span>
                      </>
                    ) : (
                      <>
                        <svg className="w-3 h-3 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                        <span>
                          Everything: {everythingTotalCount !== null 
                            ? `找到 ${everythingTotalCount.toLocaleString()} 个结果${everythingTotalCount > displayedResultsCount ? ` (显示 ${displayedResultsCount.toLocaleString()} 条)` : ''}` 
                            : everythingResults.length > 0
                            ? `找到 ${everythingResults.length.toLocaleString()} 个结果${everythingResults.length > displayedResultsCount ? ` (显示 ${displayedResultsCount.toLocaleString()} 条)` : ''}`
                            : "无结果"}
                        </span>
                      </>
                    )}
                  </div>
                  {everythingVersion && (
                    <div className="text-gray-500 text-xs">
                      v{everythingVersion}
                    </div>
                  )}
                </div>
                
                {/* 流式加载进度条 */}
                {isSearchingEverything && everythingTotalCount !== null && everythingTotalCount > 0 && (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between text-xs text-gray-500">
                      <span>
                        已加载 {everythingCurrentCount.toLocaleString()} / {everythingTotalCount.toLocaleString()} 条
                      </span>
                      <span className="font-medium text-blue-600">
                        {Math.round((everythingCurrentCount / everythingTotalCount) * 100)}%
                      </span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-1.5 overflow-hidden">
                      <div
                        className="bg-blue-500 h-1.5 rounded-full transition-all duration-300 ease-out"
                        style={{
                          width: `${Math.min((everythingCurrentCount / everythingTotalCount) * 100, 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {!isLoading && results.length === 0 && !query && (
            <div className="px-6 py-8 text-center text-gray-400 text-sm">
              输入关键词搜索应用，或粘贴文件路径
            </div>
          )}

          {/* Footer */}
          <div className="px-6 py-2 border-t border-gray-100 text-xs text-gray-400 flex justify-between items-center bg-gray-50/50">
            <div className="flex items-center gap-3">
              {results.length > 0 && <span>{results.length} 个结果</span>}
              <div className="flex items-center gap-2">
                <div 
                  className="flex items-center gap-1 cursor-help" 
                  title={everythingPath ? `Everything 路径: ${everythingPath}` : 'Everything 未安装或未在 PATH 中'}
                >
                  <div className={`w-2 h-2 rounded-full ${isEverythingAvailable ? 'bg-green-500' : 'bg-gray-300'}`}></div>
                  <span className={isEverythingAvailable ? 'text-green-600' : 'text-gray-400'}>
                    Everything {isEverythingAvailable ? '已启用' : '未检测到'}
                  </span>
                  {everythingError && !isEverythingAvailable && (
                    <span className="text-xs text-red-500 ml-2" title={everythingError}>
                      ({everythingError.split(':')[0]})
                    </span>
                  )}
                </div>
                {!isEverythingAvailable && (
                  <div className="flex items-center gap-2">
                    {everythingError && everythingError.startsWith("SERVICE_NOT_RUNNING") && (
                      <button
                        onClick={handleStartEverything}
                        className="px-2 py-1 text-xs bg-green-500 text-white rounded hover:bg-green-600 transition-colors"
                        title="启动 Everything"
                      >
                        启动 Everything
                      </button>
                    )}
                    <button
                      onClick={handleCheckAgain}
                      className="px-2 py-1 text-xs bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors"
                      title="重新检测 Everything"
                    >
                      刷新
                    </button>
                    {(!everythingError || everythingError.startsWith("NOT_INSTALLED") || everythingError.startsWith("EXECUTABLE_CORRUPTED")) && (
                      <button
                        onClick={handleDownloadEsExe}
                        disabled={isDownloading}
                        className={`px-2 py-1 text-xs rounded transition-colors ${
                          isDownloading
                            ? 'bg-gray-400 text-white cursor-not-allowed'
                            : 'bg-blue-500 text-white hover:bg-blue-600'
                        }`}
                        title="下载 es.exe（需要先安装 Everything）"
                      >
                        {isDownloading ? `下载中 ${downloadProgress}%` : '下载 es.exe'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
            {results.length > 0 && (
              <span>↑↓ 选择 · Enter 打开 · Esc 关闭</span>
            )}
          </div>
        </div>
      </div>

      {/* Download Modal */}
      {showDownloadModal && (
        <div 
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 overflow-auto"
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }}
          onClick={handleCloseDownloadModal}
        >
          <div 
            className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4 my-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-800">下载 Everything</h3>
              <button
                onClick={handleCloseDownloadModal}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none"
                style={{ fontSize: '24px', lineHeight: '1' }}
              >
                ×
              </button>
            </div>
            
            <div className="space-y-4">
              {isDownloading ? (
                <div className="space-y-3">
                  <div className="text-sm text-gray-600">
                    <p className="mb-2">正在下载 es.exe...</p>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
                    <div
                      className="bg-blue-500 h-full transition-all duration-300"
                      style={{ width: `${downloadProgress}%` }}
                    ></div>
                  </div>
                  <div className="text-center text-sm text-gray-500">
                    {downloadProgress}%
                  </div>
                </div>
              ) : downloadedPath ? (
                <div className="space-y-3">
                  <div className="text-sm text-gray-600">
                    <p className="mb-2">✅ es.exe 下载完成！</p>
                    <p className="mb-2 text-xs text-gray-500 break-all">
                      保存位置：{downloadedPath}
                    </p>
                    <p className="mb-2">es.exe 已自动放置到 Everything 安装目录中。</p>
                    <p className="mb-2">如果 Everything 已启用，现在应该可以正常使用文件搜索功能了。</p>
                  </div>
                  
                  <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm text-blue-800">
                    <p className="font-medium mb-1">💡 提示：</p>
                    <p>如果 Everything 仍未检测到，请点击"重新检测"按钮。</p>
                  </div>
                  
                  <div className="flex flex-wrap gap-2 justify-end">
                    <button
                      onClick={handleCloseDownloadModal}
                      className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded transition-colors whitespace-nowrap"
                    >
                      关闭
                    </button>
                    <button
                      onClick={handleCheckAgain}
                      className="px-4 py-2 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors whitespace-nowrap"
                    >
                      重新检测
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed bg-gray-800 text-white rounded-lg shadow-xl py-1 min-w-[160px] z-50"
          style={{
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
          }}
        >
          {(contextMenu.result.type === "file" || contextMenu.result.type === "everything") && (
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleRevealInFolder();
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              className="w-full text-left px-4 py-2 text-sm hover:bg-gray-700 transition-colors"
            >
              打开所在文件夹
            </button>
          )}
        </div>
      )}
    </div>
  );
}
