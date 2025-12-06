import { useState, useEffect, useRef, useMemo } from "react";
import { flushSync } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { tauriApi } from "../api/tauri";
import { trackEvent } from "../api/events";
import type { AppInfo, FileHistoryItem, EverythingResult, MemoItem, PluginContext, SystemFolderItem } from "../types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { plugins, searchPlugins, executePlugin } from "../plugins";
import { AppCenterContent } from "./AppCenterContent";

type SearchResult = {
  type: "app" | "file" | "everything" | "url" | "memo" | "plugin" | "system_folder" | "history" | "ai" | "json_formatter" | "settings";
  app?: AppInfo;
  file?: FileHistoryItem;
  everything?: EverythingResult;
  url?: string;
  memo?: MemoItem;
  plugin?: { id: string; name: string; description?: string };
  systemFolder?: SystemFolderItem;
  aiAnswer?: string;
  jsonContent?: string;
  displayName: string;
  path: string;
};

type ResultStyle = "compact" | "soft" | "skeuomorphic";

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
  const [directPathResult, setDirectPathResult] = useState<FileHistoryItem | null>(null); // 绝对路径直达结果
  const [isEverythingAvailable, setIsEverythingAvailable] = useState(false);
  const [everythingPath, setEverythingPath] = useState<string | null>(null);
  const [everythingVersion, setEverythingVersion] = useState<string | null>(null);
  const [everythingError, setEverythingError] = useState<string | null>(null);
  const [isSearchingEverything, setIsSearchingEverything] = useState(false);
  const [isDownloadingEverything, setIsDownloadingEverything] = useState(false);
  const [everythingDownloadProgress, setEverythingDownloadProgress] = useState(0);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isHoveringAiIcon, setIsHoveringAiIcon] = useState(false);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiAnswer, setAiAnswer] = useState<string | null>(null);
  const [showAiAnswer, setShowAiAnswer] = useState(false); // 是否显示 AI 回答模式
  const [ollamaSettings, setOllamaSettings] = useState<{ model: string; base_url: string }>({
    model: "llama2",
    base_url: "http://localhost:11434",
  });
  // 剪切板 URL 弹窗
  const [clipboardUrlToOpen, setClipboardUrlToOpen] = useState<string | null>(null);
  const [detectedUrls, setDetectedUrls] = useState<string[]>([]);
  const [detectedJson, setDetectedJson] = useState<string | null>(null);
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
  const [resultStyle, setResultStyle] = useState<ResultStyle>(() => {
    const cached = localStorage.getItem("result-style");
    if (cached === "soft" || cached === "skeuomorphic" || cached === "compact") {
      return cached;
    }
    return "skeuomorphic";
  });
  const [closeOnBlur, setCloseOnBlur] = useState(true);
  const [windowWidth, setWindowWidth] = useState<number>(() => {
    // 从本地存储读取保存的宽度，默认600
    const saved = localStorage.getItem('launcher-window-width');
    return saved ? parseInt(saved, 10) : 600;
  });
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef<number>(0);
  const resizeStartWidth = useRef<number>(600);
  const resizeRafId = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isWindowDraggingRef = useRef(false);
  // 记录最近一次已处理的剪切板 URL，避免同一个链接在一次会话中反复弹窗
  const lastClipboardUrlRef = useRef<string | null>(null);
  // 记录备忘录弹窗是否打开，用于全局 ESC 处理时优先关闭备忘录，而不是隐藏整个窗口
  const isMemoModalOpenRef = useRef(false);
  // 记录应用中心弹窗是否打开，用于全局 ESC 处理时优先关闭应用中心，而不是隐藏整个窗口
  const isPluginListModalOpenRef = useRef(false);
  const shouldPreserveScrollRef = useRef(false); // 标记是否需要保持滚动位置
  const finalResultsSetRef = useRef(false); // 方案 B 中仅用于调试/校验，不再阻止批次更新
  const incrementalLoadRef = useRef<number | null>(null); // 用于取消增量加载
  const incrementalTimeoutRef = useRef<number | null>(null); // 用于取消增量加载的 setTimeout
  const lastSearchQueryRef = useRef<string>(""); // 用于去重，避免相同查询重复搜索
  const debounceTimeoutRef = useRef<number | null>(null); // 用于跟踪防抖定时器
  const currentLoadResultsRef = useRef<SearchResult[]>([]); // 跟踪当前正在加载的结果，用于验证是否仍有效
  const closeOnBlurRef = useRef(true);

  const getMainContainer = () => containerRef.current || (document.querySelector('.bg-white') as HTMLElement | null);

  useEffect(() => {
    isMemoModalOpenRef.current = isMemoModalOpen;
  }, [isMemoModalOpen]);

  useEffect(() => {
    isPluginListModalOpenRef.current = isPluginListModalOpen;
  }, [isPluginListModalOpen]);

  useEffect(() => {
    closeOnBlurRef.current = closeOnBlur;
  }, [closeOnBlur]);

  // 动态注入滚动条样式，确保样式生效（随风格变化）
  // 注意：Windows 11 可能使用系统原生滚动条，webkit-scrollbar 样式可能不生效
  useEffect(() => {
    const styleId = 'custom-scrollbar-style';
    const config = (() => {
      if (resultStyle === "soft") {
        return {
          scrollbarSize: 20,
          trackBg: "#f0f0f0",
          trackBorder: "#e0e0e0",
          thumbBg: "#a0a0a0",
          thumbHover: "#888888",
          thumbActive: "#707070",
          thumbBorder: 4,
          thumbBorderBg: "#f0f0f0",
          thumbHoverBorder: "#f0f0f0",
          thumbActiveBorder: "#f0f0f0",
          minHeight: 40,
        };
      }
      if (resultStyle === "skeuomorphic") {
        return {
          scrollbarSize: 14,
          trackBg: "#f6f8fb",
          trackBorder: "#e3e9f1",
          thumbBg: "#c5d0de",
          thumbHover: "#b2c1d6",
          thumbActive: "#9fb0c9",
          thumbBorder: 3,
          thumbBorderBg: "#f9fbfe",
          thumbHoverBorder: "#eef3fa",
          thumbActiveBorder: "#e3e9f3",
          minHeight: 34,
        };
      }
      return {
        scrollbarSize: 12,
        trackBg: "#f8f9fb",
        trackBorder: "#eceff3",
        thumbBg: "#b6beca",
        thumbHover: "#9fa8b7",
        thumbActive: "#8893a3",
        thumbBorder: 3,
        thumbBorderBg: "#f8f9fb",
        thumbHoverBorder: "#f1f3f6",
        thumbActiveBorder: "#e8ecf2",
        minHeight: 32,
      };
    })();
    
    const injectStyle = () => {
      // 如果样式已存在，先移除
      const existingStyle = document.getElementById(styleId);
      if (existingStyle) {
        existingStyle.remove();
      }
      
      // 创建新的 style 标签
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        .results-list-scroll {
          overflow-y: scroll !important;
        }
        
        .results-list-scroll::-webkit-scrollbar {
          width: ${config.scrollbarSize}px !important;
          height: ${config.scrollbarSize}px !important;
          display: block !important;
          -webkit-appearance: none !important;
          background-color: transparent !important;
        }
        
        .results-list-scroll::-webkit-scrollbar-button {
          display: none !important;
          width: 0 !important;
          height: 0 !important;
        }
        
        .results-list-scroll::-webkit-scrollbar-track {
          background: ${config.trackBg} !important;
          border-left: 1px solid ${config.trackBorder} !important;
        }
        
        .results-list-scroll::-webkit-scrollbar-thumb {
          background-color: ${config.thumbBg} !important;
          border-radius: ${config.thumbBorder * 2}px !important;
          border: ${config.thumbBorder}px solid ${config.thumbBorderBg} !important;
          background-clip: content-box !important;
          min-height: ${config.minHeight}px !important;
          transition: background-color 0.2s ease, box-shadow 0.2s ease !important;
          box-shadow: none !important;
        }
        
        .results-list-scroll::-webkit-scrollbar-thumb:hover {
          background-color: ${config.thumbHover} !important;
          border: ${config.thumbBorder}px solid ${config.thumbHoverBorder} !important;
          box-shadow: none !important;
        }
        
        .results-list-scroll::-webkit-scrollbar-thumb:active {
          background-color: ${config.thumbActive} !important;
          border: ${config.thumbBorder}px solid ${config.thumbActiveBorder} !important;
          box-shadow: none !important;
        }
        
        /* 隐藏可执行文件横向滚动条的滚动条 */
        .executable-scroll-container::-webkit-scrollbar {
          display: none !important;
          width: 0 !important;
          height: 0 !important;
        }
      `;
      document.head.appendChild(style);
    };
    
    // 立即注入样式
    injectStyle();
    
    // 延迟再次注入，确保在元素渲染后也能应用
    const timeoutId = setTimeout(() => {
      injectStyle();
    }, 100);
    
    // 监听 DOM 变化，当滚动容器出现时再次注入
    const observer = new MutationObserver(() => {
      if (document.querySelector('.results-list-scroll')) {
        injectStyle();
      }
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    
    return () => {
      clearTimeout(timeoutId);
      observer.disconnect();
      // 清理：组件卸载时移除样式
      const styleToRemove = document.getElementById(styleId);
      if (styleToRemove) {
        styleToRemove.remove();
      }
    };
  }, [resultStyle]);

  // 重置备忘录相关状态的辅助函数
  const resetMemoState = () => {
    setIsMemoModalOpen(false);
    setIsMemoListMode(true);
    setSelectedMemo(null);
    setMemoEditTitle("");
    setMemoEditContent("");
    setIsEditingMemo(false);
  };

  // 统一处理窗口关闭和状态清理的公共函数
  const hideLauncherAndResetState = async (options?: { resetMemo?: boolean; resetAi?: boolean }) => {
    try {
      await tauriApi.hideLauncher();
      setQuery("");
      setSelectedIndex(0);
      setContextMenu(null);
      if (options?.resetMemo) {
        resetMemoState();
      }
      if (options?.resetAi) {
        setShowAiAnswer(false);
        setAiAnswer(null);
      }
    } catch (error) {
      console.error("Failed to hide window:", error);
    }
  };

  // 插件列表已从 plugins/index.ts 导入

  // Load settings on mount and reload when settings window closes
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await tauriApi.getSettings();
        setOllamaSettings(settings.ollama);
        const styleFromSettings = (settings.result_style as ResultStyle) || null;
        const styleFromCache = localStorage.getItem("result-style");
        const fallback =
          styleFromSettings && ["compact", "soft", "skeuomorphic"].includes(styleFromSettings)
            ? styleFromSettings
            : styleFromCache && ["compact", "soft", "skeuomorphic"].includes(styleFromCache)
            ? (styleFromCache as ResultStyle)
            : "skeuomorphic";
        setResultStyle(fallback);
        localStorage.setItem("result-style", fallback);
        const closeOnBlurSetting = settings.close_on_blur ?? true;
        setCloseOnBlur(closeOnBlurSetting);
        closeOnBlurRef.current = closeOnBlurSetting;
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

  // Listen for Everything download progress events
  useEffect(() => {
    if (!isDownloadingEverything) return;

    let unlistenFn: (() => void) | null = null;
    
    const setupProgressListener = async () => {
      const unlisten = await listen<number>("everything-download-progress", (event) => {
        setEverythingDownloadProgress(event.payload);
      });
      unlistenFn = unlisten;
    };

    setupProgressListener();

    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, [isDownloadingEverything]);

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

  // Adjust window size when app center modal is shown
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
      const whiteContainer = getMainContainer();
      if (whiteContainer) {
        // Use scrollHeight to get the full content height including overflow
        const containerHeight = whiteContainer.scrollHeight;
        // Use saved window width or default
        const targetWidth = windowWidth;
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
        // 如果应用中心弹窗已打开，关闭应用中心并隐藏窗口（插件像独立软件一样运行）
        if (isPluginListModalOpenRef.current) {
          setIsPluginListModalOpen(false);
          // 延迟隐藏窗口，让关闭动画完成
          setTimeout(() => {
            hideLauncherAndResetState();
          }, 100);
          return;
        }
        // 如果备忘录弹窗已打开，关闭备忘录并隐藏窗口（插件像独立软件一样运行）
        if (isMemoModalOpenRef.current) {
          resetMemoState();
          // 延迟隐藏窗口，让关闭动画完成
          setTimeout(() => {
            hideLauncherAndResetState();
          }, 100);
          return;
        }
        // 如果正在显示 AI 回答，退出 AI 回答模式
        if (showAiAnswer) {
          setShowAiAnswer(false);
          setAiAnswer(null);
          return;
        }
        await hideLauncherAndResetState({ resetMemo: true });
      }
    };
    
    // Use document with capture phase to catch Esc key early
    document.addEventListener("keydown", handleGlobalKeyDown, true);
    
    // Focus input when window gains focus, hide when loses focus
    const unlistenFocus = window.onFocusChanged(async ({ payload: focused }) => {
      if (focused) {
        isWindowDraggingRef.current = false;
        if (inputRef.current) {
          setTimeout(() => {
            inputRef.current?.focus();
            // Only select text if input is empty
            if (inputRef.current && !inputRef.current.value) {
              inputRef.current.select();
            }
          }, 100);
        }
      } else if (!focused) {
        if (isWindowDraggingRef.current) {
          return;
        }
        if (!closeOnBlurRef.current) {
          return;
        }
        // 当窗口失去焦点时，自动关闭搜索框
        // 如果应用中心弹窗已打开，关闭应用中心并隐藏窗口
        if (isPluginListModalOpenRef.current) {
          setIsPluginListModalOpen(false);
          setTimeout(() => {
            hideLauncherAndResetState();
          }, 100);
          return;
        }
        // 如果备忘录弹窗已打开，关闭备忘录并隐藏窗口
        if (isMemoModalOpenRef.current) {
          resetMemoState();
          setTimeout(() => {
            hideLauncherAndResetState();
          }, 100);
          return;
        }
        // 隐藏窗口并重置所有状态
        await hideLauncherAndResetState({ resetMemo: true, resetAi: true });
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

  useEffect(() => {
    const handleMouseUp = () => {
      isWindowDraggingRef.current = false;
    };
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Extract URLs from text
  const extractUrls = (text: string): string[] => {
    if (!text || text.trim().length === 0) return [];
    
    // 只匹配以 http:// 或 https:// 开头的 URL
    const urlPattern = /https?:\/\/[^\s<>"']+/gi;
    const matches = text.match(urlPattern);
    if (!matches) return [];
    
    // 清理并返回 URL
    return matches
      .map(url => url.trim())
      .filter((url): url is string => url.length > 0)
      .filter((url, index, self) => self.indexOf(url) === index); // Remove duplicates
  };

  // 确认打开剪切板 URL
  const handleConfirmOpenClipboardUrl = async () => {
    if (!clipboardUrlToOpen) return;
    try {
      await tauriApi.openUrl(clipboardUrlToOpen);
      await hideLauncherAndResetState();
    } catch (error) {
      console.error("Failed to open clipboard URL:", error);
      alert("打开链接失败，请稍后重试");
    } finally {
      setClipboardUrlToOpen(null);
    }
  };

  const handleCancelOpenClipboardUrl = () => {
    setClipboardUrlToOpen(null);
  };

  // 统一处理窗口拖动，避免拖动过程中触发失焦自动关闭
  const startWindowDragging = async () => {
    const window = getCurrentWindow();
    isWindowDraggingRef.current = true;
    try {
      await window.startDragging();
    } catch (error) {
      isWindowDraggingRef.current = false;
      console.error("Failed to start dragging:", error);
    }
  };

  // 检测剪切板中的 URL：仅在窗口获得焦点（显示）时检测一次，不做轮询
  useEffect(() => {
    const window = getCurrentWindow();

    const checkClipboardForUrl = async () => {
      try {
        const clipboardText = await tauriApi.getClipboardText();
        if (clipboardText && clipboardText.trim()) {
          const urls = extractUrls(clipboardText.trim());
          if (urls.length > 0) {
            const url = urls[0];

            // 如果这个 URL 与最近一次已处理的 URL 相同，则不再重复弹窗
            if (lastClipboardUrlRef.current === url) {
              return;
            }

            lastClipboardUrlRef.current = url;
            setClipboardUrlToOpen(url);
          }
        }
      } catch (error) {
        // 剪切板可能不可访问或无文本内容，这里忽略错误即可
        console.log("Failed to check clipboard:", error);
      }
    };

    // 监听窗口获取焦点事件，每次显示 / 聚焦时检测一次
    let unlistenPromise: Promise<() => void> | null = null;

    (async () => {
      try {
        unlistenPromise = window.listen("tauri://focus", () => {
          checkClipboardForUrl();
        });
      } catch (error) {
        console.error("Failed to listen window focus event:", error);
      }

      // 初始化时也检测一次（应用刚启动时窗口已显示的情况）
      checkClipboardForUrl();
    })();

    return () => {
      if (unlistenPromise) {
        unlistenPromise.then((unlisten) => unlisten());
      }
    };
  }, []);

  // 剪切板 URL 弹窗出现时，也一起参与主窗口高度计算（在下面统一的窗口高度逻辑中处理）

  // Check if text is valid JSON
  const isValidJson = (text: string): boolean => {
    if (!text || text.trim().length === 0) return false;
    
    const trimmed = text.trim();
    
    // Quick check: JSON should start with { or [
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return false;
    }
    
    // Try to parse as JSON
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  };

  // Highlight matching keywords in text
  const highlightText = (text: string, query: string): string => {
    if (!query || !query.trim() || !text) {
      // Escape HTML to prevent XSS
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Escape HTML in the original text
    const escapedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    
    // Split query into words (handle multiple words)
    const queryWords = query.trim().split(/\s+/).filter(word => word.length > 0);
    
    // Escape special regex characters in query words
    const escapedQueryWords = queryWords.map(word => 
      word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );
    
    // Create regex pattern that matches any of the query words (case-insensitive)
    const pattern = new RegExp(`(${escapedQueryWords.join('|')})`, 'gi');
    
    // Replace matches with highlighted version
    return escapedText.replace(pattern, (match) => {
      return `<span class="highlight-match font-semibold">${match}</span>`;
    });
  };

  const theme = useMemo(() => {
    const compact = {
      card: (selected: boolean) =>
        `group relative mx-2 my-1 px-3.5 py-2.5 rounded-lg border cursor-pointer transition-colors duration-150 ${
          selected
            ? "bg-indigo-50 text-gray-900 border-indigo-200"
            : "bg-white text-gray-800 border-gray-100 hover:bg-gray-50 hover:border-gray-200"
        }`,
      indicator: (selected: boolean) =>
        `absolute left-0 top-2 bottom-2 w-[2px] rounded-full transition-opacity ${
          selected ? "bg-indigo-500 opacity-100" : "bg-indigo-300 opacity-0 group-hover:opacity-70"
        }`,
      indexBadge: (selected: boolean) =>
        `text-[11px] font-semibold flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-colors ${
          selected ? "bg-indigo-500 text-white" : "bg-gray-100 text-gray-500 group-hover:bg-gray-200"
        }`,
      iconWrap: (selected: boolean) =>
        `w-9 h-9 rounded-md flex items-center justify-center flex-shrink-0 overflow-hidden transition-colors duration-150 ${
          selected ? "bg-indigo-100 border border-indigo-200" : "bg-gray-50 border border-gray-100 group-hover:border-gray-200"
        }`,
      iconColor: (selected: boolean, defaultColor: string) => (selected ? "text-indigo-600" : defaultColor),
      title: (selected: boolean) => (selected ? "text-indigo-900" : "text-gray-900"),
      aiText: (selected: boolean) => (selected ? "text-indigo-800" : "text-gray-600"),
      pathText: (selected: boolean) => (selected ? "text-indigo-700" : "text-gray-500"),
      metaText: (selected: boolean) => (selected ? "text-indigo-700" : "text-gray-500"),
      descText: (selected: boolean) => (selected ? "text-indigo-800" : "text-gray-600"),
      usageText: (selected: boolean) => (selected ? "text-indigo-700" : "text-gray-500"),
      tag: (_type: string, selected: boolean) =>
        selected
          ? "bg-indigo-100 text-indigo-700 border border-indigo-200"
          : "bg-gray-100 text-gray-600 border border-gray-200",
    };

    const skeuo = {
      card: (selected: boolean) =>
        `group relative mx-2 my-1.5 px-4 py-3 rounded-xl border cursor-pointer transition-all duration-200 ${
          selected
            ? "bg-gradient-to-b from-[#f3f6fb] to-[#e1e9f5] text-[#1f2a44] border-[#c6d4e8] shadow-[0_8px_18px_rgba(20,32,50,0.14)] ring-1 ring-[#d7e2f2]/70"
            : "bg-gradient-to-b from-[#f9fbfe] to-[#f1f5fb] text-[#222b3a] border-[#e2e8f1] shadow-[0_6px_14px_rgba(20,32,50,0.10)] hover:-translate-y-[1px] hover:shadow-[0_9px_18px_rgba(20,32,50,0.14)]"
        }`,
      indicator: (selected: boolean) =>
        `absolute left-0 top-2 bottom-2 w-[3px] rounded-full transition-opacity ${
          selected ? "bg-[#8fb1e3] opacity-100 shadow-[0_0_0_1px_rgba(255,255,255,0.65)]" : "bg-[#c6d6ed] opacity-0 group-hover:opacity-80"
        }`,
      indexBadge: (selected: boolean) =>
        `text-[11px] font-semibold flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-all shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_2px_6px_rgba(20,32,50,0.12)] ${
          selected
            ? "bg-gradient-to-b from-[#e5edf9] to-[#d4e1f2] text-[#22365b]"
            : "bg-gradient-to-b from-[#f1f6fc] to-[#e2eaf6] text-[#2e3f5f]"
        }`,
      iconWrap: (selected: boolean) =>
        `w-9 h-9 rounded-md flex items-center justify-center flex-shrink-0 overflow-hidden transition-all duration-200 border ${
          selected
            ? "bg-gradient-to-b from-[#edf3fb] to-[#d9e4f5] border-[#c6d4e8] shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_3px_10px_rgba(20,32,50,0.16)]"
            : "bg-gradient-to-b from-[#fafcfe] to-[#ecf1f8] border-[#e0e7f1] shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_2px_7px_rgba(20,32,50,0.12)]"
        }`,
      iconColor: (selected: boolean, defaultColor: string) => (selected ? "text-[#2f4670]" : defaultColor),
      title: (selected: boolean) => (selected ? "text-[#1f2a44]" : "text-[#222b3a]"),
      aiText: (selected: boolean) => (selected ? "text-[#2e446a]" : "text-[#3c4c64]"),
      pathText: (selected: boolean) => (selected ? "text-[#3a5174]" : "text-[#4a5a70]"),
      metaText: (selected: boolean) => (selected ? "text-[#4a6185]" : "text-[#5a6a80]"),
      descText: (selected: boolean) => (selected ? "text-[#1f2a44]" : "text-[#3b4b63]"),
      usageText: (selected: boolean) => (selected ? "text-[#3a5174]" : "text-[#5a6a80]"),
      tag: (_type: string, selected: boolean) =>
        selected
          ? "bg-gradient-to-b from-[#e7eef9] to-[#d7e3f3] text-[#1f2a44] border border-[#c1cfe6] shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_1px_3px_rgba(20,32,50,0.1)]"
          : "bg-gradient-to-b from-[#f4f7fc] to-[#e9eef7] text-[#2c3a54] border border-[#d7e1ef] shadow-[inset_0_1px_0_rgba(255,255,255,0.65)]",
    };

    const soft = {
      card: (selected: boolean) =>
        `group relative mx-2 my-1.5 px-4 py-3 rounded-xl cursor-pointer transition-all duration-200 ${
          selected
            ? "bg-gradient-to-r from-blue-500 to-blue-600 text-white shadow-lg shadow-blue-500/30 scale-[1.02]"
            : "hover:bg-gray-50 text-gray-700 hover:shadow-md"
        }`,
      indicator: (selected: boolean) =>
        `absolute left-0 top-2 bottom-2 w-1 rounded-full transition-opacity ${
          selected ? "bg-blue-200 opacity-80" : "opacity-0"
        }`,
      indexBadge: (selected: boolean) =>
        `text-xs font-semibold flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center transition-all ${
          selected ? "bg-white/20 text-white backdrop-blur-sm" : "bg-gray-100 text-gray-500 group-hover:bg-gray-200"
        }`,
      iconWrap: (selected: boolean) =>
        `w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden transition-all duration-200 shadow-sm ${
          selected
            ? "bg-white/20 backdrop-blur-sm ring-2 ring-white/30"
            : "bg-gradient-to-br from-gray-50 to-gray-100 group-hover:from-gray-100 group-hover:to-gray-200"
        }`,
      iconColor: (selected: boolean, defaultColor: string) => (selected ? "text-white" : defaultColor),
      title: (selected: boolean) => (selected ? "text-white" : "text-gray-900"),
      aiText: (selected: boolean) => (selected ? "text-blue-50" : "text-gray-600"),
      pathText: (selected: boolean) => (selected ? "text-blue-100/90" : "text-gray-500"),
      metaText: (selected: boolean) => (selected ? "text-purple-200" : "text-gray-400"),
      descText: (selected: boolean) => (selected ? "text-green-200" : "text-gray-500"),
      usageText: (selected: boolean) => (selected ? "text-blue-200" : "text-gray-400"),
      tag: (type: string, selected: boolean) => {
        const map: Record<string, string> = {
          url: selected ? "bg-blue-400 text-white" : "bg-blue-100 text-blue-700 border border-blue-200",
          json_formatter: selected ? "bg-indigo-400 text-white" : "bg-indigo-100 text-indigo-700 border border-indigo-200",
          memo: selected ? "bg-purple-400 text-white" : "bg-purple-100 text-purple-700 border border-purple-200",
          everything: selected ? "bg-green-400 text-white" : "bg-green-100 text-green-700 border border-green-200",
          default: selected ? "bg-white/20 text-white backdrop-blur-sm" : "bg-gray-50 text-gray-600 border border-gray-200",
        };
        return map[type] || map.default;
      },
    };

    if (resultStyle === "soft") return soft;
    if (resultStyle === "skeuomorphic") return skeuo;
    return compact;
  }, [resultStyle]);

  const layout = useMemo(() => {
    if (resultStyle === "skeuomorphic") {
      return {
        wrapperBg: "linear-gradient(145deg, #eef2f8 0%, #e2e8f3 50%, #f6f8fc 100%)",
        container: "flex flex-col rounded-2xl shadow-[0_18px_48px_rgba(24,38,62,0.18)] border border-[#c8d5eb] ring-1 ring-[#d7e2f2]/80 bg-gradient-to-b from-[#f8fbff] via-[#eef3fb] to-[#e1e9f5]",
        header: "px-6 py-4 border-b border-[#dfe6f2] bg-gradient-to-r from-[#f4f7fc] via-[#eef3fb] to-[#f9fbfe] flex-shrink-0 rounded-t-2xl",
        searchIcon: "w-5 h-5 text-[#6f84aa]",
        input: "flex-1 text-lg border-none outline-none bg-transparent placeholder-[#95a6c2] text-[#1f2a44]",
        pluginIcon: (hovering: boolean) => `w-5 h-5 transition-all ${hovering ? "text-[#4468a2] opacity-100 drop-shadow-[0_2px_6px_rgba(68,104,162,0.35)]" : "text-[#7f93b3] opacity-85"}`,
      };
    }
    if (resultStyle === "soft") {
      return {
        wrapperBg: "transparent",
        container: "bg-white flex flex-col rounded-lg shadow-xl",
        header: "px-6 py-4 border-b border-gray-100 flex-shrink-0",
        searchIcon: "w-5 h-5 text-gray-400",
        input: "flex-1 text-lg border-none outline-none bg-transparent placeholder-gray-400 text-gray-700",
        pluginIcon: (hovering: boolean) => `w-5 h-5 transition-all ${hovering ? "text-blue-600 opacity-100" : "text-gray-400 opacity-70"}`,
      };
    }
    return {
      wrapperBg: "transparent",
      container: "bg-white flex flex-col rounded-lg shadow-xl",
      header: "px-6 py-4 border-b border-gray-100 flex-shrink-0",
      searchIcon: "w-5 h-5 text-gray-400",
      input: "flex-1 text-lg border-none outline-none bg-transparent placeholder-gray-400 text-gray-700",
      pluginIcon: (hovering: boolean) => `w-5 h-5 transition-all ${hovering ? "text-indigo-600 opacity-100" : "text-gray-400 opacity-70"}`,
    };
  }, [resultStyle]);

  // Call Ollama API to ask AI (流式请求)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const askOllama = async (prompt: string) => {
    if (!prompt.trim()) {
      return;
    }

    // 清空之前的 AI 回答，并切换到 AI 回答模式
    setAiAnswer('');
    setShowAiAnswer(true);
    setIsAiLoading(true);
    
    let accumulatedAnswer = '';
    let buffer = ''; // 用于处理不完整的行
    
    try {
      const baseUrl = ollamaSettings.base_url || 'http://localhost:11434';
      const model = ollamaSettings.model || 'llama2';
      
      // 尝试使用 chat API (流式)
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
          stream: true,
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
            stream: true,
          }),
        });

        if (!generateResponse.ok) {
          throw new Error(`Ollama API error: ${generateResponse.statusText}`);
        }

        // 处理 generate API 的流式响应
        const reader = generateResponse.body?.getReader();
        const decoder = new TextDecoder();
        
        if (!reader) {
          throw new Error('无法读取响应流');
        }

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // 处理剩余的 buffer
            if (buffer.trim()) {
              try {
                const data = JSON.parse(buffer);
                if (data.response) {
                  accumulatedAnswer += data.response;
                  flushSync(() => {
                    setAiAnswer(accumulatedAnswer);
                  });
                }
              } catch (e) {
                console.warn('解析最后的数据失败:', e, buffer);
              }
            }
            break;
          }

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        const lines = buffer.split('\n');
        
        // 保留最后一个不完整的行
        buffer = lines.pop() || '';

        // 快速处理所有完整的行
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;
          
          try {
            const data = JSON.parse(trimmedLine);
            if (data.response) {
              accumulatedAnswer += data.response;
              // 立即更新 UI，不等待
              flushSync(() => {
                setAiAnswer(accumulatedAnswer);
              });
            }
            if (data.done) {
              setIsAiLoading(false);
              flushSync(() => {
                setAiAnswer(accumulatedAnswer);
              });
              return;
            }
          } catch (e) {
            // 忽略解析错误，继续处理下一行
            console.warn('解析流式数据失败:', e, trimmedLine);
          }
        }
        
        // 立即继续读取下一个 chunk，不阻塞
        }
        
        setIsAiLoading(false);
        setAiAnswer(accumulatedAnswer);
        return;
      }

      // 处理 chat API 的流式响应
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      
      if (!reader) {
        throw new Error('无法读取响应流');
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // 处理剩余的 buffer
          if (buffer.trim()) {
            try {
              const data = JSON.parse(buffer);
              if (data.message?.content) {
                accumulatedAnswer += data.message.content;
                flushSync(() => {
                  setAiAnswer(accumulatedAnswer);
                });
              }
            } catch (e) {
              console.warn('解析最后的数据失败:', e, buffer);
            }
          }
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        const lines = buffer.split('\n');
        
        // 保留最后一个不完整的行
        buffer = lines.pop() || '';

        // 快速处理所有完整的行
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;
          
          try {
            const data = JSON.parse(trimmedLine);
            if (data.message?.content) {
              accumulatedAnswer += data.message.content;
              // 立即更新 UI，不等待
              flushSync(() => {
                setAiAnswer(accumulatedAnswer);
              });
            }
            if (data.done) {
              setIsAiLoading(false);
              flushSync(() => {
                setAiAnswer(accumulatedAnswer);
              });
              return;
            }
          } catch (e) {
            // 忽略解析错误，继续处理下一行
            console.warn('解析流式数据失败:', e, trimmedLine);
          }
        }
        
        // 立即继续读取下一个 chunk，不阻塞
      }
      
      setIsAiLoading(false);
      setAiAnswer(accumulatedAnswer);
    } catch (error: any) {
      console.error('调用Ollama API失败:', error);
      setIsAiLoading(false);
      // 显示错误提示
      const errorMessage = error.message || '未知错误';
      const baseUrl = ollamaSettings.base_url || 'http://localhost:11434';
      const model = ollamaSettings.model || 'llama2';
      alert(`调用AI失败: ${errorMessage}\n\n请确保:\n1. Ollama服务正在运行\n2. 已安装模型 (例如: ollama pull ${model})\n3. 服务地址为 ${baseUrl}`);
    }
  };

  // 将 askOllama 暴露到 window 以避免未使用告警并便于调试
  useEffect(() => {
    (window as any).__askOllama = askOllama;
  }, [askOllama]);

  // Search applications, file history, and Everything when query changes (with debounce)
  useEffect(() => {
    // 清除之前的防抖定时器
    if (debounceTimeoutRef.current !== null) {
      clearTimeout(debounceTimeoutRef.current);
      debounceTimeoutRef.current = null;
    }

    const trimmedQuery = query.trim();
    
    if (trimmedQuery === "") {
      // Cancel any ongoing search
      if (currentSearchRef.current) {
        currentSearchRef.current.cancelled = true;
        currentSearchRef.current = null;
      }
      lastSearchQueryRef.current = "";
      
      // React 会自动批处理 useEffect 中的状态更新，不需要 flushSync
      setFilteredApps([]);
      setFilteredFiles([]);
      setFilteredMemos([]);
      setFilteredPlugins([]);
      setSystemFolders([]);
      setEverythingResults([]);
      setEverythingTotalCount(null);
      setEverythingCurrentCount(0);
      setDetectedUrls([]);
      setDetectedJson(null);
      setAiAnswer(null); // 清空 AI 回答
      setShowAiAnswer(false); // 退出 AI 回答模式
      setResults([]);
      setSelectedIndex(0);
      setIsSearchingEverything(false);
      return;
    }
    
    // If user is typing new content while in AI answer mode, exit AI answer mode
    if (showAiAnswer) {
      setShowAiAnswer(false);
      setAiAnswer(null);
      setIsAiLoading(false);
    }
    
    // Extract URLs from query (同步操作，不需要防抖)
    const urls = extractUrls(query);
    setDetectedUrls(urls);
    
    // Check if query is valid JSON (同步操作，不需要防抖)
    if (isValidJson(query)) {
      setDetectedJson(query.trim());
    } else {
      setDetectedJson(null);
    }
    
    // 如果查询与上次相同，跳过搜索（去重机制）
    if (trimmedQuery === lastSearchQueryRef.current) {
      return;
    }
    
    // Debounce search to avoid too many requests
    // 优化防抖时间：增加防抖时间以应对频繁输入
    // Short queries (1-2 chars): 400ms (增加延迟，减少频繁搜索)
    // Medium queries (3-5 chars): 300ms
    // Long queries (6+ chars): 200ms (仍然较快响应长查询)
    const queryLength = trimmedQuery.length;
    let debounceTime = 400; // default for short queries
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
      
      const isPathQuery = isLikelyAbsolutePath(trimmedQuery);
      if (isPathQuery) {
        handleDirectPathLookup(trimmedQuery);
      } else {
        setDirectPathResult(null);
      }
      
      // 在防抖结束后、开始搜索前，取消之前的 Everything 搜索
      // 这样可以确保只有在真正开始新搜索时才取消旧搜索
      if (currentSearchRef.current) {
        if (currentSearchRef.current.query !== trimmedQuery) {
          console.log("[DEBUG] Cancelling previous Everything search before starting new search:", {
            previousQuery: currentSearchRef.current.query,
            newQuery: trimmedQuery,
            wasCancelled: currentSearchRef.current.cancelled
          });
          // 标记旧搜索为已取消
          currentSearchRef.current.cancelled = true;
          // 立即清空引用，避免状态混乱
          currentSearchRef.current = null;
        } else {
          console.log("[DEBUG] Same query detected, previous search should continue:", trimmedQuery);
          // query 相同，不取消，直接返回（避免重复搜索）
          return;
        }
      }
      
      // 标记当前查询为已搜索
      lastSearchQueryRef.current = trimmedQuery;
      
      searchApplications(trimmedQuery);
      searchFileHistory(trimmedQuery);
      searchMemos(trimmedQuery);
      handleSearchPlugins(trimmedQuery);
      if (!isPathQuery) {
        searchSystemFolders(trimmedQuery);
      } else {
        setSystemFolders([]);
      }
      if (isEverythingAvailable && !isPathQuery) {
        console.log("Everything is available, calling searchEverything with query:", trimmedQuery);
        searchEverything(trimmedQuery).catch((error) => {
          console.error("searchEverything threw an error:", error);
        });
      } else {
        console.log("Everything is not available or query is path-like, skipping Everything search.", {
          isEverythingAvailable,
          isPathQuery
        });
        if (isPathQuery) {
          // 绝对路径查询不需要 Everything 结果，避免显示旧搜索残留
          setEverythingResults([]);
          setEverythingTotalCount(null);
          setEverythingCurrentCount(0);
          setIsSearchingEverything(false);
        }
      }
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

  // 判断字符串是否包含中文字符
  const containsChinese = (text: string): boolean => {
    return /[\u4E00-\u9FFF]/.test(text);
  };

  // 粗略判断输入是否像是绝对路径（含盘符、UNC 或根路径）
  const isLikelyAbsolutePath = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length < 3) return false;
    const hasSeparator = trimmed.includes("\\") || trimmed.includes("/");
    const drivePattern = /^[a-zA-Z]:[\\/]/;
    const uncPattern = /^\\\\/;
    const rootLike = trimmed.startsWith("/") && hasSeparator;
    return (drivePattern.test(trimmed) || uncPattern.test(trimmed) || rootLike) && hasSeparator;
  };

  // 处理绝对路径直达：存在则生成一个临时文件结果，减少 Everything/系统目录压力
  const handleDirectPathLookup = async (rawPath: string) => {
    try {
      const result = await tauriApi.checkPathExists(rawPath);
      // 只在查询未变化时更新
      if (query.trim() === rawPath.trim() && result) {
        setDirectPathResult(result);
      } else if (query.trim() === rawPath.trim()) {
        setDirectPathResult(null);
      }
    } catch (error) {
      console.error("Direct path lookup failed:", error);
      if (query.trim() === rawPath.trim()) {
        setDirectPathResult(null);
      }
    }
  };

  // 判断结果是否为 .lnk 快捷方式
  const isLnkPath = (result: SearchResult) =>
    result.path?.toLowerCase().endsWith(".lnk");

  // 相关性评分函数
  const calculateRelevanceScore = (
    displayName: string,
    path: string,
    query: string,
    useCount?: number,
    lastUsed?: number,
    isEverything?: boolean,
    isApp?: boolean,  // 新增：标识是否是应用
    namePinyin?: string,  // 新增：应用名称的拼音全拼
    namePinyinInitials?: string,  // 新增：应用名称的拼音首字母
    isFileHistory?: boolean  // 新增：标识是否是历史文件
  ): number => {
    if (!query || !query.trim()) {
      // 如果查询为空，只根据使用频率和时间排序
      let score = 0;
      if (useCount !== undefined) {
        if (isFileHistory) {
          // 历史文件的使用次数加分更高（最多200分），使用次数越多分数越高
          score += Math.min(useCount * 2, 200);
        } else {
          score += Math.min(useCount, 100); // 最多100分
        }
      }
      if (lastUsed !== undefined) {
        // 最近使用时间：距离现在越近分数越高
        // 将时间戳转换为天数，然后计算分数（30天内使用过的有加分）
        const daysSinceUse = (Date.now() - lastUsed) / (1000 * 60 * 60 * 24);
        if (daysSinceUse <= 30) {
          score += Math.max(0, 50 - daysSinceUse * 2); // 30天内：50分递减到0分
        }
      }
      // 历史文件基础加分
      if (isFileHistory) {
        score += 300; // 历史文件基础加分（提高到300分）
      }
      // 应用类型额外加分
      if (isApp) {
        score += 50;
      }
      return score;
    }

    const queryLower = query.toLowerCase().trim();
    const nameLower = displayName.toLowerCase();
    const pathLower = path.toLowerCase();
    const queryLength = queryLower.length;
    const queryIsPinyin = !containsChinese(queryLower); // 判断查询是否是拼音

    let score = 0;

    // 文件名匹配（最高优先级）
    let nameMatchScore = 0;
    if (nameLower === queryLower) {
      // 完全匹配：短查询（2-4字符）给予更高权重
      if (queryLength >= 2 && queryLength <= 4) {
        nameMatchScore = 1500; // 短查询完全匹配给予更高分数
      } else {
        nameMatchScore = 1000; // 完全匹配
      }
    } else if (nameLower.startsWith(queryLower)) {
      nameMatchScore = 500; // 开头匹配
    } else if (nameLower.includes(queryLower)) {
      nameMatchScore = 100; // 包含匹配
    }
    
    score += nameMatchScore;
    
    // 历史文件在文件名匹配时额外加权（匹配分数的30%），确保优先显示
    if (isFileHistory && nameMatchScore > 0) {
      score += Math.floor(nameMatchScore * 0.3); // 额外加30%的匹配分数
    }

    // 拼音匹配（如果查询是拼音且是应用类型）
    if (queryIsPinyin && isApp && (namePinyin || namePinyinInitials)) {
      // 拼音全拼匹配
      if (namePinyin) {
        if (namePinyin === queryLower) {
          score += 800; // 拼音完全匹配给予高分
        } else if (namePinyin.startsWith(queryLower)) {
          score += 400; // 拼音开头匹配
        } else if (namePinyin.includes(queryLower)) {
          score += 150; // 拼音包含匹配
        }
      }

      // 拼音首字母匹配
      if (namePinyinInitials) {
        if (namePinyinInitials === queryLower) {
          score += 600; // 拼音首字母完全匹配给予高分
        } else if (namePinyinInitials.startsWith(queryLower)) {
          score += 300; // 拼音首字母开头匹配
        } else if (namePinyinInitials.includes(queryLower)) {
          score += 120; // 拼音首字母包含匹配
        }
      }
    }

    // 路径匹配（权重较低）
    if (pathLower.includes(queryLower)) {
      // 如果文件名已经匹配，路径匹配的权重更低
      if (score === 0) {
        score += 10; // 只有路径匹配时给10分
      } else {
        score += 5; // 文件名已匹配时只给5分
      }
    }

    // 应用类型额外加分（优先显示应用）
    if (isApp) {
      // 如果应用名称匹配，给予更高的额外加分
      if (nameLower === queryLower || nameLower.startsWith(queryLower) || nameLower.includes(queryLower)) {
        score += 300; // 应用匹配时额外加300分
      } else if (queryIsPinyin && (namePinyin || namePinyinInitials)) {
        // 如果是拼音匹配，也给予额外加分
        if ((namePinyin && (namePinyin === queryLower || namePinyin.startsWith(queryLower) || namePinyin.includes(queryLower))) ||
            (namePinyinInitials && (namePinyinInitials === queryLower || namePinyinInitials.startsWith(queryLower) || namePinyinInitials.includes(queryLower)))) {
          score += 300; // 拼音匹配时也额外加300分
        } else {
          score += 100; // 即使不匹配也给予基础加分
        }
      } else {
        score += 100; // 即使不匹配也给予基础加分
      }
    }

    // Everything 结果：路径深度越浅越好
    if (isEverything) {
      const pathDepth = path.split(/[/\\]/).length;
      // 路径深度越浅，加分越多（最多50分）
      score += Math.max(0, 50 - pathDepth * 2);
    }

    // 历史文件结果：给予基础加分，体现使用历史优势
    if (isFileHistory) {
      score += 300; // 历史文件基础加分（提高到300分），确保优先于 Everything 结果
    }

    // 使用频率加分
    if (useCount !== undefined) {
      if (isFileHistory) {
        // 历史文件的使用次数加分更高（最多200分），使用次数越多分数越高
        score += Math.min(useCount * 2, 200);
      } else {
        // 其他类型最多100分
        score += Math.min(useCount, 100);
      }
    }

    // 最近使用时间加分
    if (lastUsed !== undefined) {
      const daysSinceUse = (Date.now() - lastUsed) / (1000 * 60 * 60 * 24);
      if (daysSinceUse <= 30) {
        score += Math.max(0, 50 - daysSinceUse * 2); // 30天内：50分递减到0分
      }
    }

    return score;
  };

  // Combine apps, files, Everything results, and URLs into results when they change
  // 使用 useMemo 优化，避免不必要的重新计算
  const combinedResults = useMemo(() => {
    // 如果查询为空且没有 AI 回答，直接返回空数组，不显示任何结果
    // 如果有 AI 回答，即使查询为空也要显示
    if (query.trim() === "" && !aiAnswer) {
      return [];
    }
    
    const urlResults: SearchResult[] = detectedUrls.map((url) => ({
      type: "url" as const,
      url,
      displayName: url,
      path: url,
    }));
    
    // JSON 格式化选项
    const jsonFormatterResult: SearchResult[] = detectedJson ? [{
      type: "json_formatter" as const,
      jsonContent: detectedJson,
      displayName: "打开 JSON 格式化查看器",
      path: "json://formatter",
    }] : [];
    
    // 检查 JSON 中是否包含链接
    const jsonContainsLinks = detectedJson ? extractUrls(detectedJson).length > 0 : false;
    
    // 检查是否应该显示"历史访问"结果（只在明确搜索相关关键词时显示）
    const lowerQuery = query.toLowerCase().trim();
    const historyKeywords = ["历史访问", "历史", "访问历史", "ls", "history"];
    const shouldShowHistory = historyKeywords.some(keyword => 
      lowerQuery.includes(keyword.toLowerCase()) || keyword.toLowerCase().includes(lowerQuery)
    );
    
    // 检查是否是启动相关关键词（这些应该优先显示系统启动文件夹，而不是软件设置）
    const startupKeywords = ["开机启动", "自启动", "启动项", "startup", "autostart"];
    const isStartupQuery = startupKeywords.some(keyword => 
      lowerQuery.includes(keyword.toLowerCase()) || keyword.toLowerCase().includes(lowerQuery)
    );
    
    // 检查是否应该显示"设置"结果（排除启动相关关键词）
    const settingsKeywords = ["设置", "settings", "配置", "config"];
    const shouldShowSettings = !isStartupQuery && settingsKeywords.some(keyword => 
      lowerQuery.includes(keyword.toLowerCase()) || keyword.toLowerCase().includes(lowerQuery)
    );
    
    let otherResults: SearchResult[] = [
      // 如果有 AI 回答，将其添加到结果列表的最前面
      ...(aiAnswer ? [{
        type: "ai" as const,
        aiAnswer: aiAnswer,
        displayName: "AI 回答",
        path: "ai://answer",
      }] : []),
      // 如果查询匹配历史访问关键词，添加历史访问结果
      ...(shouldShowHistory ? [{
        type: "history" as const,
        displayName: "历史访问",
        path: "history://shortcuts-config",
      }] : []),
      // 如果查询匹配设置关键词，添加设置结果（但不包括启动相关关键词）
      ...(shouldShowSettings ? [{
        type: "settings" as const,
        displayName: "设置",
        path: "settings://window",
      }] : []),
      // 绝对路径直达结果（如果存在）
      ...(directPathResult ? [{
        type: "file" as const,
        file: directPathResult,
        displayName: directPathResult.name || directPathResult.path,
        path: directPathResult.path,
      }] : []),
      // 如果查询匹配启动相关关键词，添加 Windows 系统启动设置页面
      ...(isStartupQuery ? [{
        type: "url" as const,
        url: "ms-settings:startupapps",
        displayName: "系统启动设置",
        path: "ms-settings:startupapps",
      }] : []),
      ...filteredApps.map((app) => ({
        type: "app" as const,
        app,
        displayName: app.name,
        path: app.path,
      })),
      // 从文件历史记录中分离可执行文件
      ...filteredFiles
        .filter((file) => {
          const pathLower = file.path.toLowerCase();
          return pathLower.endsWith('.exe') || pathLower.endsWith('.lnk');
        })
        .filter((file) => {
          // 检查是否已经在 filteredApps 中，如果已存在则过滤掉
          return !filteredApps.some(app => app.path === file.path);
        })
        .map((file): SearchResult => ({
          type: "app" as const,
          app: {
            name: file.name,
            path: file.path,
            icon: undefined, // 图标将在渲染时尝试从应用列表获取
            description: undefined,
            name_pinyin: undefined,
            name_pinyin_initials: undefined,
          },
          displayName: file.name,
          path: file.path,
        })),
      // 普通文件（非可执行文件）
      ...filteredFiles
        .filter((file) => {
          const pathLower = file.path.toLowerCase();
          return !pathLower.endsWith('.exe') && !pathLower.endsWith('.lnk');
        })
        .map((file) => ({
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
      // 将文件工具箱插件单独提取，优先显示
      ...filteredPlugins
        .filter((plugin) => plugin.id === "file_toolbox")
        .map((plugin) => ({
          type: "plugin" as const,
          plugin,
          displayName: plugin.name,
          path: plugin.id,
        })),
      // 其他插件
      ...filteredPlugins
        .filter((plugin) => plugin.id !== "file_toolbox")
        .map((plugin) => ({
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
      // 从 Everything 结果中分离可执行文件
      ...everythingResults
        .filter((everything) => {
          const pathLower = everything.path.toLowerCase();
          return pathLower.endsWith('.exe') || pathLower.endsWith('.lnk');
        })
        .filter((everything) => {
          // 检查是否已经在 filteredApps 或 filteredFiles 中，如果已存在则过滤掉
          return !filteredApps.some(app => app.path === everything.path) &&
                 !filteredFiles.some(file => file.path === everything.path);
        })
        .map((everything): SearchResult => ({
          type: "app" as const,
          app: {
            name: everything.name,
            path: everything.path,
            icon: undefined, // 图标将在渲染时尝试从应用列表获取
            description: undefined,
            name_pinyin: undefined,
            name_pinyin_initials: undefined,
          },
          displayName: everything.name,
          path: everything.path,
        })),
      // 普通 Everything 结果（非可执行文件）
      ...everythingResults
        .filter((everything) => {
          const pathLower = everything.path.toLowerCase();
          return !pathLower.endsWith('.exe') && !pathLower.endsWith('.lnk');
        })
        .map((everything) => ({
          type: "everything" as const,
          everything,
          displayName: everything.name,
          path: everything.path,
        })),
    ];
    
    // 对结果进行去重：如果同一个路径出现在多个结果源中，只保留一个
    // 优先保留历史文件结果（因为历史记录包含使用频率和最近使用时间，排序更准确）
    // 先收集历史文件结果的路径集合
    const historyFilePaths = new Set<string>();
    for (const result of otherResults) {
      if (result.type === "file") {
        const normalizedPath = result.path.toLowerCase().replace(/\\/g, "/");
        historyFilePaths.add(normalizedPath);
      }
    }
    
    // 过滤掉 Everything 结果中与历史文件结果重复的路径
    const deduplicatedResults: SearchResult[] = [];
    for (const result of otherResults) {
      // 对于特殊类型（AI、历史、设置等）和 URL，不需要去重
      if (result.type === "ai" || result.type === "history" || result.type === "settings" || result.type === "url" || result.type === "json_formatter" || result.type === "plugin") {
        deduplicatedResults.push(result);
        continue;
      }
      
      // 对于历史文件类型，直接添加（优先保留）
      if (result.type === "file") {
        deduplicatedResults.push(result);
        continue;
      }
      
      // 对于 Everything 类型，检查是否已在历史文件结果中
      if (result.type === "everything") {
        const normalizedPath = result.path.toLowerCase().replace(/\\/g, "/");
        if (!historyFilePaths.has(normalizedPath)) {
          deduplicatedResults.push(result);
        }
        // 如果路径已在历史文件结果中，跳过（不添加 Everything 结果）
        continue;
      }
      
      // 对于其他类型（app、system_folder 等），检查路径是否重复
      const normalizedPath = result.path.toLowerCase().replace(/\\/g, "/");
      if (!historyFilePaths.has(normalizedPath)) {
        deduplicatedResults.push(result);
      }
    }
    
    // 使用去重后的结果
    otherResults = deduplicatedResults;
    
    // 使用相关性评分系统对所有结果进行排序
    // 性能优化：当结果数量过多时，只对前1000条进行排序，避免对大量结果排序造成卡顿
    const MAX_SORT_COUNT = 1000;
    const needsSorting = otherResults.length > MAX_SORT_COUNT;
    
    if (needsSorting) {
      // 先分离特殊类型（这些总是排在最前面，不需要排序）
      const specialTypes = ["ai", "history", "settings"];
      const specialResults: SearchResult[] = [];
      const pluginResults: SearchResult[] = [];
      const regularResults: SearchResult[] = [];
      
      for (const result of otherResults) {
        if (specialTypes.includes(result.type)) {
          specialResults.push(result);
        } else if (result.type === "plugin") {
          // 所有插件单独提取，优先显示
          pluginResults.push(result);
        } else {
          regularResults.push(result);
        }
      }
      
      // 只对前 MAX_SORT_COUNT 条常规结果进行排序
      const toSort = regularResults.slice(0, MAX_SORT_COUNT);
      const rest = regularResults.slice(MAX_SORT_COUNT);
      
      toSort.sort((a, b) => {
        // 获取使用频率和最近使用时间
        const aUseCount = a.file?.use_count;
        const aLastUsed = a.file?.last_used || openHistory[a.path] || 0;
        const bUseCount = b.file?.use_count;
        const bLastUsed = b.file?.last_used || openHistory[b.path] || 0;

        // 计算相关性评分
        const aScore = calculateRelevanceScore(
          a.displayName,
          a.path,
          query,
          aUseCount,
          aLastUsed,
          a.type === "everything",
          a.type === "app",  // 新增：标识是否是应用
          a.app?.name_pinyin,  // 新增：应用拼音全拼
          a.app?.name_pinyin_initials,  // 新增：应用拼音首字母
          a.type === "file"  // 新增：标识是否是历史文件
        );
        const bScore = calculateRelevanceScore(
          b.displayName,
          b.path,
          query,
          bUseCount,
          bLastUsed,
          b.type === "everything",
          b.type === "app",  // 新增：标识是否是应用
          b.app?.name_pinyin,  // 新增：应用拼音全拼
          b.app?.name_pinyin_initials,  // 新增：应用拼音首字母
          b.type === "file"  // 新增：标识是否是历史文件
        );

        // Everything 内部快捷方式 (.lnk) 优先
        if (a.type === "everything" && b.type === "everything") {
          const aLnk = isLnkPath(a);
          const bLnk = isLnkPath(b);
          if (aLnk !== bLnk) return aLnk ? -1 : 1;
        }

        // 历史文件始终优先于 Everything（即使分数更低）
        if (a.type === "file" && b.type === "everything") return -1;
        if (a.type === "everything" && b.type === "file") return 1;

        // 按评分降序排序（分数高的在前）
        if (bScore !== aScore) {
          // 如果评分差距在200分以内，且一个是历史文件，另一个是 Everything 结果，优先历史文件
          const scoreDiff = Math.abs(bScore - aScore);
          if (scoreDiff <= 200) {
            if (a.type === "file" && b.type === "everything") return -1; // 历史文件优先
            if (a.type === "everything" && b.type === "file") return 1; // 历史文件优先
          }
          return bScore - aScore;
        }

        // 如果评分相同，优先顺序：应用 > 历史文件 > Everything > 其他，然后按最近使用时间排序
        if (a.type === "app" && b.type !== "app") return -1;
        if (a.type !== "app" && b.type === "app") return 1;
        if (a.type === "file" && b.type === "everything") return -1; // 历史文件优先于 Everything
        if (a.type === "everything" && b.type === "file") return 1; // 历史文件优先于 Everything
        return bLastUsed - aLastUsed;
      });
      
      // 重新组合：特殊类型 + 所有插件 + 排序后的前部分 + 未排序的后部分
      otherResults = [...specialResults, ...pluginResults, ...toSort, ...rest];
    } else {
      // 结果数量较少时，直接排序所有结果
      otherResults.sort((a, b) => {
        // 特殊类型的结果保持最高优先级（AI、历史、设置等）
        const specialTypes = ["ai", "history", "settings"];
        const aIsSpecial = specialTypes.includes(a.type);
        const bIsSpecial = specialTypes.includes(b.type);
        
        // 所有插件优先级仅次于特殊类型
        const aIsPlugin = a.type === "plugin";
        const bIsPlugin = b.type === "plugin";
        
        if (aIsSpecial && !bIsSpecial) return -1;
        if (!aIsSpecial && bIsSpecial) return 1;
        if (aIsSpecial && bIsSpecial) {
          // 特殊类型之间保持原有顺序
          return 0;
        }
        
        // 所有插件优先级处理
        if (aIsPlugin && !bIsPlugin && !bIsSpecial) return -1;
        if (!aIsPlugin && bIsPlugin && !aIsSpecial) return 1;

        // 获取使用频率和最近使用时间
        const aUseCount = a.file?.use_count;
        const aLastUsed = a.file?.last_used || openHistory[a.path] || 0;
        const bUseCount = b.file?.use_count;
        const bLastUsed = b.file?.last_used || openHistory[b.path] || 0;

        // 计算相关性评分
        const aScore = calculateRelevanceScore(
          a.displayName,
          a.path,
          query,
          aUseCount,
          aLastUsed,
          a.type === "everything",
          a.type === "app",  // 新增：标识是否是应用
          a.app?.name_pinyin,  // 新增：应用拼音全拼
          a.app?.name_pinyin_initials,  // 新增：应用拼音首字母
          a.type === "file"  // 新增：标识是否是历史文件
        );
        const bScore = calculateRelevanceScore(
          b.displayName,
          b.path,
          query,
          bUseCount,
          bLastUsed,
          b.type === "everything",
          b.type === "app",  // 新增：标识是否是应用
          b.app?.name_pinyin,  // 新增：应用拼音全拼
          b.app?.name_pinyin_initials,  // 新增：应用拼音首字母
          b.type === "file"  // 新增：标识是否是历史文件
        );

        // Everything 内部快捷方式 (.lnk) 优先
        if (a.type === "everything" && b.type === "everything") {
          const aLnk = isLnkPath(a);
          const bLnk = isLnkPath(b);
          if (aLnk !== bLnk) return aLnk ? -1 : 1;
        }

        // 历史文件始终优先于 Everything（即使分数更低）
        if (a.type === "file" && b.type === "everything") return -1;
        if (a.type === "everything" && b.type === "file") return 1;

        // 按评分降序排序（分数高的在前）
        if (bScore !== aScore) {
          // 如果评分差距在200分以内，且一个是历史文件，另一个是 Everything 结果，优先历史文件
          const scoreDiff = Math.abs(bScore - aScore);
          if (scoreDiff <= 200) {
            if (a.type === "file" && b.type === "everything") return -1; // 历史文件优先
            if (a.type === "everything" && b.type === "file") return 1; // 历史文件优先
          }
          return bScore - aScore;
        }

        // 如果评分相同，优先顺序：应用 > 历史文件 > Everything > 其他，然后按最近使用时间排序
        if (a.type === "app" && b.type !== "app") return -1;
        if (a.type !== "app" && b.type === "app") return 1;
        if (a.type === "file" && b.type === "everything") return -1; // 历史文件优先于 Everything
        if (a.type === "everything" && b.type === "file") return 1; // 历史文件优先于 Everything
        return bLastUsed - aLastUsed;
      });
    }
    
    // 提取所有插件，放在最前面
    const pluginResults = otherResults.filter(
      (result) => result.type === "plugin"
    );
    const otherResultsWithoutPlugins = otherResults.filter(
      (result) => result.type !== "plugin"
    );
    
    // 如果 JSON 中包含链接，优先显示 JSON 格式化选项，否则按原来的顺序（URLs -> JSON formatter -> other results）
    // 但所有插件始终在最前面
    if (jsonContainsLinks && jsonFormatterResult.length > 0) {
      return [...pluginResults, ...jsonFormatterResult, ...urlResults, ...otherResultsWithoutPlugins];
    } else {
      // URLs always come first, then JSON formatter, then other results sorted by open history
      // 但所有插件始终在最前面
      return [...pluginResults, ...urlResults, ...jsonFormatterResult, ...otherResultsWithoutPlugins];
    }
  }, [filteredApps, filteredFiles, filteredMemos, filteredPlugins, systemFolders, everythingResults, detectedUrls, detectedJson, openHistory, query, aiAnswer]);

  // 使用 ref 来跟踪当前的 query，避免闭包问题
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  // 分批加载结果的函数
  const loadResultsIncrementally = (allResults: SearchResult[]) => {
    // 取消之前的增量加载（包括 animationFrame 和 setTimeout）
    if (incrementalLoadRef.current !== null) {
      cancelAnimationFrame(incrementalLoadRef.current);
      incrementalLoadRef.current = null;
    }
    if (incrementalTimeoutRef.current !== null) {
      clearTimeout(incrementalTimeoutRef.current);
      incrementalTimeoutRef.current = null;
    }

    // 如果 query 为空且没有结果（包括 AI 回答），直接清空结果并返回
    if (queryRef.current.trim() === "" && allResults.length === 0) {
      setResults([]);
      currentLoadResultsRef.current = [];
      return;
    }

    // 保存当前要加载的结果引用，用于后续验证
    currentLoadResultsRef.current = allResults;

    const INITIAL_COUNT = 100; // 初始显示100条
    const INCREMENT = 50; // 每次增加50条
    const DELAY_MS = 16; // 每帧延迟（约60fps）

    // 重置显示数量（如果有结果就显示，即使查询为空）
    if (allResults.length > 0) {
      setResults(allResults.slice(0, INITIAL_COUNT));
    } else {
      setResults([]);
      currentLoadResultsRef.current = [];
      return;
    }

    // 如果结果数量少于初始数量，直接返回
    if (allResults.length <= INITIAL_COUNT) {
      setResults(allResults);
      currentLoadResultsRef.current = [];
      return;
    }

    // 逐步加载更多结果
    let currentCount = INITIAL_COUNT;
    const loadMore = () => {
      // 在每次更新前检查：query 是否为空，以及结果是否已过时
      if (queryRef.current.trim() === "" || 
          currentLoadResultsRef.current !== allResults) {
        // 结果已过时或查询已清空，停止加载
        setResults([]);
        incrementalLoadRef.current = null;
        incrementalTimeoutRef.current = null;
        currentLoadResultsRef.current = [];
        return;
      }

      if (currentCount < allResults.length) {
        currentCount = Math.min(currentCount + INCREMENT, allResults.length);
        
        // 再次检查结果是否仍然有效
        if (queryRef.current.trim() !== "" && 
            currentLoadResultsRef.current === allResults) {
          setResults(allResults.slice(0, currentCount));
        } else {
          // 结果已过时，停止加载
          setResults([]);
          incrementalLoadRef.current = null;
          incrementalTimeoutRef.current = null;
          currentLoadResultsRef.current = [];
          return;
        }
        
        if (currentCount < allResults.length) {
          // 使用嵌套的 requestAnimationFrame 和 setTimeout 来确保正确的取消机制
          incrementalLoadRef.current = requestAnimationFrame(() => {
            // 再次检查是否仍然有效
            if (currentLoadResultsRef.current !== allResults) {
              incrementalLoadRef.current = null;
              return;
            }
            incrementalTimeoutRef.current = setTimeout(loadMore, DELAY_MS) as unknown as number;
          });
        } else {
          // 加载完成
          incrementalLoadRef.current = null;
          incrementalTimeoutRef.current = null;
          currentLoadResultsRef.current = [];
        }
      } else {
        // 加载完成
        incrementalLoadRef.current = null;
        incrementalTimeoutRef.current = null;
        currentLoadResultsRef.current = [];
      }
    };

    // 开始增量加载
    incrementalLoadRef.current = requestAnimationFrame(() => {
      // 再次检查结果是否仍然有效
      if (currentLoadResultsRef.current !== allResults) {
        incrementalLoadRef.current = null;
        return;
      }
      incrementalTimeoutRef.current = setTimeout(loadMore, DELAY_MS) as unknown as number;
    });
  };

  useEffect(() => {
    // 如果查询为空且没有 AI 回答，直接清空结果
    if (query.trim() === "" && !aiAnswer) {
      setResults([]);
      // 取消所有增量加载任务
      if (incrementalLoadRef.current !== null) {
        cancelAnimationFrame(incrementalLoadRef.current);
        incrementalLoadRef.current = null;
      }
      if (incrementalTimeoutRef.current !== null) {
        clearTimeout(incrementalTimeoutRef.current);
        incrementalTimeoutRef.current = null;
      }
      currentLoadResultsRef.current = [];
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
      if (incrementalTimeoutRef.current !== null) {
        clearTimeout(incrementalTimeoutRef.current);
        incrementalTimeoutRef.current = null;
      }
      currentLoadResultsRef.current = [];
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
    if (isMemoModalOpen) {
      return;
    }
    
    const delay = needPreserveScroll ? 600 : 100; // 减少延迟，让响应更快
    const timeoutId = setTimeout(() => {
      const adjustWindowSize = () => {
        const window = getCurrentWindow();
        const whiteContainer = getMainContainer();
        if (whiteContainer && !isMemoModalOpen) {
          // Use double requestAnimationFrame to ensure DOM is fully updated
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              // Use scrollWidth/scrollHeight to get the full content size
              const containerHeight = whiteContainer.scrollHeight;
              // Use saved window width
              const targetWidth = windowWidth;
              
              // 限制最大高度，避免窗口突然撑高导致不丝滑
              const MAX_HEIGHT = 600; // 最大高度600px
              const MIN_HEIGHT = 200; // 最小高度200px，默认主界面更高
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
  }, [combinedResults, isMemoModalOpen]);

    // Adjust window size when results actually change
    useEffect(() => {
      // 如果备忘录模态框打开，不在这里调整窗口大小
      if (isMemoModalOpen) {
        return;
      }
      
      const adjustWindowSize = () => {
        const window = getCurrentWindow();
      const whiteContainer = getMainContainer();
        if (whiteContainer && !isMemoModalOpen) {
          // Use double requestAnimationFrame to ensure DOM is fully updated
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const containerRect = whiteContainer.getBoundingClientRect();
              let containerHeight = containerRect.height;

              // 如果剪切板 URL 弹窗存在，取主界面和弹窗中更高的那个作为基准高度
              if (clipboardUrlToOpen) {
                const clipboardModal = document.querySelector('.clipboard-url-modal') as HTMLElement | null;
                if (clipboardModal) {
                  const modalRect = clipboardModal.getBoundingClientRect();
                  // 适当增加一些边距，避免贴边
                  const modalHeightWithMargin = modalRect.height + 32;
                  containerHeight = Math.max(containerHeight, modalHeightWithMargin);
                }
              }
              // Use saved window width
              const targetWidth = windowWidth;
              
              // 限制最大高度，避免窗口突然撑高导致不丝滑
              // 如果检测到剪切板中的链接（弹窗显示），适当提高主界面的最小/最大高度
              const MAX_HEIGHT = clipboardUrlToOpen ? 720 : 600; // 有弹窗时允许更高
              const MIN_HEIGHT = clipboardUrlToOpen ? 260 : 200; // 有弹窗时整体更高一点
              const targetHeight = Math.max(MIN_HEIGHT, Math.min(containerHeight, MAX_HEIGHT));
              
              // 直接设置窗口大小（简化版本，不使用动画过渡以避免复杂性）
              window.setSize(new LogicalSize(targetWidth, targetHeight)).catch(console.error);
            });
          });
        }
      };
      
      // Adjust size after results state updates (减少延迟)
      setTimeout(adjustWindowSize, 100);
    }, [results, isMemoModalOpen, windowWidth, clipboardUrlToOpen]);

  // Update window size when windowWidth changes (but not during resizing)
  useEffect(() => {
    if (isMemoModalOpen || isPluginListModalOpen || isResizing) {
      return;
    }
    
    const adjustWindowSize = () => {
      const window = getCurrentWindow();
      const whiteContainer = getMainContainer();
      if (whiteContainer) {
        let containerHeight = whiteContainer.scrollHeight;

        // 剪切板 URL 弹窗时，确保窗口高度也能完整容纳弹窗
        if (clipboardUrlToOpen) {
          const clipboardModal = document.querySelector('.clipboard-url-modal') as HTMLElement | null;
          if (clipboardModal) {
            const modalRect = clipboardModal.getBoundingClientRect();
            const modalHeightWithMargin = modalRect.height + 32;
            containerHeight = Math.max(containerHeight, modalHeightWithMargin);
          }
        }

        // 剪切板链接弹窗出现时，提高主界面整体高度上限/下限
        const MAX_HEIGHT = clipboardUrlToOpen ? 720 : 600;
        const MIN_HEIGHT = clipboardUrlToOpen ? 260 : 200;
        const targetHeight = Math.max(MIN_HEIGHT, Math.min(containerHeight, MAX_HEIGHT));
        window.setSize(new LogicalSize(windowWidth, targetHeight)).catch(console.error);
      }
    };
    
    setTimeout(adjustWindowSize, 50);
  }, [windowWidth, isMemoModalOpen, isPluginListModalOpen, isResizing, clipboardUrlToOpen]);

  // Handle window width resizing
  useEffect(() => {
    if (!isResizing) return;

    const whiteContainer = getMainContainer();
    if (!whiteContainer) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Cancel any pending animation frame
      if (resizeRafId.current !== null) {
        cancelAnimationFrame(resizeRafId.current);
      }

      // Use requestAnimationFrame to smooth out updates
      resizeRafId.current = requestAnimationFrame(() => {
        // Calculate new width based on mouse movement from start position
        const deltaX = e.clientX - resizeStartX.current;
        const newWidth = Math.max(400, Math.min(1200, resizeStartWidth.current + deltaX));
        
        // Update window size directly without triggering state update during drag
        const window = getCurrentWindow();
        const containerHeight = whiteContainer.scrollHeight;
        const MAX_HEIGHT = clipboardUrlToOpen ? 720 : 600;
        const MIN_HEIGHT = clipboardUrlToOpen ? 260 : 200;
        const targetHeight = Math.max(MIN_HEIGHT, Math.min(containerHeight, MAX_HEIGHT));
        
        // Update container width directly for immediate visual feedback
        whiteContainer.style.width = `${newWidth}px`;
        
        // Update window size
        window.setSize(new LogicalSize(newWidth, targetHeight)).catch(console.error);
      });
    };

    const handleMouseUp = () => {
      // Cancel any pending animation frame
      if (resizeRafId.current !== null) {
        cancelAnimationFrame(resizeRafId.current);
        resizeRafId.current = null;
      }

      // Get final width from container
      const whiteContainer = getMainContainer();
      if (whiteContainer) {
        const finalWidth = whiteContainer.offsetWidth;
        setWindowWidth(finalWidth);
        localStorage.setItem('launcher-window-width', finalWidth.toString());
      }

      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      if (resizeRafId.current !== null) {
        cancelAnimationFrame(resizeRafId.current);
      }
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

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
  // 跟踪当前显示的搜索 query，用于判断是否是新搜索（避免闪烁）
  const displayedSearchQueryRef = useRef<string>("");

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

        // 如果已经收到最终结果，忽略批次事件（防止重复添加）
        // 因为批次事件和最终结果包含相同的数据，如果最终结果已经设置，批次事件就是重复的
        if (finalResultsSetRef.current) {
          console.log("[DEBUG] Ignoring batch event because final results already set");
          return;
        }

        // 如果当前 query 为空，忽略批次结果（防止在清空搜索后仍显示结果）
        // 使用函数式更新来获取最新的 query 值
        setEverythingResults((prev) => {
          // 检查当前 query 是否为空（通过检查 currentSearchRef）
          if (!currentSearchRef.current || currentSearchRef.current.cancelled) {
            return prev; // 保持当前状态，不更新
          }
          
          const currentQuery = currentSearchRef.current.query;
          
          // 如果这是新搜索的第一批（query 不同），清空旧结果并替换为新结果
          // 这样可以避免在切换搜索关键词时出现闪烁
          if (displayedSearchQueryRef.current !== currentQuery) {
            displayedSearchQueryRef.current = currentQuery;
            return batchResults.slice(); // 拷贝一份，替换旧结果
          }
          
          // 如果这是新搜索的第一批（prev.length === 0），直接用这一批
          if (prev.length === 0) {
            displayedSearchQueryRef.current = currentQuery;
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
      displayedSearchQueryRef.current = ""; // 清空显示的搜索 query
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
      displayedSearchQueryRef.current = ""; // 清空显示的搜索 query
      return;
    }
    
    // 检查是否是重复调用
    // 注意：防抖结束后已经检查过了，但这里需要再次检查，因为可能有异步调用
    if (currentSearchRef.current) {
      if (currentSearchRef.current.query === searchQuery) {
        // 如果 query 相同，说明是重复调用，不应该取消
        console.log("[DEBUG] Search with same query already in progress, skipping duplicate call:", searchQuery);
        return;
      }
      // 如果 query 不同，说明在防抖结束后已经被取消了
      // 清空旧引用，确保状态一致性
      console.log("[DEBUG] Previous search was already cancelled in debounce handler, clearing ref:", {
        previousQuery: currentSearchRef.current.query,
        newQuery: searchQuery
      });
      currentSearchRef.current = null;
    }
    
    // 创建新的搜索请求（确保在清空旧引用后才创建新引用）
    const searchRequest = { query: searchQuery, cancelled: false };
    currentSearchRef.current = searchRequest;
    console.log("[DEBUG] Starting new Everything search:", {
      query: searchQuery,
      timestamp: new Date().toISOString()
    });
    
    // 性能优化：不要立即清空旧结果，避免列表闪烁
    // 旧结果会保留显示，直到新结果的第一批到达（在批次事件处理中清空）
    // 只重置计数和 loading 状态
    setEverythingTotalCount(null);
    setEverythingCurrentCount(0);
    setIsSearchingEverything(true);
    
    // 标记：最终结果尚未设置，仅用于后面做校验日志
    finalResultsSetRef.current = false;
    
    try {
      console.log("[DEBUG] About to call tauriApi.searchEverything with query:", searchQuery);
      console.log("[DEBUG] Current search ref state:", {
        current: currentSearchRef.current ? {
          query: currentSearchRef.current.query,
          cancelled: currentSearchRef.current.cancelled
        } : null
      });
      const response = await tauriApi.searchEverything(searchQuery);
      console.log("[DEBUG] tauriApi.searchEverything returned successfully for query:", searchQuery);
      
      // 检查是否是当前搜索，以及 query 是否仍然有效
      if (currentSearchRef.current?.cancelled || 
          currentSearchRef.current?.query !== searchQuery ||
          query.trim() !== searchQuery.trim()) {
        console.log("Search was cancelled or superseded, ignoring final response");
        // 如果搜索被取消，确保清理状态
        if (currentSearchRef.current?.cancelled || currentSearchRef.current?.query !== searchQuery) {
          setIsSearchingEverything(false);
        }
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
        // 对结果进行去重，基于路径（path）字段，防止重复显示
        // 性能优化：使用 Map 实现 O(n) 去重，而不是 O(n²) 的 findIndex
        // 性能优化：使用 requestIdleCallback 延迟处理大量结果，避免阻塞主线程
        const processResults = () => {
          const seenPaths = new Map<string, EverythingResult>();
          const uniqueResults: EverythingResult[] = [];
          for (const result of response.results) {
            if (!seenPaths.has(result.path)) {
              seenPaths.set(result.path, result);
              uniqueResults.push(result);
            }
          }
          setEverythingResults(uniqueResults);
          setEverythingTotalCount(response.total_count);
          setEverythingCurrentCount(uniqueResults.length);
          // 更新显示的搜索 query
          displayedSearchQueryRef.current = searchQuery;
        };
        
        // 如果结果数量较少，立即处理；否则延迟处理以避免阻塞 UI
        if (response.results.length <= 20) {
          processResults();
        } else {
          // 使用 setTimeout 将处理延迟到下一个事件循环，让 UI 有机会更新
          setTimeout(processResults, 0);
        }
      } else {
        // Query 已改变，清空结果
        setEverythingResults([]);
        setEverythingTotalCount(null);
        setEverythingCurrentCount(0);
        displayedSearchQueryRef.current = ""; // 清空显示的搜索 query
      }
      
      finalResultsSetRef.current = true;
    } catch (error) {
      if (currentSearchRef.current?.cancelled || currentSearchRef.current?.query !== searchQuery) {
        console.log("Search was cancelled, ignoring error");
        // 如果搜索被取消，确保清理状态
        setIsSearchingEverything(false);
        return;
      }
      
      console.error("Failed to search Everything:", error);
      setEverythingResults([]);
      setEverythingTotalCount(null);
      setEverythingCurrentCount(0);
      
      // 失败时重查状态（只有在特定错误时才更新状态）
      const errorStr = typeof error === 'string' ? error : String(error);
      console.error("Everything search error:", errorStr);
      
      // 只有在明确的错误（如未安装、服务未运行）时才更新状态
      // 其他错误（如取消、超时等）不应该影响 isEverythingAvailable
      if (
        errorStr.includes('NOT_INSTALLED') || 
        errorStr.includes('SERVICE_NOT_RUNNING') ||
        errorStr.includes('not found') ||
        errorStr.includes('未找到') ||
        errorStr.includes('未运行')
      ) {
        try {
          const status = await tauriApi.getEverythingStatus();
          console.log("Re-checking Everything status after error:", status);
          setIsEverythingAvailable(status.available);
          setEverythingError(status.error || null);
          
          if (!status.available) {
            console.warn("Everything became unavailable after search failed:", status.error);
          }
        } catch (statusError) {
          console.error("Failed to re-check Everything status:", statusError);
          // 只有在确认服务不可用时才设置为 false
          setIsEverythingAvailable(false);
          setEverythingError("搜索失败后无法重新检查状态");
        }
      } else if (errorStr.includes('搜索已取消') || errorStr.includes('搜索正在进行中') || errorStr.includes('跳过重复调用')) {
        // 搜索被取消或重复调用是正常情况，不应该影响状态
        console.log("Search was cancelled or duplicate, this is normal:", errorStr);
        // 如果是重复调用，确保清理状态
        if (errorStr.includes('跳过重复调用')) {
          setIsSearchingEverything(false);
        }
      } else {
        // 其他错误（如超时等），不更新 isEverythingAvailable
        console.warn("Everything search failed with unknown error, keeping current status:", errorStr);
      }
    } finally {
      // 只有当前仍是本次搜索时才结束 loading 状态
      // 如果搜索被取消或 superseded，也要清理状态
      if (currentSearchRef.current?.query === searchQuery && !currentSearchRef.current?.cancelled) {
        setIsSearchingEverything(false);
      } else if (currentSearchRef.current?.cancelled || currentSearchRef.current?.query !== searchQuery) {
        // 搜索被取消或 superseded，清理状态
        setIsSearchingEverything(false);
      }
    }
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

  const handleDownloadEverything = async () => {
    try {
      setIsDownloadingEverything(true);
      setEverythingDownloadProgress(0);

      const installerPath = await tauriApi.downloadEverything();
      setEverythingDownloadProgress(100);

      // 下载完成后，临时取消窗口置顶，确保安装程序显示在启动器之上
      const window = getCurrentWindow();
      await window.setAlwaysOnTop(false);

      // 自动打开安装程序
      await tauriApi.launchFile(installerPath);

      // 下载逻辑结束，重置下载状态（不再弹出遮挡安装向导的提示框）
      setIsDownloadingEverything(false);
      setEverythingDownloadProgress(0);
    } catch (error) {
      console.error("Failed to download Everything:", error);
      setIsDownloadingEverything(false);
      setEverythingDownloadProgress(0);
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
        if (path) {
          console.log("Everything found at:", path);
        }
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

      if (result.type === "ai" && result.aiAnswer) {
        // AI 回答点击时，可以复制到剪贴板或什么都不做
        // 这里暂时不做任何操作，只是显示结果
        return;
      } else if (result.type === "url" && result.url) {
        await tauriApi.openUrl(result.url);
        // 打开链接后隐藏启动器
        await hideLauncherAndResetState();
        return;
      } else if (result.type === "json_formatter" && result.jsonContent) {
        // 打开 JSON 格式化窗口并传递 JSON 内容
        await tauriApi.showJsonFormatterWindow();
        // 使用事件传递 JSON 内容到格式化窗口
        // 延迟发送事件，确保窗口已创建并准备好接收事件
        // 使用多个延迟确保窗口完全初始化
        setTimeout(async () => {
          try {
            const { emit } = await import("@tauri-apps/api/event");
            await emit("json-formatter:set-content", result.jsonContent);
          } catch (error) {
            console.error("Failed to send JSON content to formatter window:", error);
            // 如果第一次失败，再试一次
            setTimeout(async () => {
              try {
                const { emit } = await import("@tauri-apps/api/event");
                await emit("json-formatter:set-content", result.jsonContent);
              } catch (retryError) {
                console.error("Failed to send JSON content to formatter window (retry):", retryError);
              }
            }, 500);
          }
        }, 500);
        // 关闭启动器
        await hideLauncherAndResetState();
        return;
      } else if (result.type === "history") {
        // 打开历史访问窗口
        await tauriApi.showShortcutsConfig();
        // 不关闭启动器，让用户查看历史访问
        return;
      } else if (result.type === "settings") {
        // 打开设置窗口，失败时给出可见提示，避免用户感知为“无反应”
        try {
          await tauriApi.showSettingsWindow();
          // 关闭启动器
          await hideLauncherAndResetState();
        } catch (error) {
          console.error("Failed to open settings window:", error);
          alert("打开设置窗口失败，请重试（详情见控制台日志）");
        }
        return;
      } else if (result.type === "app" && result.app) {
        await tauriApi.launchApplication(result.app);
        trackEvent("app_launched", { name: result.app.name });
      } else if (result.type === "file" && result.file) {
        await tauriApi.launchFile(result.file.path);
      } else if (result.type === "everything" && result.everything) {
        // Launch Everything result and add to file history
        await tauriApi.launchFile(result.everything.path);
        await tauriApi.addFileToHistory(result.everything.path);
      } else if (result.type === "system_folder" && result.systemFolder) {
        // Launch system folder
        await tauriApi.launchFile(result.systemFolder.path);
        // 尝试添加到历史记录（失败也不影响）
        try {
          await tauriApi.addFileToHistory(result.systemFolder.path);
        } catch (error) {
          console.error("Failed to add system folder to history:", error);
        }
        // 打开系统文件夹后隐藏启动器
        await hideLauncherAndResetState();
        return;
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
        setContextMenu(null);
        return;
      }
      // Hide launcher window after launch
      await hideLauncherAndResetState();
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
      // 如果应用中心弹窗已打开，关闭应用中心并隐藏窗口（插件像独立软件一样运行）
      if (isPluginListModalOpen) {
        setIsPluginListModalOpen(false);
        // 延迟隐藏窗口，让关闭动画完成
        setTimeout(() => {
          hideLauncherAndResetState();
        }, 100);
        return;
      }
      // 如果备忘录弹窗已打开，关闭备忘录并隐藏窗口（插件像独立软件一样运行）
      if (isMemoModalOpen) {
        resetMemoState();
        // 延迟隐藏窗口，让关闭动画完成
        setTimeout(() => {
          hideLauncherAndResetState();
        }, 100);
        return;
      }
      await hideLauncherAndResetState({ resetMemo: true });
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
        background: layout.wrapperBg,
        margin: 0,
        padding: 0,
        width: '100%',
        minHeight: '100%'
      }}
      tabIndex={-1}
      onMouseDown={async (e) => {
        // Allow dragging from empty areas (not on white container)
        const target = e.target as HTMLElement;
        // 避免在结果列表滚动条上触发窗口拖动
        if (target.closest('.results-list-scroll')) {
          return;
        }
        if (target === e.currentTarget || !target.closest('.bg-white')) {
          await startWindowDragging();
        }
      }}
      onKeyDown={async (e) => {
        if (e.key === "Escape" || e.keyCode === 27) {
          e.preventDefault();
          e.stopPropagation();
          // 如果应用中心弹窗已打开，关闭应用中心并隐藏窗口（插件像独立软件一样运行）
          if (isPluginListModalOpen) {
            setIsPluginListModalOpen(false);
            // 延迟隐藏窗口，让关闭动画完成
            setTimeout(() => {
              hideLauncherAndResetState();
            }, 100);
            return;
          }
          // 如果备忘录弹窗已打开，关闭备忘录并隐藏窗口（插件像独立软件一样运行）
          if (isMemoModalOpen) {
            resetMemoState();
            // 延迟隐藏窗口，让关闭动画完成
            setTimeout(() => {
              hideLauncherAndResetState();
            }, 100);
            return;
          }
          await hideLauncherAndResetState({ resetMemo: true });
        }
      }}
    >
      {/* Main Search Container - utools style */}
      {/* 当显示插件模态框时，隐藏搜索界面 */}
      {!(isMemoModalOpen || isPluginListModalOpen) && (
      <div className="w-full flex justify-center relative">
        <div 
          className={layout.container}
          ref={containerRef}
          style={{ minHeight: '200px', width: `${windowWidth}px` }}
        >
          {/* Search Box */}
          <div 
            className={layout.header}
            onMouseDown={async (e) => {
              // Only start dragging if clicking on the container or search icon, not on input
              const target = e.target as HTMLElement;
              if (target.tagName !== 'INPUT' && !target.closest('input')) {
                await startWindowDragging();
              }
            }}
            style={{ cursor: 'move' }}
          >
            <div className="flex items-center gap-3">
              <svg
                className={layout.searchIcon}
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
                className={layout.input}
                style={{ cursor: 'text' }}
                autoFocus
                onFocus={(e) => {
                  // Ensure input is focused, but don't select text if user is typing
                  e.target.focus();
                }}
                onMouseDown={(e) => {
                  // Prevent dragging when clicking on input
                  e.stopPropagation();
                  // Close context menu when clicking on search input
                  if (contextMenu) {
                    setContextMenu(null);
                  }
                }}
              />
              {/* 应用中心按钮 */}
              <div
                className="relative flex items-center justify-center"
                onMouseEnter={() => setIsHoveringAiIcon(true)}
                onMouseLeave={() => setIsHoveringAiIcon(false)}
                onClick={async (e) => {
                  e.stopPropagation();
                  await tauriApi.showPluginListWindow();
                  await hideLauncherAndResetState();
                }}
                onMouseDown={(e) => {
                  // Prevent dragging when clicking on icon
                  e.stopPropagation();
                }}
                style={{ cursor: 'pointer', minWidth: '24px', minHeight: '24px' }}
                title="应用中心"
              >
                <svg
                  className={layout.pluginIcon(isHoveringAiIcon)}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  {/* 应用中心/插件图标 */}
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                  />
                </svg>
              </div>
            </div>
          </div>

          {/* Results List or AI Answer */}
          <div className="flex-1 flex flex-col min-h-0">
          {showAiAnswer ? (
            // AI 回答模式
            <div className="flex-1 overflow-y-auto min-h-0" style={{ maxHeight: '500px' }}>
              <div className="px-6 py-4">
                {isAiLoading && !aiAnswer ? (
                  // 只在完全没有内容时显示加载状态
                  <div className="flex items-center justify-center py-12">
                    <div className="flex flex-col items-center gap-3">
                      <svg
                        className="w-8 h-8 text-blue-500 animate-spin"
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
                      <div className="text-gray-600">AI 正在思考中...</div>
                    </div>
                  </div>
                ) : aiAnswer ? (
                  // 显示 AI 回答（包括流式接收中的内容）
                  <div className="bg-white rounded-lg border border-gray-200 p-6">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-2">
                        <svg
                          className="w-5 h-5 text-blue-500"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                          />
                          <circle cx="9" cy="9" r="1" fill="currentColor"/>
                          <circle cx="15" cy="9" r="1" fill="currentColor"/>
                        </svg>
                        <h3 className="text-lg font-semibold text-gray-800">AI 回答</h3>
                        {isAiLoading && (
                          <svg
                            className="w-4 h-4 text-blue-500 animate-spin ml-2"
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
                        )}
                      </div>
                      <button
                        onClick={() => {
                          setShowAiAnswer(false);
                          setAiAnswer(null);
                        }}
                        className="text-gray-400 hover:text-gray-600 transition-colors"
                        title="返回搜索结果"
                      >
                        <svg
                          className="w-5 h-5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    </div>
                    <div className="text-gray-700 break-words leading-relaxed prose prose-sm max-w-none">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          // 自定义样式
                          p: ({ children }: any) => <p className="mb-3 last:mb-0">{children}</p>,
                          h1: ({ children }: any) => <h1 className="text-2xl font-bold mb-3 mt-4 first:mt-0">{children}</h1>,
                          h2: ({ children }: any) => <h2 className="text-xl font-bold mb-2 mt-4 first:mt-0">{children}</h2>,
                          h3: ({ children }: any) => <h3 className="text-lg font-semibold mb-2 mt-3 first:mt-0">{children}</h3>,
                          ul: ({ children }: any) => <ul className="list-disc list-inside mb-3 space-y-1">{children}</ul>,
                          ol: ({ children }: any) => <ol className="list-decimal list-inside mb-3 space-y-1">{children}</ol>,
                          li: ({ children }: any) => <li className="ml-2">{children}</li>,
                          code: ({ inline, children }: any) => 
                            inline ? (
                              <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono">{children}</code>
                            ) : (
                              <code className="block bg-gray-100 p-3 rounded text-sm font-mono overflow-x-auto mb-3">{children}</code>
                            ),
                          pre: ({ children }: any) => <pre className="mb-3">{children}</pre>,
                          blockquote: ({ children }: any) => (
                            <blockquote className="border-l-4 border-gray-300 pl-4 italic my-3">{children}</blockquote>
                          ),
                          table: ({ children }: any) => (
                            <div className="overflow-x-auto mb-3">
                              <table className="min-w-full border-collapse border border-gray-300">
                                {children}
                              </table>
                            </div>
                          ),
                          thead: ({ children }: any) => <thead className="bg-gray-100">{children}</thead>,
                          tbody: ({ children }: any) => <tbody>{children}</tbody>,
                          tr: ({ children }: any) => <tr className="border-b border-gray-200">{children}</tr>,
                          th: ({ children }: any) => (
                            <th className="border border-gray-300 px-3 py-2 text-left font-semibold">
                              {children}
                            </th>
                          ),
                          td: ({ children }: any) => (
                            <td className="border border-gray-300 px-3 py-2">{children}</td>
                          ),
                          strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
                          em: ({ children }: any) => <em className="italic">{children}</em>,
                          a: ({ href, children }: any) => (
                            <a href={href} className="text-blue-600 hover:underline" target="_blank" rel="noopener noreferrer">
                              {children}
                            </a>
                          ),
                          hr: () => <hr className="my-4 border-gray-300" />,
                        }}
                      >
                        {aiAnswer}
                      </ReactMarkdown>
                      {isAiLoading && (
                        <span className="inline-block w-2 h-4 bg-blue-500 animate-pulse ml-1 align-middle" />
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-12 text-gray-500">
                    暂无 AI 回答
                  </div>
                )}
              </div>
            </div>
          ) : (isSearchingEverything && results.length === 0 && query.trim()) ? (
            // 骨架屏：搜索中时显示，模拟结果列表样式
            <div
              ref={listRef}
              className="flex-1 overflow-y-auto min-h-0 results-list-scroll"
              style={{ maxHeight: '500px' }}
            >
              {Array.from({ length: 8 }).map((_, index) => {
                // 为每个骨架项生成固定的宽度，避免每次渲染都变化
                const titleWidth = 60 + (index % 4) * 8;
                const pathWidth = 40 + (index % 3) * 6;
                return (
                  <div
                    key={`skeleton-${index}`}
                    className="px-6 py-3"
                  >
                    <div className="flex items-center gap-3">
                      {/* 序号骨架 */}
                      <div className="text-sm font-medium flex-shrink-0 w-8 text-center text-gray-300">
                        {index + 1}
                      </div>
                      {/* 图标骨架 */}
                      <div className="w-8 h-8 rounded bg-gray-200 animate-pulse flex-shrink-0" />
                      {/* 内容骨架 */}
                      <div className="flex-1 min-w-0">
                        <div 
                          className="h-4 bg-gray-200 rounded animate-pulse mb-2" 
                          style={{ width: `${titleWidth}%` }} 
                        />
                        <div 
                          className="h-3 bg-gray-100 rounded animate-pulse" 
                          style={{ width: `${pathWidth}%` }} 
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : results.length > 0 ? (
            <div
              ref={listRef}
              className="flex-1 overflow-y-auto min-h-0 results-list-scroll py-2"
              style={{ maxHeight: '500px' }}
            >
              {(() => {
                // 分离可执行文件（app类型且路径是.exe或.lnk）和插件
                const executableResults = results.filter(result => {
                  if (result.type === "app") {
                    const pathLower = result.path.toLowerCase();
                    return pathLower.endsWith('.exe') || pathLower.endsWith('.lnk');
                  }
                  return false;
                });
                
                // 分离插件
                const pluginResults = results.filter(result => {
                  return result.type === "plugin";
                });
                
                // 合并可执行文件和插件到横向列表
                const horizontalResults = [...executableResults, ...pluginResults];
                
                // 其他结果（排除可执行文件和插件）
                const otherResults = results.filter(result => {
                  if (result.type === "app") {
                    const pathLower = result.path.toLowerCase();
                    return !pathLower.endsWith('.exe') && !pathLower.endsWith('.lnk');
                  }
                  if (result.type === "plugin") {
                    return false;
                  }
                  return true;
                });
                
                return (
                  <>
                    {/* 可执行文件和插件横向排列在第一行 */}
                    {horizontalResults.length > 0 && (
                      <div className="px-4 py-3 mb-2 border-b border-gray-200">
                        <div 
                          className="flex gap-3 overflow-x-auto pb-2 executable-scroll-container"
                          style={{ 
                            scrollbarWidth: 'none', // Firefox
                            msOverflowStyle: 'none', // IE/Edge
                          }}
                        >
                          {horizontalResults.map((result, execIndex) => {
                            const globalIndex = results.indexOf(result);
                            return (
                              <div
                                key={`executable-${result.path}-${execIndex}`}
                                onMouseDown={async (e) => {
                                  if (e.button !== 0) return;
                                  e.preventDefault();
                                  e.stopPropagation();
                                  await handleLaunch(result);
                                }}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                }}
                                onContextMenu={(e) => handleContextMenu(e, result)}
                                className={`flex flex-col items-center gap-1.5 p-2 rounded-lg cursor-pointer transition-all min-w-[70px] ${
                                  globalIndex === selectedIndex 
                                    ? theme.card(true) 
                                    : 'hover:bg-gray-100 bg-gray-50'
                                }`}
                                style={{
                                  animation: `fadeInUp 0.18s ease-out ${execIndex * 0.02}s both`,
                                }}
                              >
                                {globalIndex === selectedIndex && (
                                  <div className={theme.indicator(true)} style={{ position: 'absolute', top: '4px', left: '4px', width: '3px', height: '3px', borderRadius: '50%' }} />
                                )}
                                <div className="flex-shrink-0 flex items-center justify-center" style={{ width: '70px' }}>
                                  {result.type === "app" ? (() => {
                                    let iconToUse = result.app?.icon;
                                    if (!iconToUse && result.path) {
                                      const matchedApp = apps.find(app => app.path === result.path);
                                      if (matchedApp && matchedApp.icon) {
                                        iconToUse = matchedApp.icon;
                                      }
                                    }
                                    if (iconToUse) {
                                      return (
                                        <img 
                                          src={iconToUse} 
                                          alt={result.displayName}
                                          className="w-8 h-8 object-contain"
                                          style={{ imageRendering: 'auto' as const }}
                                          onError={(e) => {
                                            const target = e.target as HTMLImageElement;
                                            target.style.display = 'none';
                                            const parent = target.parentElement;
                                            if (parent && !parent.querySelector('svg')) {
                                              const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                                              svg.setAttribute('class', `w-6 h-6 ${globalIndex === selectedIndex ? 'text-white' : 'text-gray-500'}`);
                                              svg.setAttribute('fill', 'none');
                                              svg.setAttribute('stroke', 'currentColor');
                                              svg.setAttribute('viewBox', '0 0 24 24');
                                              const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                                              path.setAttribute('stroke-linecap', 'round');
                                              path.setAttribute('stroke-linejoin', 'round');
                                              path.setAttribute('stroke-width', '2');
                                              path.setAttribute('d', 'M4 6a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V6z');
                                              svg.appendChild(path);
                                              parent.appendChild(svg);
                                            }
                                          }}
                                        />
                                      );
                                    } else {
                                      return (
                                        <svg
                                          className={`w-6 h-6 ${globalIndex === selectedIndex ? 'text-white' : 'text-gray-500'}`}
                                          fill="none"
                                          stroke="currentColor"
                                          viewBox="0 0 24 24"
                                        >
                                          <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth={2}
                                            d="M4 6a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V6z"
                                          />
                                          <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth={2}
                                            d="M8 10h8m-8 4h5m-5-7h.01"
                                          />
                                        </svg>
                                      );
                                    }
                                  })() : result.type === "plugin" ? (
                                    <svg
                                      className={`w-6 h-6 ${globalIndex === selectedIndex ? 'text-white' : 'text-purple-500'}`}
                                      fill="currentColor"
                                      viewBox="0 0 24 24"
                                    >
                                      <path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/>
                                    </svg>
                                  ) : null}
                                </div>
                                <div 
                                  className="text-xs text-center leading-tight" 
                                  style={{ 
                                    display: '-webkit-box',
                                    WebkitLineClamp: 2,
                                    WebkitBoxOrient: 'vertical',
                                    overflow: 'hidden',
                                    wordBreak: 'break-word',
                                    textOverflow: 'ellipsis',
                                    lineHeight: '1.3',
                                    maxHeight: '2.6em',
                                    minHeight: '2.6em',
                                    width: '70px',
                                    textAlign: 'center'
                                  }}
                                  dangerouslySetInnerHTML={{ __html: highlightText(result.displayName, query) }}
                                />
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {/* 其他结果垂直排列 */}
                    {otherResults.map((result, index) => {
                      // 计算全局索引（需要考虑可执行文件的数量）
                      const globalIndex = results.indexOf(result);
                      const isSelected = globalIndex === selectedIndex;
                      return (
                <div
                  key={`${result.type}-${result.path}-${globalIndex}`}
                  onMouseDown={async (e) => {
                    // 左键按下即触发，避免某些环境下 click 被吞掉
                    if (e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    await handleLaunch(result);
                  }}
                  onClick={(e) => {
                    // 保底处理，若 onMouseDown 已触发则阻止重复
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onContextMenu={(e) => handleContextMenu(e, result)}
                  className={theme.card(globalIndex === selectedIndex)}
                  style={{
                    animation: `fadeInUp 0.18s ease-out ${index * 0.02}s both`,
                  }}
                >
                  <div className={theme.indicator(globalIndex === selectedIndex)} />
                  <div className="flex items-center gap-3">
                    {/* 序号 */}
                    <div className={theme.indexBadge(globalIndex === selectedIndex)}>
                      {globalIndex + 1}
                    </div>
                    <div className={theme.iconWrap(globalIndex === selectedIndex)}>
                      {result.type === "app" ? (() => {
                        // 优先使用 result.app.icon
                        let iconToUse = result.app?.icon;
                        
                        // 如果没有图标，尝试从应用列表中查找匹配的应用图标
                        if (!iconToUse && result.path) {
                          const matchedApp = apps.find(app => app.path === result.path);
                          if (matchedApp && matchedApp.icon) {
                            iconToUse = matchedApp.icon;
                          }
                        }
                        
                        if (iconToUse) {
                          return (
                            <img 
                              src={iconToUse} 
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
                          );
                        } else {
                          // 应用类型但没有图标，显示占位图标
                          return (
                            <svg
                              className={`w-5 h-5 ${theme.iconColor(isSelected, "text-gray-500")}`}
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M4 6a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V6z"
                              />
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M8 10h8m-8 4h5m-5-7h.01"
                              />
                            </svg>
                          );
                        }
                      })() : result.type === "url" ? (
                        <svg
                          className={`w-5 h-5 ${theme.iconColor(isSelected, "text-blue-500")}`}
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
                          className={`w-5 h-5 ${theme.iconColor(isSelected, "text-purple-500")}`}
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
                          className={`w-5 h-5 ${theme.iconColor(isSelected, "text-purple-500")}`}
                          fill="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/>
                        </svg>
                      ) : result.type === "history" ? (
                        <svg
                          className={`w-5 h-5 ${theme.iconColor(isSelected, "text-orange-500")}`}
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
                      ) : result.type === "settings" ? (
                        <svg
                          className={`w-5 h-5 ${theme.iconColor(isSelected, "text-gray-600")}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                          />
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                          />
                        </svg>
                      ) : result.type === "ai" ? (
                        <svg
                          className={`w-5 h-5 ${theme.iconColor(isSelected, "text-blue-500")}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                          />
                          <circle cx="9" cy="9" r="1" fill="currentColor"/>
                          <circle cx="15" cy="9" r="1" fill="currentColor"/>
                        </svg>
                      ) : result.type === "json_formatter" ? (
                        <svg
                          className={`w-5 h-5 ${theme.iconColor(isSelected, "text-indigo-500")}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
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
                          className={`w-5 h-5 ${theme.iconColor(index === selectedIndex, "text-amber-500")}`}
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
                      ) : (result.type === "file" || result.type === "everything" || result.type === "system_folder") ? (
                        // 检查是否为 .lnk 或 .exe 文件，如果是，尝试从应用列表中找到对应的应用图标
                        (() => {
                          const filePath = result.path || '';
                          const isLnkOrExe = filePath.toLowerCase().endsWith('.lnk') || filePath.toLowerCase().endsWith('.exe');
                          if (isLnkOrExe) {
                            // 尝试在应用列表中查找匹配的应用（通过路径匹配）
                            const matchedApp = filteredApps.find(app => app.path === filePath);
                            if (matchedApp && matchedApp.icon) {
                              return (
                                <img 
                                  src={matchedApp.icon} 
                                  alt={result.displayName}
                                  className="w-8 h-8 object-contain"
                                  style={{ imageRendering: 'auto' as const }}
                                  onError={(e) => {
                                    const target = e.target as HTMLImageElement;
                                    target.style.display = 'none';
                                    const parent = target.parentElement;
                                    if (parent && !parent.querySelector('svg')) {
                                      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                                      svg.setAttribute('class', `w-5 h-5 ${isSelected ? 'text-white' : 'text-gray-500'}`);
                                      svg.setAttribute('fill', 'none');
                                      svg.setAttribute('stroke', 'currentColor');
                                      svg.setAttribute('viewBox', '0 0 24 24');
                                      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                                      path.setAttribute('stroke-linecap', 'round');
                                      path.setAttribute('stroke-linejoin', 'round');
                                      path.setAttribute('stroke-width', '2');
                                      path.setAttribute('d', 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z');
                                      svg.appendChild(path);
                                      parent.appendChild(svg);
                                    }
                                  }}
                                />
                              );
                            }
                          }
                          // 默认显示文档图标
                          return (
                            <svg
                              className={`w-5 h-5 ${theme.iconColor(isSelected, "text-gray-500")}`}
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
                          );
                        })()
                      ) : (
                        <svg
                          className={`w-5 h-5 ${theme.iconColor(isSelected, "text-gray-500")}`}
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
                    <div 
                        className={`font-semibold truncate mb-0.5 ${theme.title(isSelected)}`}
                        dangerouslySetInnerHTML={{ __html: highlightText(result.displayName, query) }}
                      />
                      {result.type === "ai" && result.aiAnswer && (
                        <div
                          className={`text-sm mt-1.5 leading-relaxed ${theme.aiText(isSelected)}`}
                          style={{
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            maxHeight: "200px",
                            overflowY: "auto",
                          }}
                        >
                          {result.aiAnswer}
                        </div>
                      )}
                      {result.path && result.type !== "memo" && result.type !== "history" && result.type !== "ai" && (
                        <div
                          className={`text-xs truncate mt-0.5 ${theme.pathText(isSelected)}`}
                          dangerouslySetInnerHTML={{ __html: highlightText(result.path, query) }}
                        />
                      )}
                      {result.type === "memo" && result.memo && (
                        <div
                          className={`text-xs mt-0.5 ${theme.metaText(isSelected)}`}
                        >
                          {new Date(result.memo.updated_at * 1000).toLocaleDateString("zh-CN")}
                        </div>
                      )}
                      {result.type === "plugin" && result.plugin?.description && (
                        <div
                          className={`text-xs mt-0.5 leading-relaxed ${theme.descText(isSelected)}`}
                          dangerouslySetInnerHTML={{ __html: highlightText(result.plugin.description, query) }}
                        />
                      )}
                      {result.type === "file" && result.file && (
                        <div
                          className={`text-xs mt-0.5 ${theme.usageText(isSelected)}`}
                        >
                          使用 {result.file.use_count} 次
                        </div>
                      )}
                      {result.type === "url" && (
                        <div className="flex items-center gap-2 mt-1.5">
                          <span
                            className={`text-xs px-2.5 py-1 rounded-md font-medium transition-all ${theme.tag("url", isSelected)}`}
                            title="可打开的 URL"
                          >
                            URL
                          </span>
                        </div>
                      )}
                      {result.type === "json_formatter" && (
                        <div className="flex items-center gap-2 mt-1.5">
                          <span
                            className={`text-xs px-2.5 py-1 rounded-md font-medium transition-all ${theme.tag("json_formatter", isSelected)}`}
                            title="JSON 格式化查看器"
                          >
                            JSON
                          </span>
                        </div>
                      )}
                      {result.type === "memo" && result.memo && (
                        <div className="flex items-center gap-2 mt-1.5">
                          <span
                            className={`text-xs px-2.5 py-1 rounded-md font-medium transition-all ${theme.tag("memo", isSelected)}`}
                            title="备忘录"
                          >
                            备忘录
                          </span>
                          {result.memo.content && (
                            <span
                              className={`text-xs truncate ${theme.metaText(isSelected)}`}
                              dangerouslySetInnerHTML={{ 
                                __html: highlightText(
                                  result.memo.content.slice(0, 50) + (result.memo.content.length > 50 ? "..." : ""),
                                  query
                                )
                              }}
                            />
                          )}
                        </div>
                      )}
                      {result.type === "everything" && (
                        <div className="flex items-center gap-2 mt-1.5">
                          <span
                            className={`text-xs px-2.5 py-1 rounded-md font-medium transition-all ${theme.tag("everything", isSelected)}`}
                            title="来自 Everything 搜索结果"
                          >
                            Everything
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                      );
                    })}
                  </>
                );
              })()}
            </div>
          ) : null}

          {/* Loading or Empty State */}
          {!showAiAnswer && isLoading && (
            <div className="px-6 py-8 text-center text-gray-500 flex-1 flex flex-col items-center justify-center">
              <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-gray-400 mb-2"></div>
              <div>正在扫描应用...</div>
            </div>
          )}

          {!showAiAnswer && !isLoading && results.length === 0 && query && (
            <div className="px-6 py-8 text-center text-gray-500 flex-1 flex items-center justify-center">
              未找到匹配的应用或文件
            </div>
          )}

          {/* Everything Search Status */}
          {!showAiAnswer && query.trim() && isEverythingAvailable && (
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

          {!showAiAnswer && !isLoading && results.length === 0 && !query && (
            <div className="px-6 py-8 text-center text-gray-400 text-sm flex-1 flex items-center justify-center">
              输入关键词搜索应用，或粘贴文件路径
            </div>
          )}
          </div>

          {/* Footer */}
          <div className="px-6 py-2 border-t border-gray-100 text-xs text-gray-400 flex justify-between items-center bg-gray-50/50 flex-shrink-0 gap-2 min-w-0">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              {!showAiAnswer && results.length > 0 && <span className="whitespace-nowrap">{results.length} 个结果</span>}
              {showAiAnswer && <span className="whitespace-nowrap">AI 回答模式</span>}
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <div 
                  className="flex items-center gap-1 cursor-help whitespace-nowrap" 
                  title={everythingPath ? `Everything 路径: ${everythingPath}` : 'Everything 未安装或未在 PATH 中'}
                >
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isEverythingAvailable ? 'bg-green-500' : 'bg-gray-300'}`}></div>
                  <span className={isEverythingAvailable ? 'text-green-600' : 'text-gray-400'}>
                    {isEverythingAvailable ? 'Everything 已启用' : (
                      everythingError?.startsWith("NOT_INSTALLED") 
                        ? 'Everything 未安装' 
                        : everythingError?.startsWith("SERVICE_NOT_RUNNING")
                        ? 'Everything 服务未运行'
                        : 'Everything 未检测到'
                    )}
                  </span>
                  {everythingError && !isEverythingAvailable && !everythingError.startsWith("NOT_INSTALLED") && !everythingError.startsWith("SERVICE_NOT_RUNNING") && (
                    <span className="text-xs text-red-500 ml-2 whitespace-nowrap" title={everythingError}>
                      ({everythingError.split(':')[0]})
                    </span>
                  )}
                </div>
                {!isEverythingAvailable && (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {everythingError && everythingError.startsWith("SERVICE_NOT_RUNNING") && (
                      <button
                        onClick={handleStartEverything}
                        className="px-2 py-1 text-xs bg-green-500 text-white rounded hover:bg-green-600 transition-colors whitespace-nowrap"
                        title="启动 Everything"
                      >
                        启动
                      </button>
                    )}
                    {(!everythingError || !everythingError.startsWith("SERVICE_NOT_RUNNING")) && (
                      <button
                        onClick={handleDownloadEverything}
                        disabled={isDownloadingEverything}
                        className={`px-2 py-1 text-xs rounded transition-colors whitespace-nowrap ${
                          isDownloadingEverything
                            ? 'bg-gray-400 text-white cursor-not-allowed'
                            : 'bg-blue-500 text-white hover:bg-blue-600'
                        }`}
                        title="下载并安装 Everything"
                      >
                        {isDownloadingEverything ? `下载中 ${everythingDownloadProgress}%` : '下载'}
                      </button>
                    )}
                    <button
                      onClick={handleCheckAgain}
                      className="px-2 py-1 text-xs bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors whitespace-nowrap"
                      title="重新检测 Everything"
                    >
                      刷新
                    </button>
                  </div>
                )}
              </div>
            </div>
            {!showAiAnswer && results.length > 0 && (
              <span className="whitespace-nowrap flex-shrink-0">↑↓ 选择 · Enter 打开 · Esc 关闭</span>
            )}
            {showAiAnswer && (
              <span className="whitespace-nowrap flex-shrink-0">Esc 返回搜索结果</span>
            )}
          </div>
        </div>
        {/* Resize Handle */}
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const whiteContainer = getMainContainer();
            if (whiteContainer) {
              resizeStartX.current = e.clientX;
              resizeStartWidth.current = whiteContainer.offsetWidth;
              setIsResizing(true);
            }
          }}
          className={`absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-400 transition-colors ${
            isResizing ? 'bg-blue-500' : 'bg-transparent'
          }`}
          style={{ zIndex: 10 }}
        />
      </div>
      )}


      {/* Context Menu */}
      {contextMenu && (() => {
        // 检查是否有菜单项需要显示
        const hasFileMenu = contextMenu.result.type === "file" ||
          contextMenu.result.type === "everything" ||
          contextMenu.result.type === "system_folder" ||
          contextMenu.result.type === "app";
        const hasMemoMenu = contextMenu.result.type === "memo" && contextMenu.result.memo;
        const hasUrlMenu = contextMenu.result.type === "url" && contextMenu.result.url;
        const hasJsonMenu = contextMenu.result.type === "json_formatter" && contextMenu.result.jsonContent;
        const hasAiMenu = contextMenu.result.type === "ai" && contextMenu.result.aiAnswer;
        
        // 如果没有菜单项，不显示菜单
        if (!hasFileMenu && !hasMemoMenu && !hasUrlMenu && !hasJsonMenu && !hasAiMenu) {
          return null;
        }
        
        return (
          <div
            ref={contextMenuRef}
            className="fixed bg-white border border-gray-200 text-gray-800 rounded-lg shadow-xl py-1 min-w-[160px] z-50"
            style={{
              left: `${contextMenu.x}px`,
              top: `${contextMenu.y}px`,
            }}
          >
            {hasFileMenu && (
              <>
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
                {/* 为应用类型显示调试图标按钮 */}
                {contextMenu.result.type === "app" && contextMenu.result.app && (
                  <button
                    onClick={async (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setContextMenu(null);
                      try {
                        const app = contextMenu.result.app!;
                        const hasIcon = app.icon && app.icon.trim() !== '';
                        const result = await tauriApi.debugAppIcon(app.name);
                        console.log('=== 图标调试结果 ===');
                        console.log('应用名称:', app.name);
                        console.log('应用路径:', app.path);
                        console.log('当前图标状态:', hasIcon ? '有图标' : '无图标');
                        console.log('图标数据长度:', app.icon?.length || 0);
                        console.log('调试信息:\n', result);
                        alert(`应用: ${app.name}\n路径: ${app.path}\n图标状态: ${hasIcon ? '有图标' : '无图标'}\n\n${result}`);
                        // 尝试重新加载应用列表以获取可能的图标更新
                        await searchApplications(query);
                      } catch (error: any) {
                        console.error('调试失败:', error);
                        alert(`调试失败: ${error?.message || error}`);
                      }
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 transition-colors border-t border-gray-100"
                  >
                    调试图标提取
                  </button>
                )}
                {/* 为文件类型（.lnk 或 .exe）也显示调试图标按钮 */}
                {contextMenu.result.type === "file" && contextMenu.result.file && (() => {
                  const filePath = contextMenu.result.file.path || '';
                  const isLnkOrExe = filePath.toLowerCase().endsWith('.lnk') || filePath.toLowerCase().endsWith('.exe');
                  const fileName = contextMenu.result.file.name || '';
                  return isLnkOrExe ? (
                    <button
                      onClick={async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setContextMenu(null);
                        try {
                          const result = await tauriApi.debugAppIcon(fileName.replace(/\.(lnk|exe)$/i, ''));
                          console.log('=== 图标调试结果（文件类型）===');
                          console.log('文件名称:', fileName);
                          console.log('文件路径:', filePath);
                          console.log('调试信息:\n', result);
                          alert(`文件: ${fileName}\n路径: ${filePath}\n\n${result}`);
                          // 尝试重新搜索
                          await searchApplications(query);
                        } catch (error: any) {
                          console.error('调试失败:', error);
                          alert(`调试失败: ${error?.message || error}`);
                        }
                      }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 transition-colors border-t border-gray-100"
                    >
                      调试图标提取
                    </button>
                  ) : null;
                })()}
              </>
            )}
            {hasMemoMenu && (
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
            {hasUrlMenu && (
              <button
                onClick={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  try {
                    await tauriApi.openUrl(contextMenu.result.url!);
                    setContextMenu(null);
                  } catch (error) {
                    console.error("Failed to open URL:", error);
                    alert(`打开链接失败: ${error}`);
                    setContextMenu(null);
                  }
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 transition-colors"
              >
                打开链接
              </button>
            )}
            {hasJsonMenu && (
              <button
                onClick={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  try {
                    await navigator.clipboard.writeText(contextMenu.result.jsonContent!);
                    alert("JSON 内容已复制到剪贴板");
                    setContextMenu(null);
                  } catch (error) {
                    console.error("Failed to copy JSON:", error);
                    alert("复制失败，请手动复制");
                    setContextMenu(null);
                  }
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 transition-colors"
              >
                复制 JSON
              </button>
            )}
            {hasAiMenu && (
              <button
                onClick={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  try {
                    await navigator.clipboard.writeText(contextMenu.result.aiAnswer!);
                    alert("AI 回答已复制到剪贴板");
                    setContextMenu(null);
                  } catch (error) {
                    console.error("Failed to copy AI answer:", error);
                    alert("复制失败，请手动复制");
                    setContextMenu(null);
                  }
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 transition-colors"
              >
                复制回答
              </button>
            )}
          </div>
        );
      })()}

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
                      setTimeout(() => {
                        hideLauncherAndResetState({ resetMemo: true });
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
                          onClick={(e) => {
                            // 如果点击的是按钮或其子元素，不执行操作
                            const target = e.target as HTMLElement;
                            if (target.closest('button')) {
                              return;
                            }
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
                                await hideLauncherAndResetState({ resetMemo: true });
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
                            onMouseDown={async (e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              const confirmed = confirm("确定要删除这条备忘录吗？");
                              if (!confirmed) {
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
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
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
                    onMouseDown={async (e) => {
                      e.preventDefault();
                      e.stopPropagation();
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
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
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

      {/* Clipboard URL Modal */}
      {clipboardUrlToOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="clipboard-url-modal bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 max-h-[calc(100vh-32px)] flex flex-col overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
              <div className="text-sm font-semibold text-gray-800">检测到剪切板中的链接</div>
            </div>
            <div className="px-5 py-3">
              <div className="text-sm text-gray-800 break-all bg-gray-50 rounded-md px-3 py-2 border border-gray-100 max-h-40 overflow-y-auto">
                {clipboardUrlToOpen}
              </div>
            </div>
            <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between gap-3 bg-gray-50 flex-shrink-0">
              <div className="text-sm text-gray-600">是否打开此链接？</div>
              <button
                onClick={handleCancelOpenClipboardUrl}
                className="px-4 py-2 text-sm rounded-md border border-gray-300 text-gray-700 hover:bg-gray-100 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleConfirmOpenClipboardUrl}
                className="px-4 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 shadow-sm transition-colors"
              >
                打开链接
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 应用中心弹窗 */}
      {isPluginListModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl flex flex-col m-4" style={{ maxHeight: '90vh', height: '80vh' }}>
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-200 flex-shrink-0">
              <h2 className="text-lg font-semibold text-gray-800">应用中心</h2>
              <button
                onClick={async () => {
                  setIsPluginListModalOpen(false);
                  // 延迟隐藏窗口，让关闭动画完成（插件像独立软件一样运行）
                  setTimeout(() => {
                    hideLauncherAndResetState();
                  }, 100);
                }}
                className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded transition-colors"
              >
                关闭
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 flex overflow-hidden min-h-0">
              <AppCenterContent
                onPluginClick={async (pluginId: string) => {
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
                    setMemos,
                    tauriApi,
                  };
                  await executePlugin(pluginId, pluginContext);
                  setIsPluginListModalOpen(false);
                  setTimeout(() => {
                    hideLauncherAndResetState();
                  }, 100);
                }}
                onClose={async () => {
                  setIsPluginListModalOpen(false);
                  setTimeout(() => {
                    hideLauncherAndResetState();
                  }, 100);
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
