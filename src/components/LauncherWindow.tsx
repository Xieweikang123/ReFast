import { useState, useEffect, useRef, useMemo } from "react";
import { tauriApi } from "../api/tauri";
import type { AppInfo, FileHistoryItem, EverythingResult, MemoItem, PluginContext, SystemFolderItem } from "../types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { plugins, searchPlugins, executePlugin } from "../plugins";

type SearchResult = {
  type: "app" | "file" | "everything" | "url" | "memo" | "plugin" | "system_folder" | "history";
  app?: AppInfo;
  file?: FileHistoryItem;
  everything?: EverythingResult;
  url?: string;
  memo?: MemoItem;
  plugin?: { id: string; name: string; description?: string };
  systemFolder?: SystemFolderItem;
  displayName: string;
  path: string;
};

export function LauncherWindow() {
  const [query, setQuery] = useState("");
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [filteredApps, setFilteredApps] = useState<AppInfo[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<FileHistoryItem[]>([]);
  const [memos, setMemos] = useState<MemoItem[]>([]);
  const [filteredMemos, setFilteredMemos] = useState<MemoItem[]>([]);
  const [everythingResults, setEverythingResults] = useState<EverythingResult[]>([]);
  const [everythingTotalCount, setEverythingTotalCount] = useState<number | null>(null);
  const [everythingCurrentCount, setEverythingCurrentCount] = useState<number>(0); // 当前已加载的数量
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
  const [isHoveringAiIcon, setIsHoveringAiIcon] = useState(false);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [ollamaSettings, setOllamaSettings] = useState<{ model: string; base_url: string }>({
    model: "llama2",
    base_url: "http://localhost:11434",
  });
  const [detectedUrls, setDetectedUrls] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; result: SearchResult } | null>(null);
  const [selectedMemo, setSelectedMemo] = useState<MemoItem | null>(null);
  const [isMemoModalOpen, setIsMemoModalOpen] = useState(false);
  const [memoEditTitle, setMemoEditTitle] = useState("");
  const [memoEditContent, setMemoEditContent] = useState("");
  const [isEditingMemo, setIsEditingMemo] = useState(false);
  // 备忘录中心当前是否为“列表模式”（true=列表，false=单条查看/编辑）
  const [isMemoListMode, setIsMemoListMode] = useState(true);
  const [filteredPlugins, setFilteredPlugins] = useState<Array<{ id: string; name: string; description?: string }>>([]);
  const [isPluginListModalOpen, setIsPluginListModalOpen] = useState(false);
  const [systemFolders, setSystemFolders] = useState<SystemFolderItem[]>([]);
  const [openHistory, setOpenHistory] = useState<Record<string, number>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  // 记录备忘录弹窗是否打开，用于全局 ESC 处理时优先关闭备忘录，而不是隐藏整个窗口
  const isMemoModalOpenRef = useRef(false);
  // 记录插件列表弹窗是否打开，用于全局 ESC 处理时优先关闭插件列表，而不是隐藏整个窗口
  const isPluginListModalOpenRef = useRef(false);
  const shouldPreserveScrollRef = useRef(false); // 标记是否需要保持滚动位置
  const finalResultsSetRef = useRef(false); // 方案 B 中仅用于调试/校验，不再阻止批次更新
  const incrementalLoadRef = useRef<number | null>(null); // 用于取消增量加载

  useEffect(() => {
    isMemoModalOpenRef.current = isMemoModalOpen;
  }, [isMemoModalOpen]);

  useEffect(() => {
    isPluginListModalOpenRef.current = isPluginListModalOpen;
  }, [isPluginListModalOpen]);

  // 重置备忘录相关状态的辅助函数
  const resetMemoState = () => {
    setIsMemoModalOpen(false);
    setIsMemoListMode(true);
    setSelectedMemo(null);
    setMemoEditTitle("");
    setMemoEditContent("");
    setIsEditingMemo(false);
  };

  // 插件列表已从 plugins/index.ts 导入

  // Load settings on mount and reload when settings window closes
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await tauriApi.getSettings();
        setOllamaSettings(settings.ollama);
      } catch (error) {
        console.error("Failed to load settings:", error);
      }
    };
    loadSettings();

    // 监听设置窗口关闭事件，重新加载设置
    const unlisten = listen("settings:updated", () => {
      loadSettings();
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

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

  // Load all memos on mount (for quick search)
  useEffect(() => {
    const loadMemos = async () => {
      try {
        const list = await tauriApi.getAllMemos();
        setMemos(list);
      } catch (error) {
        console.error("Failed to load memos:", error);
      }
    };
    loadMemos();
  }, []);

  // Load open history on mount
  useEffect(() => {
    const loadOpenHistory = async () => {
      try {
        const history = await tauriApi.getOpenHistory();
        setOpenHistory(history);
      } catch (error) {
        console.error("Failed to load open history:", error);
      }
    };
    loadOpenHistory();
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

  // Adjust window size when memo modal is shown
  useEffect(() => {
    if (!isMemoModalOpen) return;

    const adjustWindowForMemoModal = () => {
      const window = getCurrentWindow();
      
      // 当显示模态框时，设置窗口大小并居中，让插件像独立软件一样运行
      const targetWidth = 700; // 固定宽度
      const targetHeight = 700; // 固定高度，确保模态框完全可见
      
      window.setSize(new LogicalSize(targetWidth, targetHeight)).catch(console.error);
      window.center().catch(console.error);
    };

    // Wait for modal to render, use double requestAnimationFrame for accurate measurement
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(adjustWindowForMemoModal, 50);
      });
    });
  }, [isMemoModalOpen, isMemoListMode, selectedMemo, isEditingMemo]);

  // Adjust window size when plugin list modal is shown
  useEffect(() => {
    if (!isPluginListModalOpen) return;

    const adjustWindowForPluginListModal = () => {
      const window = getCurrentWindow();
      
      // 当显示模态框时，设置窗口大小并居中，让插件像独立软件一样运行
      const targetWidth = 700; // 固定宽度
      
      // Calculate height based on number of plugins
      // Each plugin card is approximately 120-150px tall (including padding and margins)
      // Add header (60px) + padding (32px) + some extra space
      const pluginCount = plugins.length;
      const estimatedPluginHeight = 140; // Estimated height per plugin card
      const headerHeight = 60;
      const padding = 32;
      const minHeight = 400;
      const maxHeight = 800;
      const calculatedHeight = headerHeight + padding + (pluginCount * estimatedPluginHeight) + padding;
      const targetHeight = Math.max(minHeight, Math.min(calculatedHeight, maxHeight));
      
      window.setSize(new LogicalSize(targetWidth, targetHeight)).catch(console.error);
      window.center().catch(console.error);
    };

    // Wait for modal to render, use double requestAnimationFrame for accurate measurement
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(adjustWindowForPluginListModal, 50);
      });
    });
  }, [isPluginListModalOpen]);

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
        // 如果插件列表弹窗已打开，关闭插件列表并隐藏窗口（插件像独立软件一样运行）
        if (isPluginListModalOpenRef.current) {
          setIsPluginListModalOpen(false);
          // 延迟隐藏窗口，让关闭动画完成
          setTimeout(async () => {
            try {
              await tauriApi.hideLauncher();
            } catch (error) {
              console.error("Failed to hide window:", error);
            }
          }, 100);
          return;
        }
        // 如果备忘录弹窗已打开，关闭备忘录并隐藏窗口（插件像独立软件一样运行）
        if (isMemoModalOpenRef.current) {
          resetMemoState();
          // 延迟隐藏窗口，让关闭动画完成
          setTimeout(async () => {
            try {
              await tauriApi.hideLauncher();
            } catch (error) {
              console.error("Failed to hide window:", error);
            }
          }, 100);
          return;
        }
        try {
          await tauriApi.hideLauncher();
          setQuery("");
          setSelectedIndex(0);
          // 重置备忘录相关状态
          resetMemoState();
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

  // Call Ollama API to ask AI
  const askOllama = async (prompt: string) => {
    if (!prompt.trim()) {
      return;
    }

    setIsAiLoading(true);
    try {
      const baseUrl = ollamaSettings.base_url || 'http://localhost:11434';
      const model = ollamaSettings.model || 'llama2';
      
      // 尝试使用 chat API (更现代的方式)
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
          stream: false,
        }),
      });

      if (!response.ok) {
        // 如果chat API失败，尝试使用generate API作为后备
        const generateResponse = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: model,
            prompt: prompt,
            stream: false,
          }),
        });

        if (!generateResponse.ok) {
          throw new Error(`Ollama API error: ${generateResponse.statusText}`);
        }

        const generateData = await generateResponse.json();
        const answer = generateData.response || '未收到响应';
        setQuery(answer);
        console.log('AI回答:', answer);
        return;
      }

      const data = await response.json();
      const answer = data.message?.content || data.response || '未收到响应';
      
      // 将AI的回答设置到搜索框中
      setQuery(answer);
      
      console.log('AI回答:', answer);
    } catch (error: any) {
      console.error('调用Ollama API失败:', error);
      // 显示错误提示
      const errorMessage = error.message || '未知错误';
      const baseUrl = ollamaSettings.base_url || 'http://localhost:11434';
      const model = ollamaSettings.model || 'llama2';
      alert(`调用AI失败: ${errorMessage}\n\n请确保:\n1. Ollama服务正在运行\n2. 已安装模型 (例如: ollama pull ${model})\n3. 服务地址为 ${baseUrl}`);
    } finally {
      setIsAiLoading(false);
    }
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
      setFilteredMemos([]);
      setFilteredPlugins([]);
      setSystemFolders([]);
      setEverythingResults([]);
      setEverythingTotalCount(null);
      setEverythingCurrentCount(0);
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
      searchMemos(query);
      handleSearchPlugins(query);
      searchSystemFolders(query);
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

  const searchMemos = async (q: string) => {
    try {
      // Don't search if query is empty
      if (!q || q.trim() === "") {
        setFilteredMemos([]);
        return;
      }
      
      // 简单策略：前端过滤本地 memos，如果需要更复杂的可以调用后端 search_memos
      const lower = q.toLowerCase();
      const filtered = memos.filter(
        (m) =>
          m.title.toLowerCase().includes(lower) ||
          m.content.toLowerCase().includes(lower)
      );
      
      // Only update if query hasn't changed
      if (query.trim() === q.trim()) {
        setFilteredMemos(filtered);
      } else {
        setFilteredMemos([]);
      }
    } catch (error) {
      console.error("Failed to search memos:", error);
      if (!q || q.trim() === "") {
        setFilteredMemos([]);
      }
    }
  };

  const handleSearchPlugins = (q: string) => {
    // Don't search if query is empty
    if (!q || q.trim() === "") {
      setFilteredPlugins([]);
      return;
    }
    
    const filtered = searchPlugins(q);
    
    // Only update if query hasn't changed
    if (query.trim() === q.trim()) {
      setFilteredPlugins(filtered.map(p => ({ id: p.id, name: p.name, description: p.description })));
    } else {
      setFilteredPlugins([]);
    }
  };

  // Combine apps, files, Everything results, and URLs into results when they change
  // 使用 useMemo 优化，避免不必要的重新计算
  const combinedResults = useMemo(() => {
    // 如果查询为空，直接返回空数组，不显示任何结果
    if (query.trim() === "") {
      return [];
    }
    
    const urlResults: SearchResult[] = detectedUrls.map((url) => ({
      type: "url" as const,
      url,
      displayName: url,
      path: url,
    }));
    
    // 检查是否应该显示"历史访问"结果（只在明确搜索相关关键词时显示）
    const lowerQuery = query.toLowerCase().trim();
    const historyKeywords = ["历史访问", "历史", "访问历史", "ls", "history"];
    const shouldShowHistory = historyKeywords.some(keyword => 
      lowerQuery.includes(keyword.toLowerCase()) || keyword.toLowerCase().includes(lowerQuery)
    );
    
    const otherResults: SearchResult[] = [
      // 如果查询匹配历史访问关键词，添加历史访问结果
      ...(shouldShowHistory ? [{
        type: "history" as const,
        displayName: "历史访问",
        path: "history://shortcuts-config",
      }] : []),
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
      ...filteredMemos.map((memo) => ({
        type: "memo" as const,
        memo,
        displayName: memo.title || memo.content.slice(0, 50),
        path: memo.id,
      })),
      ...filteredPlugins.map((plugin) => ({
        type: "plugin" as const,
        plugin,
        displayName: plugin.name,
        path: plugin.id,
      })),
      // 显示系统文件夹结果
      ...systemFolders.map((folder) => ({
        type: "system_folder" as const,
        systemFolder: folder,
        displayName: folder.display_name,
        path: folder.path,
      })),
      // 显示所有 Everything 结果
      ...everythingResults.map((everything) => ({
        type: "everything" as const,
        everything,
        displayName: everything.name,
        path: everything.path,
      })),
    ];
    
    // Sort other results by last opened time (most recent first)
    // Items with no history will be sorted after items with history
    otherResults.sort((a, b) => {
      const aTime = openHistory[a.path] || 0;
      const bTime = openHistory[b.path] || 0;
      // Most recent first (descending order)
      return bTime - aTime;
    });
    
    // URLs always come first, then other results sorted by open history
    return [...urlResults, ...otherResults];
  }, [filteredApps, filteredFiles, filteredMemos, filteredPlugins, systemFolders, everythingResults, detectedUrls, openHistory, query]);

  // 使用 ref 来跟踪当前的 query，避免闭包问题
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  // 分批加载结果的函数
  const loadResultsIncrementally = (allResults: SearchResult[]) => {
    // 取消之前的增量加载
    if (incrementalLoadRef.current !== null) {
      cancelAnimationFrame(incrementalLoadRef.current);
      incrementalLoadRef.current = null;
    }

    // 如果 query 为空，直接清空结果并返回
    if (queryRef.current.trim() === "") {
      setResults([]);
      return;
    }

    const INITIAL_COUNT = 100; // 初始显示100条
    const INCREMENT = 50; // 每次增加50条
    const DELAY_MS = 16; // 每帧延迟（约60fps）

    // 重置显示数量（但先检查 query 是否仍然有效）
    if (queryRef.current.trim() !== "") {
      setResults(allResults.slice(0, INITIAL_COUNT));
    } else {
      setResults([]);
      return;
    }

    // 如果结果数量少于初始数量，直接返回
    if (allResults.length <= INITIAL_COUNT) {
      if (queryRef.current.trim() !== "") {
        setResults(allResults);
      } else {
        setResults([]);
      }
      return;
    }

    // 逐步加载更多结果
    let currentCount = INITIAL_COUNT;
    const loadMore = () => {
      // 在每次更新前检查 query 是否为空（使用 ref 获取最新值）
      if (queryRef.current.trim() === "") {
        setResults([]);
        incrementalLoadRef.current = null;
        return;
      }

      if (currentCount < allResults.length) {
        currentCount = Math.min(currentCount + INCREMENT, allResults.length);
        
        // 再次检查 query（防止在异步操作期间被清空）
        if (queryRef.current.trim() !== "") {
          setResults(allResults.slice(0, currentCount));
        } else {
          setResults([]);
          incrementalLoadRef.current = null;
          return;
        }
        
        if (currentCount < allResults.length) {
          incrementalLoadRef.current = requestAnimationFrame(() => {
            setTimeout(loadMore, DELAY_MS);
          });
        } else {
          incrementalLoadRef.current = null;
        }
      } else {
        incrementalLoadRef.current = null;
      }
    };

    // 开始增量加载
    incrementalLoadRef.current = requestAnimationFrame(() => {
      setTimeout(loadMore, DELAY_MS);
    });
  };

  useEffect(() => {
    // 如果查询为空，直接清空结果
    if (query.trim() === "") {
      setResults([]);
      if (incrementalLoadRef.current !== null) {
        cancelAnimationFrame(incrementalLoadRef.current);
        incrementalLoadRef.current = null;
      }
      return;
    }
    
    // 使用分批加载来更新结果，避免一次性渲染大量DOM导致卡顿
    loadResultsIncrementally(combinedResults);
    
    // 清理函数：取消增量加载
    return () => {
      if (incrementalLoadRef.current !== null) {
        cancelAnimationFrame(incrementalLoadRef.current);
        incrementalLoadRef.current = null;
      }
    };
  }, [combinedResults, query]);

  useEffect(() => {
    // 保存当前滚动位置（如果需要保持）
    const needPreserveScroll = shouldPreserveScrollRef.current;
    const savedScrollTop = needPreserveScroll && listRef.current 
      ? listRef.current.scrollTop 
      : null;
    const savedScrollHeight = needPreserveScroll && listRef.current
      ? listRef.current.scrollHeight
      : null;
    
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
    // 如果备忘录模态框打开，不在这里调整窗口大小（由专门的 useEffect 处理）
    if (isMemoModalOpen || showDownloadModal) {
      return;
    }
    
    const delay = needPreserveScroll ? 600 : 100; // 减少延迟，让响应更快
    const timeoutId = setTimeout(() => {
      const adjustWindowSize = () => {
        const window = getCurrentWindow();
        const whiteContainer = document.querySelector('.bg-white');
        if (whiteContainer && !showDownloadModal && !isMemoModalOpen) {
          // Use double requestAnimationFrame to ensure DOM is fully updated
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              // Use scrollWidth/scrollHeight to get the full content size
              const containerWidth = whiteContainer.scrollWidth;
              const containerHeight = whiteContainer.scrollHeight;
              // Limit max width to prevent window from being too wide
              const maxWidth = 600;
              const targetWidth = Math.min(containerWidth, maxWidth);
              
              // 限制最大高度，避免窗口突然撑高导致不丝滑
              const MAX_HEIGHT = 600; // 最大高度600px
              const MIN_HEIGHT = 80; // 最小高度80px
              const targetHeight = Math.max(MIN_HEIGHT, Math.min(containerHeight, MAX_HEIGHT));
              
              // 直接设置窗口大小（简化版本，不使用动画过渡以避免复杂性）
              window.setSize(new LogicalSize(targetWidth, targetHeight)).catch(console.error);
            });
          });
        }
      };
      adjustWindowSize();
    }, delay);
    
    return () => clearTimeout(timeoutId);
  }, [combinedResults, showDownloadModal, isMemoModalOpen]);

    // Adjust window size when results actually change
    useEffect(() => {
      // 如果备忘录模态框或下载模态框打开，不在这里调整窗口大小
      if (isMemoModalOpen || showDownloadModal) {
        return;
      }
      
      const adjustWindowSize = () => {
        const window = getCurrentWindow();
        const whiteContainer = document.querySelector('.bg-white');
        if (whiteContainer && !showDownloadModal && !isMemoModalOpen) {
          // Use double requestAnimationFrame to ensure DOM is fully updated
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const containerRect = whiteContainer.getBoundingClientRect();
              const containerWidth = containerRect.width;
              const containerHeight = containerRect.height;
              // Limit max width to prevent window from being too wide
              const maxWidth = 600;
              const targetWidth = Math.min(containerWidth, maxWidth);
              
              // 限制最大高度，避免窗口突然撑高导致不丝滑
              const MAX_HEIGHT = 600; // 最大高度600px
              const MIN_HEIGHT = 80; // 最小高度80px
              const targetHeight = Math.max(MIN_HEIGHT, Math.min(containerHeight, MAX_HEIGHT));
              
              // 直接设置窗口大小（简化版本，不使用动画过渡以避免复杂性）
              window.setSize(new LogicalSize(targetWidth, targetHeight)).catch(console.error);
            });
          });
        }
      };
      
      // Adjust size after results state updates (减少延迟)
      setTimeout(adjustWindowSize, 100);
    }, [results, showDownloadModal, isMemoModalOpen]);

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

  const loadApplications = async (forceRescan: boolean = false) => {
    try {
      setIsLoading(true);
      await new Promise<void>((resolve) => {
        setTimeout(async () => {
          try {
            const allApps = forceRescan 
              ? await tauriApi.rescanApplications()
              : await tauriApi.scanApplications();
            console.log(`[DEBUG] Loaded ${allApps.length} applications, forceRescan=${forceRescan}`);
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

  const rescanApplications = async () => {
    await loadApplications(true);
  };

  const searchApplications = async (searchQuery: string) => {
    try {
      // Don't search if query is empty
      if (!searchQuery || searchQuery.trim() === "") {
        setFilteredApps([]);
        return;
      }
      
      // If apps not loaded yet, load them first
      if (apps.length === 0 && !isLoading) {
        await loadApplications();
      }
      
      // Double check query is still valid after async operations
      if (!searchQuery || searchQuery.trim() === "") {
        setFilteredApps([]);
        return;
      }
      
      const results = await tauriApi.searchApplications(searchQuery);
      
      // Final check: only update if query hasn't changed
      if (query.trim() === searchQuery.trim()) {
        setFilteredApps(results);
      } else {
        // Query changed during search, ignore results
        setFilteredApps([]);
      }
    } catch (error) {
      console.error("Failed to search applications:", error);
      // Only clear on error if query is empty
      if (!searchQuery || searchQuery.trim() === "") {
        setFilteredApps([]);
      }
    }
  };

  const searchFileHistory = async (searchQuery: string) => {
    try {
      // Don't search if query is empty
      if (!searchQuery || searchQuery.trim() === "") {
        setFilteredFiles([]);
        return;
      }
      
      const results = await tauriApi.searchFileHistory(searchQuery);
      
      // Only update if query hasn't changed
      if (query.trim() === searchQuery.trim()) {
        setFilteredFiles(results);
      } else {
        setFilteredFiles([]);
      }
    } catch (error) {
      console.error("Failed to search file history:", error);
      if (!searchQuery || searchQuery.trim() === "") {
        setFilteredFiles([]);
      }
    }
  };

  const searchSystemFolders = async (searchQuery: string) => {
    try {
      // Don't search if query is empty
      if (!searchQuery || searchQuery.trim() === "") {
        setSystemFolders([]);
        return;
      }
      
      console.log("[前端] searchSystemFolders called with query:", searchQuery);
      const results = await tauriApi.searchSystemFolders(searchQuery);
      console.log("[前端] searchSystemFolders returned results:", results);
      
      // Only update if query hasn't changed
      if (query.trim() === searchQuery.trim()) {
        setSystemFolders(results);
      } else {
        setSystemFolders([]);
      }
    } catch (error) {
      console.error("Failed to search system folders:", error);
      if (!searchQuery || searchQuery.trim() === "") {
        setSystemFolders([]);
      }
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

        // 如果当前 query 为空，忽略批次结果（防止在清空搜索后仍显示结果）
        // 使用函数式更新来获取最新的 query 值
        setEverythingResults((prev) => {
          // 检查当前 query 是否为空（通过检查 currentSearchRef）
          if (!currentSearchRef.current || currentSearchRef.current.cancelled) {
            return prev; // 保持当前状态，不更新
          }
          
          // 如果这是新搜索的第一批（prev.length === 0），直接用这一批
          if (prev.length === 0) {
            return batchResults.slice(); // 拷贝一份
          }

          // 按顺序追加当前批次结果
          // 不限制数量，因为最终结果会在 searchEverything 的最终响应中覆盖
          return [...prev, ...batchResults];
        });

        // 只有在搜索未取消时才更新总数和当前已加载数量
        if (currentSearchRef.current && !currentSearchRef.current.cancelled) {
          setEverythingTotalCount(total_count);
          setEverythingCurrentCount(current_count);
        }

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
    // Don't search if query is empty
    if (!searchQuery || searchQuery.trim() === "") {
      setEverythingResults([]);
      setEverythingTotalCount(null);
      setEverythingCurrentCount(0);
      setIsSearchingEverything(false);
      // 取消当前搜索
      if (currentSearchRef.current) {
        currentSearchRef.current.cancelled = true;
        currentSearchRef.current = null;
      }
      return;
    }
    
    if (!isEverythingAvailable) {
      setEverythingResults([]);
      setEverythingTotalCount(null);
      setEverythingCurrentCount(0);
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
    setIsSearchingEverything(true);
    
    // 标记：最终结果尚未设置，仅用于后面做校验日志
    finalResultsSetRef.current = false;
    
    try {
      console.log("Searching Everything with query (streaming):", searchQuery);
      const response = await tauriApi.searchEverything(searchQuery);
      
      // 检查是否是当前搜索，以及 query 是否仍然有效
      if (currentSearchRef.current?.cancelled || 
          currentSearchRef.current?.query !== searchQuery ||
          query.trim() !== searchQuery.trim()) {
        console.log("Search was cancelled or superseded, ignoring final response");
        return;
      }
      
      // 使用最终结果覆盖批次累积的结果，确保结果数量准确
      console.log(
        "[最终结果] Everything search results (final):",
        response.results.length,
        "results found (total_count:",
        response.total_count,
        "), 批次累积结果数=",
        everythingResults.length
      );
      
      // 再次检查 query 是否仍然有效（防止在异步操作期间 query 被清空）
      if (query.trim() === searchQuery.trim() && 
          currentSearchRef.current && 
          !currentSearchRef.current.cancelled &&
          currentSearchRef.current.query === searchQuery) {
        // 用最终结果覆盖批次累积的结果，因为最终结果才是后端实际返回的准确结果
        // 批次事件中的 total_count 是 Everything 找到的总数，可能远大于后端实际返回的结果数
        setEverythingResults(response.results);
        setEverythingTotalCount(response.total_count);
        setEverythingCurrentCount(response.results.length);
      } else {
        // Query 已改变，清空结果
        setEverythingResults([]);
        setEverythingTotalCount(null);
        setEverythingCurrentCount(0);
      }
      
      finalResultsSetRef.current = true;
    } catch (error) {
      if (currentSearchRef.current?.cancelled || currentSearchRef.current?.query !== searchQuery) {
        console.log("Search was cancelled, ignoring error");
        return;
      }
      
      console.error("Failed to search Everything:", error);
      setEverythingResults([]);
      setEverythingTotalCount(null);
      setEverythingCurrentCount(0);
      
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
      // Record open history for all types
      try {
        await tauriApi.recordOpenHistory(result.path);
        // Update local state immediately for better UX
        setOpenHistory(prev => ({
          ...prev,
          [result.path]: Date.now() / 1000, // Convert to seconds to match backend
        }));
      } catch (error) {
        console.error("Failed to record open history:", error);
      }

      if (result.type === "url" && result.url) {
        await tauriApi.openUrl(result.url);
      } else if (result.type === "history") {
        // 打开历史访问窗口
        await tauriApi.showShortcutsConfig();
        // 不关闭启动器，让用户查看历史访问
        return;
      } else if (result.type === "app" && result.app) {
        await tauriApi.launchApplication(result.app);
      } else if (result.type === "file" && result.file) {
        await tauriApi.launchFile(result.file.path);
      } else if (result.type === "everything" && result.everything) {
        // Launch Everything result and add to file history
        await tauriApi.launchFile(result.everything.path);
        await tauriApi.addFileToHistory(result.everything.path);
      } else if (result.type === "system_folder" && result.systemFolder) {
        // Launch system folder
        await tauriApi.launchFile(result.systemFolder.path);
        await tauriApi.addFileToHistory(result.systemFolder.path);
      } else if (result.type === "memo" && result.memo) {
        // 打开备忘录详情弹窗（单条模式）
        setIsMemoListMode(false);
        setSelectedMemo(result.memo);
        setMemoEditTitle(result.memo.title);
        setMemoEditContent(result.memo.content);
        setIsEditingMemo(false);
        setIsMemoModalOpen(true);
        // 不关闭启动器，让用户查看/编辑备忘录
        return;
      } else if (result.type === "plugin" && result.plugin) {
        // 使用插件系统执行插件
        const pluginContext: PluginContext = {
          setQuery,
          setSelectedIndex,
          hideLauncher: async () => {
            await tauriApi.hideLauncher();
          },
          setIsMemoModalOpen,
          setIsMemoListMode,
          setSelectedMemo,
          setMemoEditTitle,
          setMemoEditContent,
          setIsEditingMemo,
          setIsPluginListModalOpen,
          tauriApi,
        };
        
        await executePlugin(result.plugin.id, pluginContext);
        // 插件执行后清理状态
        setQuery("");
        setSelectedIndex(0);
        return;
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
    // 计算菜单位置，避免遮挡文字
    // 如果右键位置在窗口右侧，将菜单显示在鼠标左侧
    const windowWidth = window.innerWidth;
    const menuWidth = 160; // min-w-[160px]
    let x = e.clientX;
    let y = e.clientY;
    
    // 如果菜单会超出右边界，调整到左侧
    if (x + menuWidth > windowWidth) {
      x = e.clientX - menuWidth;
    }
    
    // 如果菜单会超出下边界，调整到上方
    const menuHeight = 50; // 估算高度
    if (y + menuHeight > window.innerHeight) {
      y = e.clientY - menuHeight;
    }
    
    setContextMenu({ x, y, result });
  };

  const handleRevealInFolder = async () => {
    if (!contextMenu) return;
    
    try {
      const target = contextMenu.result;
      const path = target.path;
      console.log("Revealing in folder:", path);
      // 为应用、文件和 Everything 结果都提供“打开所在文件夹”
      if (
        target.type === "file" ||
        target.type === "everything" ||
        target.type === "app"
      ) {
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
      // 如果插件列表弹窗已打开，关闭插件列表并隐藏窗口（插件像独立软件一样运行）
      if (isPluginListModalOpen) {
        setIsPluginListModalOpen(false);
        // 延迟隐藏窗口，让关闭动画完成
        setTimeout(async () => {
          try {
            await tauriApi.hideLauncher();
          } catch (error) {
            console.error("Failed to hide window:", error);
          }
        }, 100);
        return;
      }
      // 如果备忘录弹窗已打开，关闭备忘录并隐藏窗口（插件像独立软件一样运行）
      if (isMemoModalOpen) {
        resetMemoState();
        // 延迟隐藏窗口，让关闭动画完成
        setTimeout(async () => {
          try {
            await tauriApi.hideLauncher();
          } catch (error) {
            console.error("Failed to hide window:", error);
          }
        }, 100);
        return;
      }
      try {
        await tauriApi.hideLauncher();
        setQuery("");
        setSelectedIndex(0);
        // 重置备忘录相关状态
        resetMemoState();
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
          // 如果插件列表弹窗已打开，关闭插件列表并隐藏窗口（插件像独立软件一样运行）
          if (isPluginListModalOpen) {
            setIsPluginListModalOpen(false);
            // 延迟隐藏窗口，让关闭动画完成
            setTimeout(async () => {
              try {
                await tauriApi.hideLauncher();
              } catch (error) {
                console.error("Failed to hide window:", error);
              }
            }, 100);
            return;
          }
          // 如果备忘录弹窗已打开，关闭备忘录并隐藏窗口（插件像独立软件一样运行）
          if (isMemoModalOpen) {
            resetMemoState();
            // 延迟隐藏窗口，让关闭动画完成
            setTimeout(async () => {
              try {
                await tauriApi.hideLauncher();
              } catch (error) {
                console.error("Failed to hide window:", error);
              }
            }, 100);
            return;
          }
          try {
            await tauriApi.hideLauncher();
            setQuery("");
            setSelectedIndex(0);
            // 重置备忘录相关状态
            resetMemoState();
          } catch (error) {
            console.error("Failed to hide window:", error);
          }
        }
      }}
    >
      {/* Main Search Container - utools style */}
      {/* 当显示插件模态框时，隐藏搜索界面 */}
      {!(isMemoModalOpen || isPluginListModalOpen) && (
      <div className="w-full flex justify-center">
        <div className="bg-white w-full flex flex-col rounded-lg shadow-xl" style={{ minHeight: '80px' }}>
          {/* Search Box */}
          <div 
            className="px-6 py-4 border-b border-gray-100 flex-shrink-0"
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
              {/* AI Assistant Icon Button */}
              <div
                className="relative flex items-center justify-center"
                onMouseEnter={() => setIsHoveringAiIcon(true)}
                onMouseLeave={() => setIsHoveringAiIcon(false)}
                onClick={async (e) => {
                  e.stopPropagation();
                  if (query.trim()) {
                    await askOllama(query);
                  } else {
                    // 如果没有输入，可以显示提示或使用默认提示
                    await askOllama('你好，请介绍一下你自己');
                  }
                }}
                onMouseDown={(e) => {
                  // Prevent dragging when clicking on icon
                  e.stopPropagation();
                }}
                style={{ cursor: 'pointer', minWidth: '24px', minHeight: '24px' }}
                title="询问AI"
              >
                {isAiLoading ? (
                  <svg
                    className="w-5 h-5 text-blue-500 animate-spin"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                ) : (
                  <svg
                    className={`w-5 h-5 transition-all ${
                      isHoveringAiIcon ? 'text-blue-600 opacity-100' : 'text-gray-400 opacity-70'
                    }`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    {/* AI/Robot Icon */}
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                    />
                    <circle cx="9" cy="9" r="1" fill="currentColor"/>
                    <circle cx="15" cy="9" r="1" fill="currentColor"/>
                  </svg>
                )}
              </div>
            </div>
          </div>

          {/* Results List */}
          {results.length > 0 && (
            <div
              ref={listRef}
              className="flex-1 overflow-y-auto min-h-0"
              style={{ maxHeight: '500px' }}
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
                      ) : result.type === "memo" ? (
                        <svg
                          className={`w-5 h-5 ${
                            index === selectedIndex ? "text-white" : "text-purple-500"
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
                      ) : result.type === "plugin" ? (
                        <svg
                          className={`w-5 h-5 ${
                            index === selectedIndex ? "text-white" : "text-green-500"
                          }`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                          />
                        </svg>
                      ) : result.type === "history" ? (
                        <svg
                          className={`w-5 h-5 ${
                            index === selectedIndex ? "text-white" : "text-orange-500"
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
                      ) : (result.type === "system_folder" && result.systemFolder?.is_folder) ||
                        (result.type === "file" &&
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
                      ) : result.type === "file" || result.type === "everything" || result.type === "system_folder" ? (
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
                      {result.path && result.type !== "memo" && result.type !== "history" && (
                        <div
                          className={`text-sm truncate ${
                            index === selectedIndex ? "text-blue-100" : "text-gray-500"
                          }`}
                        >
                          {result.path}
                        </div>
                      )}
                      {result.type === "memo" && result.memo && (
                        <div
                          className={`text-xs ${
                            index === selectedIndex ? "text-purple-200" : "text-gray-400"
                          }`}
                        >
                          {new Date(result.memo.updated_at * 1000).toLocaleDateString("zh-CN")}
                        </div>
                      )}
                      {result.type === "plugin" && result.plugin?.description && (
                        <div
                          className={`text-xs ${
                            index === selectedIndex ? "text-green-200" : "text-gray-400"
                          }`}
                        >
                          {result.plugin.description}
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
                      {result.type === "memo" && result.memo && (
                        <div className="flex items-center gap-2 mt-1">
                          <span
                            className={`text-xs px-2 py-0.5 rounded ${
                              index === selectedIndex
                                ? "bg-purple-400 text-white"
                                : "bg-purple-100 text-purple-700"
                            }`}
                            title="备忘录"
                          >
                            备忘录
                          </span>
                          {result.memo.content && (
                            <span
                              className={`text-xs truncate ${
                                index === selectedIndex ? "text-purple-200" : "text-gray-400"
                              }`}
                            >
                              {result.memo.content.slice(0, 50)}
                              {result.memo.content.length > 50 ? "..." : ""}
                            </span>
                          )}
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
                            ? `找到 ${everythingTotalCount.toLocaleString()} 个结果` 
                            : everythingResults.length > 0
                            ? `找到 ${everythingResults.length.toLocaleString()} 个结果`
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
          <div className="px-6 py-2 border-t border-gray-100 text-xs text-gray-400 flex justify-between items-center bg-gray-50/50 flex-shrink-0">
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
      )}

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
          className="fixed bg-white border border-gray-200 text-gray-800 rounded-lg shadow-xl py-1 min-w-[160px] z-50"
          style={{
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
          }}
        >
          {(contextMenu.result.type === "file" ||
            contextMenu.result.type === "everything" ||
            contextMenu.result.type === "system_folder" ||
            contextMenu.result.type === "app") && (
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
              className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 transition-colors"
            >
              打开所在文件夹
            </button>
          )}
          {contextMenu.result.type === "memo" && contextMenu.result.memo && (
            <>
              <button
                onClick={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setSelectedMemo(contextMenu.result.memo!);
                  setMemoEditTitle(contextMenu.result.memo!.title);
                  setMemoEditContent(contextMenu.result.memo!.content);
                  setIsEditingMemo(true);
                  setIsMemoModalOpen(true);
                  setContextMenu(null);
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 transition-colors"
              >
                编辑备忘录
              </button>
              <button
                onClick={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!contextMenu.result.memo) return;
                  if (!confirm("确定要删除这条备忘录吗？")) {
                    setContextMenu(null);
                    return;
                  }
                  try {
                    await tauriApi.deleteMemo(contextMenu.result.memo.id);
                    const list = await tauriApi.getAllMemos();
                    setMemos(list);
                    setContextMenu(null);
                    // 如果删除的是当前显示的备忘录，关闭弹窗
                    if (selectedMemo?.id === contextMenu.result.memo.id) {
                      setIsMemoModalOpen(false);
                      setSelectedMemo(null);
                    }
                  } catch (error) {
                    console.error("Failed to delete memo:", error);
                    alert(`删除备忘录失败: ${error}`);
                    setContextMenu(null);
                  }
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
              >
                删除备忘录
              </button>
            </>
          )}
        </div>
      )}

      {/* Memo Detail Modal */}
      {isMemoModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 overflow-auto">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl min-h-[500px] max-h-[calc(100vh-32px)] flex flex-col m-4 my-auto">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-800">
                {isMemoListMode
                  ? "备忘录列表"
                  : selectedMemo
                  ? isEditingMemo
                    ? "编辑备忘录"
                    : "备忘录详情"
                  : "新建备忘录"}
              </h2>
              <div className="flex items-center gap-2">
                {isMemoListMode && (
                  <button
                    onClick={() => {
                      // 切换到新建模式
                      setIsMemoListMode(false);
                      setSelectedMemo(null);
                      setMemoEditTitle("");
                      setMemoEditContent("");
                      setIsEditingMemo(true);
                    }}
                    className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
                  >
                    新建
                  </button>
                )}
                {!isMemoListMode && !isEditingMemo && selectedMemo && (
                  <button
                    onClick={() => {
                      setIsEditingMemo(true);
                    }}
                    className="px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-50 rounded transition-colors"
                  >
                    编辑
                  </button>
                )}
                <button
                  onClick={async () => {
                    if (isMemoListMode) {
                      // 列表模式：关闭并隐藏窗口（插件像独立软件一样运行）
                      setIsMemoModalOpen(false);
                      setIsMemoListMode(true);
                      setSelectedMemo(null);
                      setIsEditingMemo(false);
                      // 延迟隐藏窗口，让关闭动画完成
                      setTimeout(async () => {
                        try {
                          await tauriApi.hideLauncher();
                        } catch (error) {
                          console.error("Failed to hide window:", error);
                        }
                      }, 100);
                    } else if (isEditingMemo && !selectedMemo) {
                      // 新建模式：返回列表
                      setIsMemoListMode(true);
                      setSelectedMemo(null);
                      setMemoEditTitle("");
                      setMemoEditContent("");
                      setIsEditingMemo(false);
                    } else {
                      // 详情/编辑模式：返回列表
                      setIsMemoListMode(true);
                      setSelectedMemo(null);
                      setIsEditingMemo(false);
                    }
                  }}
                  className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded transition-colors"
                >
                  {isMemoListMode ? "关闭" : "返回"}
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4">
              {isMemoListMode ? (
                // 列表模式：展示所有备忘录
                <div className="space-y-2">
                  {memos.length === 0 ? (
                    <div className="text-sm text-gray-500">还没有任何备忘录</div>
                  ) : (
                    memos.map((memo) => (
                      <div
                        key={memo.id}
                        className="p-2 border border-gray-200 rounded hover:bg-gray-50 group"
                      >
                        <div
                          className="cursor-pointer"
                          onClick={() => {
                            // 点击列表项进入单条查看模式
                            setIsMemoListMode(false);
                            setSelectedMemo(memo);
                            setMemoEditTitle(memo.title);
                            setMemoEditContent(memo.content);
                            setIsEditingMemo(false);
                          }}
                        >
                          <div className="font-medium truncate">
                            {memo.title || "(无标题)"}
                          </div>
                          <div className="text-xs text-gray-500 truncate">
                            {memo.content ? memo.content.slice(0, 80) : "(无内容)"}
                            {memo.content && memo.content.length > 80 ? "..." : ""}
                          </div>
                          <div className="text-[11px] text-gray-400 mt-0.5">
                            更新于 {new Date(memo.updated_at * 1000).toLocaleString("zh-CN")}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              try {
                                const textToCopy = memo.title || "(无标题)";
                                await navigator.clipboard.writeText(textToCopy);
                                // 可以添加一个简单的提示，但为了简洁，这里不添加
                              } catch (error) {
                                console.error("Failed to copy to clipboard:", error);
                                alert(`复制失败: ${error}`);
                              }
                            }}
                            className="px-2 py-1 text-xs text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded border border-blue-300 hover:border-blue-400 transition-colors"
                            title="复制标题"
                          >
                            复制
                          </button>
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              try {
                                const textToCopy = memo.title || "(无标题)";
                                await navigator.clipboard.writeText(textToCopy);
                                // 复制成功后关闭启动器
                                await tauriApi.hideLauncher();
                                setQuery("");
                                setSelectedIndex(0);
                                resetMemoState();
                              } catch (error) {
                                console.error("Failed to copy to clipboard:", error);
                                alert(`复制失败: ${error}`);
                              }
                            }}
                            className="px-2 py-1 text-xs text-green-600 hover:text-green-800 hover:bg-green-50 rounded border border-green-300 hover:border-green-400 transition-colors"
                            title="复制标题并关闭"
                          >
                            复制并关闭
                          </button>
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (!confirm("确定要删除这条备忘录吗？")) {
                                return;
                              }
                              try {
                                await tauriApi.deleteMemo(memo.id);
                                const list = await tauriApi.getAllMemos();
                                setMemos(list);
                                // 如果删除的是当前显示的备忘录，关闭弹窗
                                if (selectedMemo?.id === memo.id) {
                                  setIsMemoModalOpen(false);
                                  setSelectedMemo(null);
                                }
                              } catch (error) {
                                console.error("Failed to delete memo:", error);
                                alert(`删除备忘录失败: ${error}`);
                              }
                            }}
                            className="px-2 py-1 text-xs text-red-600 hover:text-red-800 hover:bg-red-50 rounded border border-red-300 hover:border-red-400 transition-colors"
                            title="删除备忘录"
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              ) : isEditingMemo ? (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      标题
                    </label>
                    <input
                      type="text"
                      value={memoEditTitle}
                      onChange={(e) => setMemoEditTitle(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="输入备忘录标题"
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      内容
                    </label>
                    <textarea
                      value={memoEditContent}
                      onChange={(e) => setMemoEditContent(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                      placeholder="输入备忘录内容"
                      rows={12}
                    />
                  </div>
                </div>
              ) : selectedMemo ? (
                <div className="space-y-4">
                  <div>
                    <div className="text-sm font-medium text-gray-500 mb-1">标题</div>
                    <div className="text-lg font-semibold text-gray-800">
                      {selectedMemo.title || "(无标题)"}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm font-medium text-gray-500 mb-1">内容</div>
                    <div className="text-gray-700 whitespace-pre-wrap break-words">
                      {selectedMemo.content || "(无内容)"}
                    </div>
                  </div>
                  <div className="pt-4 border-t border-gray-200">
                    <div className="text-xs text-gray-500">
                      <div>
                        创建时间:{" "}
                        {new Date(selectedMemo.created_at * 1000).toLocaleString("zh-CN")}
                      </div>
                      <div>
                        更新时间:{" "}
                        {new Date(selectedMemo.updated_at * 1000).toLocaleString("zh-CN")}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            {/* Footer */}
            {isEditingMemo && (
              <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-200">
                <button
                  onClick={async () => {
                    try {
                      if (selectedMemo) {
                        // 编辑模式：更新已有备忘录
                        await tauriApi.updateMemo(
                          selectedMemo.id,
                          memoEditTitle,
                          memoEditContent
                        );
                        // 刷新备忘录列表
                        const list = await tauriApi.getAllMemos();
                        setMemos(list);
                        // 更新当前选中的备忘录
                        const updated = list.find((m) => m.id === selectedMemo.id);
                        if (updated) {
                          setSelectedMemo(updated);
                        }
                        setIsEditingMemo(false);
                      } else {
                        // 新建模式：创建新备忘录
                        if (!memoEditTitle.trim() && !memoEditContent.trim()) {
                          alert("请输入标题或内容");
                          return;
                        }
                        const newMemo = await tauriApi.addMemo(
                          memoEditTitle.trim() || "无标题",
                          memoEditContent.trim()
                        );
                        // 刷新备忘录列表
                        const list = await tauriApi.getAllMemos();
                        setMemos(list);
                        // 切换到查看模式，显示新创建的备忘录
                        setSelectedMemo(newMemo);
                        setIsEditingMemo(false);
                      }
                    } catch (error) {
                      console.error("Failed to save memo:", error);
                      alert(`保存备忘录失败: ${error}`);
                    }
                  }}
                  className="px-4 py-2 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
                >
                  保存
                </button>
                <button
                  onClick={() => {
                    if (selectedMemo) {
                      // 编辑模式：取消编辑，恢复原内容
                      setIsEditingMemo(false);
                      setMemoEditTitle(selectedMemo.title);
                      setMemoEditContent(selectedMemo.content);
                    } else {
                      // 新建模式：直接关闭弹窗
                      setIsMemoModalOpen(false);
                      setSelectedMemo(null);
                      setMemoEditTitle("");
                      setMemoEditContent("");
                      setIsEditingMemo(false);
                    }
                  }}
                  className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded transition-colors"
                >
                  取消
                </button>
                {selectedMemo && (
                  <button
                    onClick={async () => {
                      const memoToDelete = selectedMemo;
                      if (!memoToDelete) return;
                      if (!confirm("确定要删除这条备忘录吗？")) return;
                      try {
                        await tauriApi.deleteMemo(memoToDelete.id);
                        // 刷新备忘录列表
                        const list = await tauriApi.getAllMemos();
                        setMemos(list);
                        setIsMemoModalOpen(false);
                        setSelectedMemo(null);
                        setIsEditingMemo(false);
                      } catch (error) {
                        console.error("Failed to delete memo:", error);
                        alert(`删除备忘录失败: ${error}`);
                      }
                    }}
                    className="px-4 py-2 text-sm text-red-600 hover:bg-red-50 rounded transition-colors"
                  >
                    删除
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Plugin List Modal */}
      {isPluginListModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl flex flex-col m-4" style={{ maxHeight: '90vh' }}>
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-200 flex-shrink-0">
              <h2 className="text-lg font-semibold text-gray-800">插件列表</h2>
              <button
                onClick={async () => {
                  setIsPluginListModalOpen(false);
                  // 延迟隐藏窗口，让关闭动画完成（插件像独立软件一样运行）
                  setTimeout(async () => {
                    try {
                      await tauriApi.hideLauncher();
                    } catch (error) {
                      console.error("Failed to hide window:", error);
                    }
                  }, 100);
                }}
                className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded transition-colors"
              >
                关闭
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4 min-h-0">
              <div className="space-y-3">
                {plugins.map((plugin) => (
                  <div
                    key={plugin.id}
                    className="p-4 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded flex items-center justify-center flex-shrink-0 bg-green-100">
                        <svg
                          className="w-5 h-5 text-green-600"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                          />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-gray-800">{plugin.name}</div>
                        {plugin.description && (
                          <div className="text-sm text-gray-500 mt-1">{plugin.description}</div>
                        )}
                        {plugin.keywords && plugin.keywords.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {plugin.keywords.map((keyword, idx) => (
                              <span
                                key={idx}
                                className="px-2 py-0.5 text-xs bg-gray-100 text-gray-600 rounded"
                              >
                                {keyword}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
