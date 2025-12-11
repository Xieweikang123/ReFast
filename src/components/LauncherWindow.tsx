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
import { MemoModal } from "./MemoModal";
import { ContextMenu } from "./ContextMenu";
import { ResultIcon } from "./ResultIcon";
import { ErrorDialog } from "./ErrorDialog";
import {
  extractUrls,
  extractEmails,
  isValidJson,
  highlightText,
  isLikelyAbsolutePath,
  isLnkPath,
  calculateRelevanceScore,
} from "../utils/launcherUtils";
import { getThemeConfig, getLayoutConfig, type ResultStyle } from "../utils/themeConfig";
import { handleEscapeKey, closePluginModalAndHide, closeMemoModalAndHide } from "../utils/launcherHandlers";
import { clearAllResults, resetSelectedIndices, selectFirstHorizontal, selectFirstVertical } from "../utils/resultUtils";
import { adjustWindowSize, getMainContainer as getMainContainerUtil } from "../utils/windowUtils";

type SearchResult = {
  type: "app" | "file" | "everything" | "url" | "email" | "memo" | "plugin" | "system_folder" | "history" | "ai" | "json_formatter" | "settings";
  app?: AppInfo;
  file?: FileHistoryItem;
  everything?: EverythingResult;
  url?: string;
  email?: string;
  memo?: MemoItem;
  plugin?: { id: string; name: string; description?: string };
  systemFolder?: SystemFolderItem;
  aiAnswer?: string;
  jsonContent?: string;
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
  const [directPathResult, setDirectPathResult] = useState<FileHistoryItem | null>(null); // 绝对路径直达结果
  const [isEverythingAvailable, setIsEverythingAvailable] = useState(false);
  const [everythingPath, setEverythingPath] = useState<string | null>(null);
  const [everythingVersion, setEverythingVersion] = useState<string | null>(null);
  const [everythingError, setEverythingError] = useState<string | null>(null);
  const [isSearchingEverything, setIsSearchingEverything] = useState(false);
  const [isDownloadingEverything, setIsDownloadingEverything] = useState(false);
  const [everythingDownloadProgress, setEverythingDownloadProgress] = useState(0);
  const [results, setResults] = useState<SearchResult[]>([]); // Keep for backward compatibility, will be removed later
  const [horizontalResults, setHorizontalResults] = useState<SearchResult[]>([]);
  const [verticalResults, setVerticalResults] = useState<SearchResult[]>([]);
  const [selectedHorizontalIndex, setSelectedHorizontalIndex] = useState<number | null>(null);
  const [selectedVerticalIndex, setSelectedVerticalIndex] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0); // Keep for now, will be computed from selectedHorizontalIndex/selectedVerticalIndex
  const [isLoading, setIsLoading] = useState(false);
  const [isHoveringAiIcon, setIsHoveringAiIcon] = useState(false);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiAnswer, setAiAnswer] = useState<string | null>(null);
  const [showAiAnswer, setShowAiAnswer] = useState(false); // 是否显示 AI 回答模式
  const [ollamaSettings, setOllamaSettings] = useState<{ model: string; base_url: string }>({
    model: "llama2",
    base_url: "http://localhost:11434",
  });
  const [detectedUrls, setDetectedUrls] = useState<string[]>([]);
  const [detectedEmails, setDetectedEmails] = useState<string[]>([]);
  const [detectedJson, setDetectedJson] = useState<string | null>(null);
  // 错误提示弹窗
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // 成功提示弹窗
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
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
  const [launchingAppPath, setLaunchingAppPath] = useState<string | null>(null); // 正在启动的应用路径
  const [pastedImagePath, setPastedImagePath] = useState<string | null>(null); // 粘贴的图片路径
  const [pastedImageDataUrl, setPastedImageDataUrl] = useState<string | null>(null); // 粘贴的图片 base64 data URL
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
  const horizontalScrollContainerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isWindowDraggingRef = useRef(false);
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
  const horizontalResultsRef = useRef<SearchResult[]>([]); // 跟踪当前的横向结果，用于防止被覆盖
  const closeOnBlurRef = useRef(true);
  const isHorizontalNavigationRef = useRef(false); // 标记是否是横向导航切换
  const isAutoSelectingFirstHorizontalRef = useRef(false); // 标记是否正在自动选择第一个横向结果（用于防止scrollIntoView）
  const justJumpedToVerticalRef = useRef(false); // 标记是否刚刚从横向跳转到纵向（用于防止results useEffect重置selectedIndex）

  const getMainContainer = () => containerRef.current || getMainContainerUtil();

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
          scrollbarSize: 12,
          trackBg: "linear-gradient(to bottom, rgba(245, 247, 250, 0.8), rgba(250, 251, 253, 0.9))",
          trackBorder: "rgba(226, 232, 240, 0.9)",
          thumbBg: "linear-gradient(to bottom, rgba(148, 163, 184, 0.7), rgba(100, 116, 139, 0.8))",
          thumbHover: "linear-gradient(to bottom, rgba(100, 116, 139, 0.9), rgba(71, 85, 105, 0.95))",
          thumbActive: "linear-gradient(to bottom, rgba(71, 85, 105, 0.95), rgba(51, 65, 85, 1))",
          thumbBorder: 2.5,
          thumbBorderBg: "rgba(255, 255, 255, 0.95)",
          thumbHoverBorder: "rgba(255, 255, 255, 1)",
          thumbActiveBorder: "rgba(255, 255, 255, 1)",
          minHeight: 40,
          thumbShadow: "0 2px 8px rgba(0, 0, 0, 0.1)",
          thumbHoverShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
        };
      }
      if (resultStyle === "skeuomorphic") {
        return {
          scrollbarSize: 12,
          trackBg: "linear-gradient(to bottom, rgba(246, 248, 251, 0.8), rgba(249, 251, 254, 0.95))",
          trackBorder: "rgba(227, 233, 241, 0.95)",
          thumbBg: "linear-gradient(to bottom, rgba(197, 208, 222, 0.75), rgba(178, 193, 214, 0.85))",
          thumbHover: "linear-gradient(to bottom, rgba(178, 193, 214, 0.9), rgba(159, 176, 201, 0.98))",
          thumbActive: "linear-gradient(to bottom, rgba(159, 176, 201, 0.98), rgba(139, 158, 186, 1))",
          thumbBorder: 2.5,
          thumbBorderBg: "rgba(249, 251, 254, 0.98)",
          thumbHoverBorder: "rgba(238, 243, 250, 1)",
          thumbActiveBorder: "rgba(227, 233, 243, 1)",
          minHeight: 40,
          thumbShadow: "0 2px 8px rgba(0, 0, 0, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.6)",
          thumbHoverShadow: "0 4px 12px rgba(0, 0, 0, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.7)",
        };
      }
      return {
        scrollbarSize: 12,
        trackBg: "linear-gradient(to bottom, rgba(248, 250, 252, 0.8), rgba(251, 252, 254, 0.9))",
        trackBorder: "rgba(226, 232, 240, 0.9)",
        thumbBg: "linear-gradient(to bottom, rgba(148, 163, 184, 0.7), rgba(100, 116, 139, 0.8))",
        thumbHover: "linear-gradient(to bottom, rgba(100, 116, 139, 0.9), rgba(71, 85, 105, 0.95))",
        thumbActive: "linear-gradient(to bottom, rgba(71, 85, 105, 0.95), rgba(51, 65, 85, 1))",
        thumbBorder: 2.5,
        thumbBorderBg: "rgba(255, 255, 255, 0.95)",
        thumbHoverBorder: "rgba(255, 255, 255, 1)",
        thumbActiveBorder: "rgba(255, 255, 255, 1)",
        minHeight: 40,
        thumbShadow: "0 2px 8px rgba(0, 0, 0, 0.1)",
        thumbHoverShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
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
          overflow-y: auto !important;
          scrollbar-width: thin !important;
          scrollbar-color: rgba(148, 163, 184, 0.8) rgba(248, 250, 252, 0.8) !important;
        }
        
        .results-list-scroll::-webkit-scrollbar {
          width: ${config.scrollbarSize}px !important;
          height: ${config.scrollbarSize}px !important;
          display: block !important;
          -webkit-appearance: none !important;
          background: transparent !important;
        }
        
        .results-list-scroll::-webkit-scrollbar-button {
          display: none !important;
          width: 0 !important;
          height: 0 !important;
        }
        
        .results-list-scroll::-webkit-scrollbar-track {
          background: ${config.trackBg} !important;
          border-left: 1px solid ${config.trackBorder} !important;
          border-radius: 12px !important;
          margin: 6px 2px !important;
          opacity: 1 !important;
        }
        
        .results-list-scroll::-webkit-scrollbar-thumb {
          background: ${config.thumbBg} !important;
          border-radius: 12px !important;
          border: ${config.thumbBorder}px solid ${config.thumbBorderBg} !important;
          background-clip: padding-box !important;
          min-height: ${config.minHeight}px !important;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
          box-shadow: ${config.thumbShadow} !important;
          opacity: 1 !important;
          visibility: visible !important;
        }
        
        .results-list-scroll::-webkit-scrollbar-thumb:hover {
          background: ${config.thumbHover} !important;
          border: ${config.thumbBorder}px solid ${config.thumbHoverBorder} !important;
          box-shadow: ${config.thumbHoverShadow} !important;
        }
        
        .results-list-scroll::-webkit-scrollbar-thumb:active {
          background: ${config.thumbActive} !important;
          border: ${config.thumbBorder}px solid ${config.thumbActiveBorder} !important;
          box-shadow: ${config.thumbHoverShadow} !important;
        }
        
        /* 可执行文件横向滚动条的滚动条样式 */
        .executable-scroll-container {
          overflow-x: auto !important;
          scrollbar-width: thin !important;
          scrollbar-color: rgba(148, 163, 184, 0.8) rgba(248, 250, 252, 0.8) !important;
        }
        
        .executable-scroll-container::-webkit-scrollbar {
          height: ${config.scrollbarSize}px !important;
          width: ${config.scrollbarSize}px !important;
          display: block !important;
          -webkit-appearance: none !important;
          background: transparent !important;
        }
        
        .executable-scroll-container::-webkit-scrollbar-button {
          display: none !important;
          width: 0 !important;
          height: 0 !important;
        }
        
        .executable-scroll-container::-webkit-scrollbar-track {
          background: ${config.trackBg} !important;
          border-top: 1px solid ${config.trackBorder} !important;
          border-radius: 12px !important;
          margin: 2px 6px !important;
          opacity: 1 !important;
        }
        
        .executable-scroll-container::-webkit-scrollbar-thumb {
          background: ${config.thumbBg} !important;
          border-radius: 12px !important;
          border: ${config.thumbBorder}px solid ${config.thumbBorderBg} !important;
          background-clip: padding-box !important;
          min-width: ${config.minHeight}px !important;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
          box-shadow: ${config.thumbShadow} !important;
          opacity: 1 !important;
          visibility: visible !important;
        }
        
        .executable-scroll-container::-webkit-scrollbar-thumb:hover {
          background: ${config.thumbHover} !important;
          border: ${config.thumbBorder}px solid ${config.thumbHoverBorder} !important;
          box-shadow: ${config.thumbHoverShadow} !important;
        }
        
        .executable-scroll-container::-webkit-scrollbar-thumb:active {
          background: ${config.thumbActive} !important;
          border: ${config.thumbBorder}px solid ${config.thumbActiveBorder} !important;
          box-shadow: ${config.thumbHoverShadow} !important;
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

  // 根据插件ID获取对应的图标
  const getPluginIcon = (pluginId: string, className: string) => {
    switch (pluginId) {
      case "everything_search":
        return (
          <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        );
      case "json_formatter":
        return (
          <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
        );
      case "calculator_pad":
        return (
          <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
        );
      case "memo_center":
        return (
          <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        );
      case "show_main_window":
        return (
          <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        );
      case "show_plugin_list":
        return (
          <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
        );
      case "file_toolbox":
        return (
          <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
          </svg>
        );
      default:
        return (
          <svg className={className} fill="currentColor" viewBox="0 0 24 24">
            <path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/>
          </svg>
        );
    }
  };

  // 统一处理窗口关闭和状态清理的公共函数
  const hideLauncherAndResetState = async (options?: { resetMemo?: boolean; resetAi?: boolean }) => {
    try {
      await tauriApi.hideLauncher();
      setQuery("");
      setSelectedIndex(0);
      setContextMenu(null);
      setSuccessMessage(null); // 清除成功消息
      setErrorMessage(null); // 清除错误消息
      setPastedImagePath(null); // 清除粘贴的图片路径
      setPastedImageDataUrl(null); // 清除粘贴的图片预览
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

  // 监听插件快捷键（通过后端全局监听）
  const lastTriggeredRef = useRef<{ pluginId: string; time: number } | null>(null);
  
  useEffect(() => {
    // 监听后端发送的插件快捷键触发事件
    let unsubscribeTriggered: (() => void) | null = null;
    let unsubscribeUpdated: (() => void) | null = null;
    
    const setupListeners = async () => {
      // 监听插件快捷键触发事件（从后端发送）
      unsubscribeTriggered = await listen<string>("plugin-hotkey-triggered", async (event) => {
        const pluginId = event.payload;
        
        // 前端防抖：检查是否在 200ms 内重复触发同一个插件
        const now = Date.now();
        if (lastTriggeredRef.current) {
          const { pluginId: lastId, time: lastTime } = lastTriggeredRef.current;
          if (lastId === pluginId && now - lastTime < 200) {
            console.log(`[PluginHotkeys] ⚠️ Ignored duplicate trigger for plugin: ${pluginId} (within 200ms)`);
            return;
          }
        }
        
        // 记录触发时间和插件 ID
        lastTriggeredRef.current = { pluginId, time: now };
        
        console.log(`[PluginHotkeys] ✅ Hotkey triggered for plugin: ${pluginId}`);
        
        try {
          const pluginContext: PluginContext = {
            query,
            setQuery,
            setSelectedIndex,
            hideLauncher: async () => {
              await tauriApi.hideLauncher();
            },
            tauriApi,
          };
          await executePlugin(pluginId, pluginContext);
          console.log(`[PluginHotkeys] ✅ Plugin ${pluginId} executed successfully`);
        } catch (error) {
          console.error(`[PluginHotkeys] ❌ Failed to execute plugin ${pluginId}:`, error);
        }
      });
      
      // 监听插件快捷键更新事件
      unsubscribeUpdated = await listen<Record<string, { modifiers: string[]; key: string }>>(
        "plugin-hotkeys-updated",
        (event) => {
          console.log("[PluginHotkeys] Updated plugin hotkeys:", Object.keys(event.payload).length, "plugins");
        }
      );
    };
    
    setupListeners().catch((error) => {
      console.error("[PluginHotkeys] Failed to setup listeners:", error);
    });

    return () => {
      if (unsubscribeTriggered) {
        unsubscribeTriggered();
      }
      if (unsubscribeUpdated) {
        unsubscribeUpdated();
      }
    };
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
    
    // Global keyboard listener for Escape key and Arrow keys
    const handleGlobalKeyDown = async (e: KeyboardEvent) => {
      if (handleEscapeKey(e, {
        isPluginListModalOpen: () => isPluginListModalOpenRef.current,
        isMemoModalOpen: () => isMemoModalOpenRef.current,
        showAiAnswer,
        setIsPluginListModalOpen,
        resetMemoState,
        setShowAiAnswer,
        setAiAnswer,
        hideLauncherAndResetState,
      })) {
        return;
      }
      
      // Handle ArrowDown globally when input might not be focused
      if (e.key === "ArrowDown" && results.length > 0) {
        
        // Only handle if input is not focused (to avoid double handling)
        const isInputFocused = document.activeElement === inputRef.current;
        if (!isInputFocused) {
          e.preventDefault();
          e.stopPropagation();
          
          // Use the same logic as handleKeyDown for ArrowDown
          // Check if current selected item is in horizontal results
          const executableResults = results.filter(result => {
            if (result.type === "app") {
              const pathLower = result.path.toLowerCase();
              return pathLower.endsWith('.exe') || pathLower.endsWith('.lnk');
            }
            return false;
          });
          
          const pluginResults = results.filter(result => {
            return result.type === "plugin";
          });
          
          const systemFolderResults = results.filter(result => {
            return result.type === "system_folder";
          });
          
          const horizontalResults = [...executableResults, ...pluginResults, ...systemFolderResults];
          const horizontalIndices = horizontalResults.map(hr => results.indexOf(hr)).filter(idx => idx >= 0);
          
          
          // If current selected item is in horizontal results, jump to first vertical result
          if (horizontalIndices.includes(selectedIndex)) {
            const firstVerticalIndex = results.findIndex((_, index) => {
              return !horizontalIndices.includes(index);
            });
            
            
            if (firstVerticalIndex >= 0) {
              setSelectedIndex(firstVerticalIndex);
              return;
            }
          }
          
          // Otherwise, increment normally
          setSelectedIndex((prev) =>
            prev < results.length - 1 ? prev + 1 : prev
          );
        }
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
          closePluginModalAndHide(setIsPluginListModalOpen, hideLauncherAndResetState);
          return;
        }
        // 如果备忘录弹窗已打开，关闭备忘录并隐藏窗口
        if (isMemoModalOpenRef.current) {
          closeMemoModalAndHide(resetMemoState, hideLauncherAndResetState);
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



  // 统一处理窗口拖动，避免拖动过程中触发失焦自动关闭
  const startWindowDragging = async () => {
    const window = getCurrentWindow();
    isWindowDraggingRef.current = true;
    try {
      await window.startDragging();
    } catch (error: any) {
      isWindowDraggingRef.current = false;
      console.error("Failed to start dragging:", error);
    }
  };



  const theme = useMemo(() => getThemeConfig(resultStyle), [resultStyle]);

  const layout = useMemo(() => getLayoutConfig(resultStyle), [resultStyle]);

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
    
    // 如果查询改变了，立即清空结果，避免在防抖期间显示旧结果
    if (trimmedQuery !== lastSearchQueryRef.current && trimmedQuery !== "") {
      setFilteredApps([]);
      setFilteredFiles([]);
      setFilteredMemos([]);
      setFilteredPlugins([]);
      setSystemFolders([]);
      setEverythingResults([]);
      setEverythingTotalCount(null);
      setEverythingCurrentCount(0);
      setDirectPathResult(null);
    }
    
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
      setDetectedEmails([]);
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
    
    // Extract email addresses from query (同步操作，不需要防抖)
    const emails = extractEmails(query);
    setDetectedEmails(emails);
    
    // Check if query is valid JSON (同步操作，不需要防抖)
    if (isValidJson(query)) {
      setDetectedJson(query.trim());
    } else {
      setDetectedJson(null);
    }
    
    // 如果查询与上次相同，跳过搜索（去重机制）
    // 但是，如果结果为空（可能是用户全选后再次输入相同内容导致结果被清空），应该重新搜索
    const hasResults = filteredApps.length > 0 || filteredFiles.length > 0 || filteredMemos.length > 0 || 
                       filteredPlugins.length > 0 || systemFolders.length > 0 || everythingResults.length > 0;
    if (trimmedQuery === lastSearchQueryRef.current && hasResults) {
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
          // 但是，如果结果为空，应该重新搜索（可能是用户全选后再次输入相同内容）
          const hasResults = filteredApps.length > 0 || filteredFiles.length > 0 || filteredMemos.length > 0 || 
                             filteredPlugins.length > 0 || systemFolders.length > 0 || everythingResults.length > 0;
          if (!hasResults) {
            // 清空currentSearchRef，允许重新搜索everything
            if (currentSearchRef.current) {
              currentSearchRef.current.cancelled = true;
              currentSearchRef.current = null;
            }
            // 继续执行搜索，不返回
          } else {
            return;
          }
        }
      }
      
      // 标记当前查询为已搜索
      lastSearchQueryRef.current = trimmedQuery;
      // 立即清空所有搜索结果，避免显示旧结果
      setFilteredApps([]);
      setFilteredFiles([]);
      setFilteredMemos([]);
      setFilteredPlugins([]);
      setSystemFolders([]);
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
    
    // 邮箱结果
    const emailResults: SearchResult[] = detectedEmails.map((email) => ({
      type: "email" as const,
      email,
      displayName: email,
      path: `mailto:${email}`,
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
    
    // 检查是否应该显示"设置"结果（只在明确搜索相关关键词时显示）
    const settingsKeywords = ["设置", "settings", "配置", "config", "preferences"];
    const shouldShowSettings = settingsKeywords.some(keyword => 
      lowerQuery.includes(keyword.toLowerCase()) || keyword.toLowerCase().includes(lowerQuery)
    );
    
    // 检查是否是启动相关关键词（这些应该优先显示系统启动文件夹，而不是软件设置）
    const startupKeywords = ["开机启动", "自启动", "启动项", "startup", "autostart"];
    const isStartupQuery = startupKeywords.some(keyword => 
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
      // 如果查询匹配设置关键词，优先显示 Windows 设置应用（通过提高其优先级实现）
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
    const addedHistoryPaths = new Set<string>(); // 用于跟踪已添加的历史文件路径，防止历史文件结果之间的重复
    for (const result of otherResults) {
      // 对于特殊类型（AI、历史、设置等）和 URL，不需要去重
      if (result.type === "ai" || result.type === "history" || result.type === "settings" || result.type === "url" || result.type === "email" || result.type === "json_formatter" || result.type === "plugin") {
        deduplicatedResults.push(result);
        continue;
      }
      
      // 对于历史文件类型，检查是否已经添加过（防止历史文件结果之间的重复）
      if (result.type === "file") {
        const normalizedPath = result.path.toLowerCase().replace(/\\/g, "/");
        if (!addedHistoryPaths.has(normalizedPath)) {
          addedHistoryPaths.add(normalizedPath);
          deduplicatedResults.push(result);
        }
        // 如果路径已添加过，跳过（保留第一次出现的，通常使用频率更高）
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
          const aLnk = isLnkPath(a.path);
          const bLnk = isLnkPath(b.path);
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

        // Windows 设置应用优先级处理（当搜索设置相关关键词时）
        const aAppName = (a.app?.name || a.displayName || '').toLowerCase();
        const aAppPath = (a.path || '').toLowerCase();
        const aIsSettingsApp = (a.type === "app" && ((aAppName === '设置' || aAppName === 'settings') || 
                         aAppPath.startsWith('shell:appsfolder') || 
                         aAppPath.startsWith('ms-settings:')));
        const bAppName = (b.app?.name || b.displayName || '').toLowerCase();
        const bAppPath = (b.path || '').toLowerCase();
        const bIsSettingsApp = (b.type === "app" && ((bAppName === '设置' || bAppName === 'settings') || 
                         bAppPath.startsWith('shell:appsfolder') || 
                         bAppPath.startsWith('ms-settings:')));
        
        // 如果查询匹配设置关键词，Windows 设置应用优先级最高（仅次于特殊类型和插件）
        if (shouldShowSettings) {
          if (aIsSettingsApp && !bIsSettingsApp && !bIsSpecial && !bIsPlugin) return -1;
          if (!aIsSettingsApp && bIsSettingsApp && !aIsSpecial && !aIsPlugin) return 1;
        }

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
          const aLnk = isLnkPath(a.path);
          const bLnk = isLnkPath(b.path);
          if (aLnk !== bLnk) return aLnk ? -1 : 1;
        }

        // 历史文件始终优先于 Everything（即使分数更低）
        if (a.type === "file" && b.type === "everything") return -1;
        if (a.type === "everything" && b.type === "file") return 1;

        // 按评分降序排序（分数高的在前）
        if (bScore !== aScore) {
          // 如果查询匹配设置关键词，Windows 设置应用优先（即使分数稍低）
          if (shouldShowSettings) {
            const scoreDiff = Math.abs(bScore - aScore);
            if (scoreDiff <= 500) { // 允许更大的分数差距
              if (aIsSettingsApp && !bIsSettingsApp && !bIsSpecial && !bIsPlugin) return -1;
              if (!aIsSettingsApp && bIsSettingsApp && !aIsSpecial && !aIsPlugin) return 1;
            }
          }
          // 如果评分差距在200分以内，且一个是历史文件，另一个是 Everything 结果，优先历史文件
          const scoreDiff = Math.abs(bScore - aScore);
          if (scoreDiff <= 200) {
            if (a.type === "file" && b.type === "everything") return -1; // 历史文件优先
            if (a.type === "everything" && b.type === "file") return 1; // 历史文件优先
          }
          return bScore - aScore;
        }

        // 如果评分相同，优先顺序：Windows 设置应用 > 应用 > 历史文件 > Everything > 其他，然后按最近使用时间排序
        if (shouldShowSettings) {
          if (aIsSettingsApp && !bIsSettingsApp && !bIsSpecial && !bIsPlugin) return -1;
          if (!aIsSettingsApp && bIsSettingsApp && !aIsSpecial && !aIsPlugin) return 1;
        }
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
    
    // 如果 JSON 中包含链接，优先显示 JSON 格式化选项，否则按原来的顺序（URLs -> Emails -> JSON formatter -> other results）
    // 但所有插件始终在最前面
    if (jsonContainsLinks && jsonFormatterResult.length > 0) {
      return [...pluginResults, ...jsonFormatterResult, ...urlResults, ...emailResults, ...otherResultsWithoutPlugins];
    } else {
      // URLs always come first, then emails, then JSON formatter, then other results sorted by open history
      // 但所有插件始终在最前面
      return [...pluginResults, ...urlResults, ...emailResults, ...jsonFormatterResult, ...otherResultsWithoutPlugins];
    }
  }, [filteredApps, filteredFiles, filteredMemos, filteredPlugins, systemFolders, everythingResults, detectedUrls, detectedEmails, detectedJson, openHistory, query, aiAnswer]);

  // 使用 ref 来跟踪当前的 query，避免闭包问题
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  // Helper function to split results into horizontal and vertical
  const splitResults = (allResults: SearchResult[]) => {
    const executableResults = allResults.filter(result => {
      if (result.type === "app") {
        const pathLower = result.path.toLowerCase();
        // 包含可执行文件、快捷方式，以及 UWP 应用 URI（shell:AppsFolder 和 ms-settings:）
        return pathLower.endsWith('.exe') || 
               pathLower.endsWith('.lnk') ||
               pathLower.startsWith('shell:appsfolder') ||
               pathLower.startsWith('ms-settings:');
      }
      return false;
    });
    
    
    // 对应用结果按规范化路径去重（统一路径分隔符）
    // 对于"设置"应用，需要特殊处理：即使路径不同，也只保留一个
    const normalizedPathMap = new Map<string, SearchResult>();
    let hasSettingsApp = false;
    
    for (const result of executableResults) {
      if (result.type === "app") {
        const currentName = (result.app?.name || result.displayName || '').toLowerCase();
        const currentPath = result.path.toLowerCase();
        // 只对名称完全匹配"设置"/"Settings"或路径是 Windows 系统设置的应用进行特殊处理
        const isSettingsApp = (currentName === '设置' || currentName === 'settings') || 
                             currentPath.startsWith('shell:appsfolder') || 
                             currentPath.startsWith('ms-settings:');
        
        // 对于"设置"应用，只保留第一个（优先 shell:AppsFolder，其次 ms-settings:）
        if (isSettingsApp) {
          if (!hasSettingsApp) {
            // 第一个"设置"应用，直接添加
            const normalizedPath = result.path.toLowerCase().replace(/\\/g, "/");
            normalizedPathMap.set(normalizedPath, result);
            hasSettingsApp = true;
          } else {
            // 已经有"设置"应用了，检查当前这个是否更好
            const existingSettings = Array.from(normalizedPathMap.values()).find(r => {
              const name = (r.app?.name || r.displayName || '').toLowerCase();
              const path = r.path.toLowerCase();
              return (name === '设置' || name === 'settings') || 
                     path.startsWith('shell:appsfolder') || 
                     path.startsWith('ms-settings:');
            });
            
            if (existingSettings) {
              const existingPath = existingSettings.path.toLowerCase();
              const currentPath = result.path.toLowerCase();
              
              // 优先保留 shell:AppsFolder，其次 ms-settings:
              const currentIsShell = currentPath.startsWith('shell:appsfolder');
              const existingIsMsSettings = existingPath.startsWith('ms-settings:');
              
              // 如果当前是 shell:AppsFolder 而已有的是 ms-settings:，替换
              if (currentIsShell && existingIsMsSettings) {
                const existingNormalizedPath = existingSettings.path.toLowerCase().replace(/\\/g, "/");
                normalizedPathMap.delete(existingNormalizedPath);
                const normalizedPath = result.path.toLowerCase().replace(/\\/g, "/");
                normalizedPathMap.set(normalizedPath, result);
              }
              // 否则跳过（已有更好的版本）
            }
          }
          continue; // 跳过后续的普通去重逻辑
        }
        
        // 普通应用的去重逻辑
        // 规范化路径：统一使用正斜杠，转小写
        const normalizedPath = result.path.toLowerCase().replace(/\\/g, "/");
        
        if (!normalizedPathMap.has(normalizedPath)) {
          // 路径不存在，直接添加
          normalizedPathMap.set(normalizedPath, result);
        } else {
          // 路径已存在，比较并保留更好的版本
          const existing = normalizedPathMap.get(normalizedPath)!;
          const existingName = existing.app?.name || existing.displayName;
          
          // 优先保留名称不包含 .lnk 后缀的（更简洁）
          const currentHasLnkSuffix = currentName.toLowerCase().endsWith('.lnk');
          const existingHasLnkSuffix = existingName.toLowerCase().endsWith('.lnk');
          
          if (!currentHasLnkSuffix && existingHasLnkSuffix) {
            normalizedPathMap.set(normalizedPath, result);
          }
          // 如果名称后缀相同，优先保留有图标的
          else if (currentHasLnkSuffix === existingHasLnkSuffix) {
            if (result.app?.icon && !existing.app?.icon) {
              normalizedPathMap.set(normalizedPath, result);
            }
          }
        }
      }
    }
    
    const deduplicatedExecutableResults = Array.from(normalizedPathMap.values());
    
    const pluginResults = allResults.filter(result => result.type === "plugin");
    const systemFolderResults = allResults.filter(result => result.type === "system_folder");
    const horizontal = [...deduplicatedExecutableResults, ...pluginResults, ...systemFolderResults];
    
    const vertical = allResults.filter(result => {
      // Not an executable app, not a plugin, and not a system folder
      if (result.type === "app") {
        const pathLower = result.path.toLowerCase();
        // 排除可执行文件、快捷方式，以及 UWP 应用 URI（这些应该在横向列表中）
        return !pathLower.endsWith('.exe') && 
               !pathLower.endsWith('.lnk') &&
               !pathLower.startsWith('shell:appsfolder') &&
               !pathLower.startsWith('ms-settings:');
      }
      return result.type !== "plugin" && result.type !== "system_folder";
    });
    return { horizontal, vertical };
  };

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
      clearAllResults({
        setResults,
        setHorizontalResults,
        setVerticalResults,
        setSelectedHorizontalIndex,
        setSelectedVerticalIndex,
        horizontalResultsRef,
        currentLoadResultsRef,
        logMessage: '[horizontalResults] 清空横向结果 (查询为空)',
      });
      return;
    }

    // 如果查询不为空但结果为空，可能是搜索还在进行中（防抖导致 combinedResults 尚未更新）
    // 在这种情况下，清空旧结果，等待新的 combinedResults 更新
    if (queryRef.current.trim() !== "" && allResults.length === 0) {
      // 清空结果，避免显示旧查询的结果
      clearAllResults({
        setResults,
        setHorizontalResults,
        setVerticalResults,
        setSelectedHorizontalIndex,
        setSelectedVerticalIndex,
        horizontalResultsRef,
        currentLoadResultsRef,
        logMessage: '[horizontalResults] 清空横向结果 (结果为空)',
      });
      return;
    }

    // 保存当前要加载的结果引用，用于后续验证
    currentLoadResultsRef.current = allResults;

    // Split results into horizontal and vertical
    const { horizontal, vertical } = splitResults(allResults);

    const INITIAL_COUNT = 100; // 初始显示100条
    const INCREMENT = 50; // 每次增加50条
    const DELAY_MS = 16; // 每帧延迟（约60fps）
    // 如果结果数量少于或等于初始数量，直接设置所有结果（避免先设置初始结果再覆盖）
    if (allResults.length <= INITIAL_COUNT) {
      // 如果当前已经有横向结果，且新的结果中没有横向结果，保留当前的横向结果
      // 这样可以确保应用结果（通常是横向结果）不会被Everything结果覆盖
      const currentHorizontalRef = horizontalResultsRef.current || [];
      const hasExistingHorizontal = currentHorizontalRef.length > 0;
      const finalHorizontal = horizontal.length > 0 
        ? horizontal 
        : (hasExistingHorizontal ? currentHorizontalRef : []);
      setResults(allResults);
      setHorizontalResults(finalHorizontal);
      setVerticalResults(vertical);
      // 更新ref以跟踪当前的横向结果
      horizontalResultsRef.current = finalHorizontal;
      // Auto-select first horizontal result if available
      if (finalHorizontal.length > 0) {
        setSelectedHorizontalIndex(0);
        setSelectedVerticalIndex(null);
      } else if (vertical.length > 0) {
        setSelectedHorizontalIndex(null);
        setSelectedVerticalIndex(0);
      }
      currentLoadResultsRef.current = [];
      return;
    }

    // 重置显示数量（如果有结果就显示，即使查询为空）
    // 只有在结果数量 > INITIAL_COUNT 时才需要增量加载
    if (allResults.length > 0) {
      const initialResults = allResults.slice(0, INITIAL_COUNT);
      const { horizontal: initialHorizontal, vertical: initialVertical } = splitResults(initialResults);
      // 如果初始结果中没有横向结果，但全部结果中有横向结果，使用全部结果中的横向结果
      // 这样可以确保应用结果（通常是横向结果）不会被Everything结果覆盖
      // 同时，如果当前已经有横向结果，且新的初始结果中没有横向结果，保留当前的横向结果
      const currentHorizontalRef = horizontalResultsRef.current || [];
      const hasExistingHorizontal = currentHorizontalRef.length > 0;
      const finalHorizontal = initialHorizontal.length > 0 
        ? initialHorizontal 
        : (hasExistingHorizontal && horizontal.length === 0 
          ? currentHorizontalRef 
          : horizontal.slice(0, 20)); // 最多显示20个横向结果
      const finalVertical = initialVertical.length > 0 ? initialVertical : vertical;
      setResults(initialResults);
      // Split the initial results too
      setHorizontalResults(finalHorizontal);
      setVerticalResults(finalVertical);
      // 更新ref以跟踪当前的横向结果
      horizontalResultsRef.current = finalHorizontal;
      // Auto-select first horizontal result if available
      if (finalHorizontal.length > 0) {
        setSelectedHorizontalIndex(0);
        setSelectedVerticalIndex(null);
      } else if (finalVertical.length > 0) {
        setSelectedHorizontalIndex(null);
        setSelectedVerticalIndex(0);
      }
    }

    // 逐步加载更多结果
    let currentCount = INITIAL_COUNT;
    const loadMore = () => {
      // 在每次更新前检查：query 是否为空，以及结果是否已过时
      if (queryRef.current.trim() === "" || 
          currentLoadResultsRef.current !== allResults) {
        // 结果已过时或查询已清空，停止加载
        clearAllResults({
          setResults,
          setHorizontalResults,
          setVerticalResults,
          setSelectedHorizontalIndex,
          setSelectedVerticalIndex,
          currentLoadResultsRef,
          logMessage: '[horizontalResults] 清空横向结果 (结果已过时或查询已清空)',
        });
        incrementalLoadRef.current = null;
        incrementalTimeoutRef.current = null;
        return;
      }

      if (currentCount < allResults.length) {
        currentCount = Math.min(currentCount + INCREMENT, allResults.length);
        
        // 再次检查结果是否仍然有效
        if (queryRef.current.trim() !== "" && 
            currentLoadResultsRef.current === allResults) {
          const currentResults = allResults.slice(0, currentCount);
          const { horizontal: currentHorizontal, vertical: currentVertical } = splitResults(currentResults);
          setResults(currentResults);
          // 同步更新横向和纵向结果
          setHorizontalResults(currentHorizontal);
          setVerticalResults(currentVertical);
          // 更新ref以跟踪当前的横向结果
          horizontalResultsRef.current = currentHorizontal;
          // 打印横向结果列表（增量加载中）
          console.log('[horizontalResults] 增量更新横向结果:', currentHorizontal);
          console.log('[horizontalResults] 数量:', currentHorizontal.length);
          currentHorizontal.forEach((result, index) => {
            console.log(`[horizontalResults] [${index}]`, {
              type: result.type,
              displayName: result.displayName,
              path: result.path,
              app: result.app ? {
                name: result.app.name,
                path: result.app.path,
              } : undefined,
            });
          });
        } else {
          // 结果已过时，停止加载
          clearAllResults({
            setResults,
            setHorizontalResults,
            setVerticalResults,
            setSelectedHorizontalIndex,
            setSelectedVerticalIndex,
            currentLoadResultsRef,
            logMessage: '[horizontalResults] 清空横向结果 (增量加载中结果已过时)',
          });
          incrementalLoadRef.current = null;
          incrementalTimeoutRef.current = null;
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

  // 使用 ref 跟踪上一次的查询，用于检测查询变化
  const lastQueryInEffectRef = useRef<string>("");
  
  useEffect(() => {
    // 如果查询为空且没有 AI 回答，直接清空结果
    if (query.trim() === "" && !aiAnswer) {
      setResults([]);
      setHorizontalResults([]);
      console.log('[horizontalResults] 清空横向结果 (useEffect: 查询为空)');
      setVerticalResults([]);
      setSelectedHorizontalIndex(null);
      setSelectedVerticalIndex(null);
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
      lastQueryInEffectRef.current = query;
      return;
    }
    
    // 如果查询变化了，立即清空旧结果，避免显示错误的结果
    // 这样可以确保在 combinedResults 更新之前，不会显示旧查询的结果
    if (query.trim() !== lastQueryInEffectRef.current.trim()) {
      clearAllResults({
        setResults,
        setHorizontalResults,
        setVerticalResults,
        setSelectedHorizontalIndex,
        setSelectedVerticalIndex,
        currentLoadResultsRef,
        logMessage: `[horizontalResults] 清空横向结果 (useEffect: 查询变化) oldQuery: ${lastQueryInEffectRef.current}, newQuery: ${query}`,
      });
      // 取消所有增量加载任务
      if (incrementalLoadRef.current !== null) {
        cancelAnimationFrame(incrementalLoadRef.current);
        incrementalLoadRef.current = null;
      }
      if (incrementalTimeoutRef.current !== null) {
        clearTimeout(incrementalTimeoutRef.current);
        incrementalTimeoutRef.current = null;
      }
      // 如果查询变化且不是粘贴的图片路径，清除粘贴图片状态
      if (query.trim() !== pastedImagePath) {
        setPastedImagePath(null);
        setPastedImageDataUrl(null);
      }
      lastQueryInEffectRef.current = query;
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

  // Watch results changes and set selectedIndex to first horizontal result
  useEffect(() => {
    
    // If we just jumped to vertical, don't reset selectedIndex
    if (justJumpedToVerticalRef.current) {
      return;
    }
    
    if (results.length === 0) {
      setSelectedIndex(0);
      return;
    }
    
    // Calculate horizontal results (executables and plugins)
    const executableResults = results.filter(result => {
      if (result.type === "app") {
        const pathLower = result.path.toLowerCase();
        return pathLower.endsWith('.exe') || pathLower.endsWith('.lnk');
      }
      return false;
    });
    
    const pluginResults = results.filter(result => {
      return result.type === "plugin";
    });
    
    const systemFolderResults = results.filter(result => {
      return result.type === "system_folder";
    });
    
    const horizontalResults = [...executableResults, ...pluginResults, ...systemFolderResults];
    
    
    // If there are horizontal results, set selectedIndex to the first one
    if (horizontalResults.length > 0) {
      const firstHorizontalIndex = results.indexOf(horizontalResults[0]);
      if (firstHorizontalIndex >= 0) {
        // Mark that we're auto-selecting to prevent scrollIntoView
        isAutoSelectingFirstHorizontalRef.current = true;
        setSelectedIndex(firstHorizontalIndex);
        // Reset flag after a short delay to allow scrollIntoView for user navigation
        setTimeout(() => {
          isAutoSelectingFirstHorizontalRef.current = false;
        }, 100);
        return;
      }
    }
    
    // Otherwise, set to 0 (first result)
    if (selectedIndex !== 0) {
      setSelectedIndex(0);
    }
  }, [results]);

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

              // Use saved window width
              const targetWidth = windowWidth;
              
              // 限制最大高度，避免窗口突然撑高导致不丝滑
              const MAX_HEIGHT = 600;
              const MIN_HEIGHT = 200;
              const targetHeight = Math.max(MIN_HEIGHT, Math.min(containerHeight, MAX_HEIGHT));
              
              // 直接设置窗口大小（简化版本，不使用动画过渡以避免复杂性）
              window.setSize(new LogicalSize(targetWidth, targetHeight)).catch(console.error);
            });
          });
        }
      };
      
      // Adjust size after results state updates (减少延迟)
      setTimeout(adjustWindowSize, 100);
    }, [results, isMemoModalOpen, windowWidth]);

  // Update window size when windowWidth changes (but not during resizing)
  useEffect(() => {
    if (isMemoModalOpen || isPluginListModalOpen || isResizing) {
      return;
    }
    
    setTimeout(() => {
      adjustWindowSize({
        windowWidth,
        isMemoModalOpen,
        getContainer: getMainContainer,
      });
    }, 50);
  }, [windowWidth, isMemoModalOpen, isPluginListModalOpen, isResizing]);


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
        const MAX_HEIGHT = 600;
        const MIN_HEIGHT = 200;
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
  // 只在 selectedVerticalIndex 变化时滚动，避免在结果更新时意外滚动
  useEffect(() => {
    // 如果正在保持滚动位置，不要执行 scrollIntoView
    if (shouldPreserveScrollRef.current) {
      return;
    }
    
    // 如果是横向导航切换，不要执行 scrollIntoView，避免页面滚动
    if (isHorizontalNavigationRef.current) {
      return;
    }
    
    // 如果正在自动选择第一个横向结果，不要执行 scrollIntoView，避免页面滚动到顶部
    if (isAutoSelectingFirstHorizontalRef.current) {
      return;
    }
    
    // 如果刚刚从横向跳转到纵向，不要执行 scrollIntoView，避免过度滚动
    if (justJumpedToVerticalRef.current) {
      return;
    }
    
    
    // Only scroll for vertical results (horizontal results are in a horizontal scroll container)
    if (listRef.current && selectedVerticalIndex !== null && verticalResults.length > 0 && selectedVerticalIndex >= 0) {
      const container = listRef.current;
      // Get the selected vertical result
      const result = verticalResults[selectedVerticalIndex];
      if (!result) {
        return;
      }
      
      // The key format is: `${result.type}-${result.path}-${selectedVerticalIndex}`
      const itemKey = `${result.type}-${result.path}-${selectedVerticalIndex}`;
      const item = container.querySelector(`[data-item-key="${itemKey}"]`) as HTMLElement;
      
      
      if (!item) {
        // Fallback: try to find by iterating through children and checking data attributes
        // or use offsetTop if the element structure allows
        const allItems = container.querySelectorAll('[data-item-key]');
        for (let i = 0; i < allItems.length; i++) {
          const el = allItems[i] as HTMLElement;
          if (el.dataset.itemKey === itemKey) {
            const item = el;
                const itemHeight = item.offsetHeight;
                const containerTop = container.scrollTop;
                const containerHeight = container.clientHeight;
                
                // Use getBoundingClientRect to get accurate position relative to viewport
                const containerRect = container.getBoundingClientRect();
                const itemRect = item.getBoundingClientRect();
                // Calculate item's position in the scrollable content
                // itemRect.top - containerRect.top gives position relative to container's visible area
                // Add containerTop to get absolute position in scrollable content
                const itemTopRelative = itemRect.top - containerRect.top + containerTop;
                
                const itemBottom = itemTopRelative + itemHeight;
                const visibleTop = containerTop;
                const visibleBottom = containerTop + containerHeight;
                
                
                // Only scroll if item is not fully visible
                if (itemTopRelative < visibleTop || itemBottom > visibleBottom) {
                  // Calculate target scroll position - only scroll the minimum needed
                  const padding = 8; // Small padding for visual spacing
                  let targetScroll = containerTop; // Start with current scroll
                  
                  if (itemTopRelative < visibleTop) {
                    // Item is above visible area - scroll up just enough to show it
                    targetScroll = itemTopRelative - padding;
                  } else if (itemBottom > visibleBottom) {
                    // Item is below visible area - scroll down just enough to show it
                    // Only scroll if we need to - calculate minimum scroll needed
                    const scrollNeeded = itemBottom - visibleBottom + padding;
                    targetScroll = containerTop + scrollNeeded;
                  }
                  
                  // Ensure we don't scroll past the top
                  if (targetScroll < 0) {
                    targetScroll = 0;
                  }
                  
                  // Ensure we don't scroll past the bottom
                  const maxScroll = container.scrollHeight - containerHeight;
                  if (targetScroll > maxScroll) {
                    targetScroll = maxScroll;
                  }
                  
                  
                  container.scrollTo({
                    top: targetScroll,
                    behavior: "smooth",
                  });
                } else {
                }
                return;
              }
            }
            return;
          }
      
      // If we found the item, use it
      if (item) {
        const itemHeight = item.offsetHeight;
        const containerTop = container.scrollTop;
        const containerHeight = container.clientHeight;
        
        // Use getBoundingClientRect to get accurate position relative to viewport
        const containerRect = container.getBoundingClientRect();
        const itemRect = item.getBoundingClientRect();
        // Calculate item's position in the scrollable content
        // itemRect.top - containerRect.top gives position relative to container's visible area
        // Add containerTop to get absolute position in scrollable content
        const itemTopRelative = itemRect.top - containerRect.top + containerTop;
        
        const itemBottom = itemTopRelative + itemHeight;
        const visibleTop = containerTop;
        const visibleBottom = containerTop + containerHeight;
        
        
        // Only scroll if item is not fully visible
        if (itemTopRelative < visibleTop || itemBottom > visibleBottom) {
          // Calculate target scroll position - only scroll the minimum needed
          const padding = 8; // Small padding for visual spacing
          let targetScroll = containerTop; // Start with current scroll
          
          if (itemTopRelative < visibleTop) {
            // Item is above visible area - scroll up just enough to show it
            targetScroll = itemTopRelative - padding;
          } else if (itemBottom > visibleBottom) {
            // Item is below visible area - scroll down just enough to show it
            // Only scroll if we need to - calculate minimum scroll needed
            const scrollNeeded = itemBottom - visibleBottom + padding;
            targetScroll = containerTop + scrollNeeded;
          }
          
          // Ensure we don't scroll past the top
          if (targetScroll < 0) {
            targetScroll = 0;
          }
          
          // Ensure we don't scroll past the bottom
          const maxScroll = container.scrollHeight - containerHeight;
          if (targetScroll > maxScroll) {
            targetScroll = maxScroll;
          }
          
          
          container.scrollTo({
            top: targetScroll,
            behavior: "smooth",
          });
        } else {
        }
      } else {
      }
    } else {
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVerticalIndex]); // 只依赖 selectedVerticalIndex，避免在结果更新时触发滚动

  // Scroll selected horizontal item into view
  useEffect(() => {
    // Only scroll for horizontal results
    if (horizontalScrollContainerRef.current && selectedHorizontalIndex !== null && horizontalResults.length > 0 && selectedHorizontalIndex >= 0) {
      const container = horizontalScrollContainerRef.current;
      
      // Use double requestAnimationFrame to ensure DOM is fully updated after state change
      // This is especially important when jumping from vertical to horizontal results
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!container) return;

          // First, ensure the horizontal section is visible in the main list container
          // This is important when jumping from vertical results to horizontal results
          // Since horizontal results are at the top of the list, scroll to top to show them
          if (listRef.current) {
            const listContainer = listRef.current;
            const listRect = listContainer.getBoundingClientRect();
            
            // Check if horizontal section is visible
            if (container.parentElement) {
              const horizontalSection = container.parentElement as HTMLElement;
              const sectionRect = horizontalSection.getBoundingClientRect();
              
              // If horizontal section is not fully visible in the list container, scroll to top
              if (sectionRect.top < listRect.top || sectionRect.bottom > listRect.bottom) {
                listContainer.scrollTo({
                  top: 0,
                  behavior: "smooth",
                });
              }
            }
          }

          // Find the selected item element
          const item = container.children[selectedHorizontalIndex] as HTMLElement;
          
          if (!item) {
            return;
          }

          // Use getBoundingClientRect to get actual rendered position (including transforms like scale)
          const containerRect = container.getBoundingClientRect();
          const itemRect = item.getBoundingClientRect();
          
          // For first item (index 0), ensure it's fully visible even when scaled
          if (selectedHorizontalIndex === 0) {
            // Scroll to position 0 to show the first item
            container.scrollTo({
              left: 0,
              behavior: "smooth",
            });
            return;
          }
          
          // Calculate item's position relative to container's scrollable content
          // itemRect.left - containerRect.left gives position relative to visible area
          // Add container.scrollLeft to get absolute position in scrollable content
          const itemLeftRelative = itemRect.left - containerRect.left + container.scrollLeft;
          const itemWidth = itemRect.width;
          const itemRightRelative = itemLeftRelative + itemWidth;
          
          const containerScrollLeft = container.scrollLeft;
          const containerWidth = container.clientWidth;
          const visibleLeft = containerScrollLeft;
          const visibleRight = containerScrollLeft + containerWidth;
          
          // Only scroll if item is not fully visible
          if (itemLeftRelative < visibleLeft || itemRightRelative > visibleRight) {
            const padding = 8; // Small padding for visual spacing
            let targetScroll = containerScrollLeft;
            
            if (itemLeftRelative < visibleLeft) {
              // Item is to the left of visible area - scroll left to show it
              targetScroll = itemLeftRelative - padding;
            } else if (itemRightRelative > visibleRight) {
              // Item is to the right of visible area - scroll right to show it
              const scrollNeeded = itemRightRelative - visibleRight + padding;
              targetScroll = containerScrollLeft + scrollNeeded;
            }
            
            // Ensure we don't scroll past the left
            if (targetScroll < 0) {
              targetScroll = 0;
            }
            
            // Ensure we don't scroll past the right
            const maxScroll = container.scrollWidth - containerWidth;
            if (targetScroll > maxScroll) {
              targetScroll = maxScroll;
            }
            
            container.scrollTo({
              left: targetScroll,
              behavior: "smooth",
            });
          }
        });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHorizontalIndex]); // 只依赖 selectedHorizontalIndex

  const loadApplications = async (forceRescan: boolean = false) => {
    try {
      setIsLoading(true);
      
      if (forceRescan) {
        // 重新扫描：通过事件监听获取结果
        await new Promise<void>((resolve, reject) => {
          let unlistenComplete: (() => void) | null = null;
          let unlistenError: (() => void) | null = null;
          
          const setupListeners = async () => {
            // 监听扫描完成事件
            unlistenComplete = await listen<{ apps: AppInfo[] }>("app-rescan-complete", (event) => {
              const { apps } = event.payload;
              console.log(`[DEBUG] Rescanned ${apps.length} applications`);
              setApps(apps);
              setFilteredApps(apps.slice(0, 10));
              setIsLoading(false);
              
              // 清理监听器
              if (unlistenComplete) unlistenComplete();
              if (unlistenError) unlistenError();
              
              resolve();
            });

            // 监听扫描错误事件
            unlistenError = await listen<{ error: string }>("app-rescan-error", (event) => {
              const { error } = event.payload;
              console.error("应用重新扫描失败:", error);
              setApps([]);
              setFilteredApps([]);
              setIsLoading(false);
              
              // 清理监听器
              if (unlistenComplete) unlistenComplete();
              if (unlistenError) unlistenError();
              
              reject(new Error(error));
            });
          };

          setupListeners().then(() => {
            // 启动重新扫描
            tauriApi.rescanApplications().catch((error) => {
              console.error("Failed to start rescan:", error);
              setApps([]);
              setFilteredApps([]);
              setIsLoading(false);
              
              // 清理监听器
              if (unlistenComplete) unlistenComplete();
              if (unlistenError) unlistenError();
              
              reject(error);
            });
          }).catch((error) => {
            setIsLoading(false);
            reject(error);
          });
        });
      } else {
        // 正常扫描：直接返回结果
        await new Promise<void>((resolve) => {
          setTimeout(async () => {
            try {
              const allApps = await tauriApi.scanApplications();
              console.log(`[DEBUG] Loaded ${allApps.length} applications`);
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
      }
    } catch (error) {
      console.error("Failed to load applications:", error);
      setApps([]);
      setFilteredApps([]);
      setIsLoading(false);
    }
  };

  const searchApplications = async (searchQuery: string) => {
    // 立即清空旧结果，避免显示上一个搜索的结果
    setFilteredApps([]);
    
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
      const currentQueryTrimmed = query.trim();
      const searchQueryTrimmed = searchQuery.trim();
      const shouldUpdate = currentQueryTrimmed === searchQueryTrimmed;
      if (shouldUpdate) {
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

  // 监听图标更新事件，收到后刷新搜索结果中的图标
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupListener = async () => {
      try {
        unlisten = await listen<Array<[string, string]>>("app-icons-updated", (event) => {
          const iconUpdates = event.payload;
          
          // 更新 filteredApps 中的图标
          setFilteredApps((prevApps) => {
            const updatedApps = prevApps.map((app) => {
              const iconUpdate = iconUpdates.find(([path]) => path === app.path);
              if (iconUpdate) {
                return { ...app, icon: iconUpdate[1] };
              }
              return app;
            });
            return updatedApps;
          });

          // 同时更新 apps 缓存中的图标
          setApps((prevApps) => {
            const updatedApps = prevApps.map((app) => {
              const iconUpdate = iconUpdates.find(([path]) => path === app.path);
              if (iconUpdate) {
                return { ...app, icon: iconUpdate[1] };
              }
              return app;
            });
            return updatedApps;
          });
        });
      } catch (error) {
        console.error("Failed to setup app-icons-updated listener:", error);
      }
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

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
    
    // 检查是否是重复调用（在取消之前检查，避免不必要的取消操作）
    // 注意：防抖结束后已经检查过了，但这里需要再次检查，因为可能有异步调用
    if (currentSearchRef.current) {
      if (currentSearchRef.current.query === searchQuery) {
        // 如果 query 相同，说明是重复调用，不应该取消
        console.log("[DEBUG] Search with same query already in progress, skipping duplicate call:", searchQuery);
        return;
      }
      // 如果 query 不同，说明需要取消旧搜索
      console.log("[DEBUG] Previous search query differs, will cancel:", {
        previousQuery: currentSearchRef.current.query,
        newQuery: searchQuery
      });
    }

    // 后端存在"相同查询进行中则报错跳过"的保护，这里每次新搜索前主动取消上一轮，避免误判卡死
    try {
      await tauriApi.cancelEverythingSearch();
    } catch (cancelErr) {
      console.warn("取消上一轮 Everything 搜索失败（忽略继续）:", cancelErr);
    }
    // 前端同步清理当前搜索引用，允许同一关键字立即重新发起请求
    if (currentSearchRef.current) {
      currentSearchRef.current.cancelled = true;
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
      // Record open history for all types (but delay updating state to avoid reordering during animation)
      try {
        void tauriApi.recordOpenHistory(result.path);
        // Don't update local state immediately to prevent list reordering during animation
      } catch (error) {
        console.error("Failed to record open history:", error);
      }

      // Store the path and timestamp for later state update (after animation)
      const pathToUpdate = result.path;
      const timestampToUpdate = Date.now() / 1000;

      if (result.type === "ai" && result.aiAnswer) {
        // AI 回答点击时，可以复制到剪贴板或什么都不做
        // 这里暂时不做任何操作，只是显示结果
        return;
      } else if (result.type === "url" && result.url) {
        await tauriApi.openUrl(result.url);
        // 打开链接后隐藏启动器
        await hideLauncherAndResetState();
        return;
      } else if (result.type === "email" && result.email) {
        // 复制邮箱地址到剪贴板
        try {
          await navigator.clipboard.writeText(result.email);
          // 显示成功提示，不隐藏启动器
          setSuccessMessage(`已复制邮箱地址：${result.email}`);
          // 3秒后自动关闭提示
          setTimeout(() => {
            setSuccessMessage(null);
          }, 3000);
        } catch (error) {
          console.error("Failed to copy email to clipboard:", error);
          setErrorMessage("复制邮箱地址失败");
        }
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
        try {
          // 设置正在启动的应用路径，触发动画
          setLaunchingAppPath(result.app.path);
          
          // 等待动画完成（200ms）
          await new Promise(resolve => setTimeout(resolve, 200));
          
          // 启动应用
          await tauriApi.launchApplication(result.app);
          trackEvent("app_launched", { name: result.app.name });
          
          // 动画完成后，更新本地历史状态（此时启动器即将关闭，不会影响列表顺序）
          if (pathToUpdate) {
            setOpenHistory(prev => ({
              ...prev,
              [pathToUpdate]: timestampToUpdate,
            }));
          }
          
          // 清除启动状态
          setLaunchingAppPath(null);
        } catch (launchError: any) {
          // 如果启动失败，清除启动状态
          setLaunchingAppPath(null);
          // 即使启动失败，也更新历史记录（因为用户确实尝试打开了）
          if (pathToUpdate) {
            setOpenHistory(prev => ({
              ...prev,
              [pathToUpdate]: timestampToUpdate,
            }));
          }
          const errorMsg = launchError?.message || launchError?.toString() || "";
          // 检测是否是文件不存在的错误，自动删除索引
          if (
            errorMsg.includes("快捷方式文件不存在") ||
            errorMsg.includes("快捷方式目标不存在") ||
            errorMsg.includes("应用程序未找到")
          ) {
            try {
              // 自动删除无效的索引
              await tauriApi.removeAppFromIndex(result.app.path);
              // 从本地状态中移除已删除的应用
              setApps((prevApps) => prevApps.filter((app) => app.path !== result.app!.path));
              setFilteredApps((prevFiltered) => prevFiltered.filter((app) => app.path !== result.app!.path));
              // 刷新搜索结果
              if (query.trim()) {
                await searchApplications(query);
              } else {
                await loadApplications();
              }
              // 显示提示信息
              setErrorMessage(`${errorMsg}\n\n已自动删除该无效索引。`);
            } catch (deleteError: any) {
              console.error("Failed to remove app from index:", deleteError);
              // 如果删除失败，仍然显示原始错误
              setErrorMessage(errorMsg);
            }
          } else {
            // 其他错误，正常显示
            setErrorMessage(errorMsg);
          }
          return; // 不继续执行后续的 hideLauncherAndResetState
        }
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
          query,
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
      
      // 对于非应用类型，在启动器关闭前更新历史记录状态
      // 应用类型已经在动画完成后更新了，这里跳过
      if (result.type !== "app" && pathToUpdate) {
        setOpenHistory(prev => ({
          ...prev,
          [pathToUpdate]: timestampToUpdate,
        }));
      }
      
      // Hide launcher window after launch
      await hideLauncherAndResetState();
    } catch (error: any) {
      console.error("Failed to launch:", error);
      // 显示友好的错误提示（如果还没有设置错误消息）
      if (!errorMessage) {
        const errorMsg = error?.message || error?.toString() || "未知错误";
        setErrorMessage(errorMsg);
      }
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


  const handlePaste = async (e: React.ClipboardEvent) => {
    const clipboardTypes = Array.from(e.clipboardData.types);
    console.log("Clipboard types:", clipboardTypes);
    
    // 首先检查剪贴板是否包含图片
    const imageTypes = clipboardTypes.filter(type => type.startsWith("image/"));
    if (imageTypes.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      
      try {
        // 获取图片数据
        const imageType = imageTypes[0];
        const imageItem = Array.from(e.clipboardData.items).find(item => item.type.startsWith("image/"));
        
        if (imageItem) {
          const imageFile = imageItem.getAsFile();
          
          if (imageFile) {
            // 读取图片数据
            const arrayBuffer = await imageFile.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            
            // 创建 base64 data URL 用于预览（使用 FileReader 避免大文件问题）
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => {
                if (reader.result) {
                  resolve(reader.result as string);
                } else {
                  reject(new Error("Failed to read image data"));
                }
              };
              reader.onerror = () => reject(new Error("Failed to read image"));
              reader.readAsDataURL(imageFile);
            });
            setPastedImageDataUrl(dataUrl);
            
            // 确定文件扩展名
            let extension = "png";
            if (imageType.includes("jpeg") || imageType.includes("jpg")) {
              extension = "jpg";
            } else if (imageType.includes("gif")) {
              extension = "gif";
            } else if (imageType.includes("webp")) {
              extension = "webp";
            } else if (imageType.includes("bmp")) {
              extension = "bmp";
            }
            
            // 保存图片到临时文件
            const tempPath = await tauriApi.saveClipboardImage(uint8Array, extension);
            console.log("Saved clipboard image to:", tempPath);
            
            // 保存粘贴的图片路径到状态
            setPastedImagePath(tempPath);
            
            // 处理粘贴的图片路径
            await processPastedPath(tempPath);
            return;
          }
        }
      } catch (error) {
        console.error("Failed to process clipboard image:", error);
        setErrorMessage("粘贴图片失败: " + (error as Error).message);
      }
    }
    
    // 清除粘贴图片状态（如果粘贴的是其他内容）
    if (!clipboardTypes.some(type => type.startsWith("image/"))) {
      setPastedImagePath(null);
      setPastedImageDataUrl(null);
    }
    
    // Check if clipboard contains files (when copying folders/files in Windows)
    if (clipboardTypes.includes("Files")) {
      e.preventDefault();
      e.stopPropagation();
      
      const files = e.clipboardData.files;
      console.log("Files in clipboard:", files.length);
      
      if (files.length > 0) {
        // 检查第一个文件是否是图片文件
        const firstFile = files[0];
        const fileName = firstFile.name.toLowerCase();
        const isImageFile = fileName.endsWith('.png') || 
                          fileName.endsWith('.jpg') || 
                          fileName.endsWith('.jpeg') || 
                          fileName.endsWith('.gif') || 
                          fileName.endsWith('.webp') || 
                          fileName.endsWith('.bmp');
        
        // 如果是图片文件且剪贴板中没有 image/ 类型，尝试作为图片处理
        if (isImageFile && imageTypes.length === 0) {
          try {
            const arrayBuffer = await firstFile.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            
            // 创建 base64 data URL 用于预览（使用 FileReader 避免大文件问题）
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => {
                if (reader.result) {
                  resolve(reader.result as string);
                } else {
                  reject(new Error("Failed to read image data"));
                }
              };
              reader.onerror = () => reject(new Error("Failed to read image"));
              reader.readAsDataURL(firstFile);
            });
            setPastedImageDataUrl(dataUrl);
            
            // 确定文件扩展名
            let extension = "png";
            if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) {
              extension = "jpg";
            } else if (fileName.endsWith('.gif')) {
              extension = "gif";
            } else if (fileName.endsWith('.webp')) {
              extension = "webp";
            } else if (fileName.endsWith('.bmp')) {
              extension = "bmp";
            }
            
            // 保存图片到临时文件
            const tempPath = await tauriApi.saveClipboardImage(uint8Array, extension);
            console.log("Saved clipboard image file to:", tempPath);
            
            // 保存粘贴的图片路径到状态
            setPastedImagePath(tempPath);
            
            // 处理粘贴的图片路径
            await processPastedPath(tempPath);
            return;
          } catch (error) {
            console.error("Failed to process clipboard image file:", error);
            // 如果图片处理失败，继续尝试作为普通文件处理
          }
        }
        
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
            } else {
              console.log("Tauri clipboard API returned null");
            }
          } catch (error) {
            console.error("Failed to get clipboard file path:", error);
          }
        }
        
        if (pathText) {
          console.log("Processing path from clipboard files:", pathText);
          await processPastedPath(pathText);
        } else {
          console.log("Could not get file path from clipboard - file may need to be selected from file system");
          // 如果无法获取路径，至少显示文件名
          setQuery(firstFile.name);
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

  const handleSaveImageToDownloads = async (imagePath: string) => {
    try {
      const savedPath = await tauriApi.copyFileToDownloads(imagePath);
      setSuccessMessage(`图片已保存到下载目录: ${savedPath}`);
      setPastedImagePath(null); // 清除状态
      setPastedImageDataUrl(null); // 清除预览
      // 只添加到历史记录，不更新搜索结果，避免自动打开
      try {
        await tauriApi.addFileToHistory(savedPath);
      } catch (error) {
        // 静默处理历史记录添加错误
        console.log("Failed to add to history:", error);
      }
      // 3秒后自动清除成功消息
      setTimeout(() => {
        setSuccessMessage(null);
      }, 3000);
    } catch (error) {
      setErrorMessage("保存图片失败: " + (error as Error).message);
    }
  };


  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (e.key === "Escape" || e.keyCode === 27) {
      e.preventDefault();
      e.stopPropagation();
      // 如果错误弹窗已打开，关闭错误弹窗（ErrorDialog 内部也会处理 ESC，但这里提前处理以避免其他逻辑执行）
      if (errorMessage) {
        setErrorMessage(null);
        return;
      }
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
      
      // 检查当前焦点是否在输入框
      const isInputFocused = document.activeElement === inputRef.current;
      
      // 如果当前选中的是横向结果，按ArrowDown应该跳转到第一个纵向结果
      if (selectedHorizontalIndex !== null) {
        if (verticalResults.length > 0) {
          // Mark that we just jumped to vertical to prevent results useEffect from resetting
          justJumpedToVerticalRef.current = true;
          setSelectedHorizontalIndex(null);
          setSelectedVerticalIndex(0);
          // Reset flag after a delay
          setTimeout(() => {
            justJumpedToVerticalRef.current = false;
          }, 200);
          return;
        }
        // No vertical results, stay at horizontal
        return;
      }
      
      // 如果当前选中的是纵向结果，移动到下一个纵向结果
      if (selectedVerticalIndex !== null) {
        if (selectedVerticalIndex < verticalResults.length - 1) {
          // Ensure horizontal navigation flag is false for vertical navigation
          isHorizontalNavigationRef.current = false;
          setSelectedVerticalIndex(selectedVerticalIndex + 1);
          return;
        }
        // No more vertical results, stay at current position
        return;
      }
      
      // 如果输入框有焦点，且有横向结果，则选中第一个横向结果
      if (isInputFocused && horizontalResults.length > 0) {
        selectFirstHorizontal(setSelectedHorizontalIndex, setSelectedVerticalIndex);
        return;
      }
      
      // 如果输入框有焦点，且有纵向结果，则选中第一个纵向结果
      if (isInputFocused && verticalResults.length > 0) {
        selectFirstVertical(setSelectedHorizontalIndex, setSelectedVerticalIndex);
        return;
      }
      
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      
      // If we're at the first horizontal result, focus back to the search input
      if (selectedHorizontalIndex === 0) {
        // Focus the input and move cursor to the end
        if (inputRef.current) {
          inputRef.current.focus();
          const length = inputRef.current.value.length;
          inputRef.current.setSelectionRange(length, length);
        }
        resetSelectedIndices(setSelectedHorizontalIndex, setSelectedVerticalIndex);
        return;
      }
      
      // If we're at the first vertical result, focus back to input or jump to first horizontal
      if (selectedVerticalIndex === 0) {
        if (horizontalResults.length > 0) {
          // Jump to first horizontal result
          selectFirstHorizontal(setSelectedHorizontalIndex, setSelectedVerticalIndex);
          return;
        } else {
          // Focus input
          if (inputRef.current) {
            inputRef.current.focus();
            const length = inputRef.current.value.length;
            inputRef.current.setSelectionRange(length, length);
          }
          resetSelectedIndices(setSelectedHorizontalIndex, setSelectedVerticalIndex);
          return;
        }
      }
      
      // If current selection is in vertical results, move to previous vertical result
      if (selectedVerticalIndex !== null && selectedVerticalIndex > 0) {
        // Ensure horizontal navigation flag is false for vertical navigation
        isHorizontalNavigationRef.current = false;
        setSelectedVerticalIndex(selectedVerticalIndex - 1);
        return;
      }
      
      // If current selection is in horizontal results (not first), move to previous horizontal
      if (selectedHorizontalIndex !== null && selectedHorizontalIndex > 0) {
        setSelectedHorizontalIndex(selectedHorizontalIndex - 1);
        setSelectedVerticalIndex(null);
        return;
      }
      
      return;
    }

    // 横向结果切换（ArrowLeft/ArrowRight）
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      // 检查输入框是否有焦点，以及光标位置
      const isInputFocused = document.activeElement === inputRef.current;
      if (isInputFocused && inputRef.current) {
        const input = inputRef.current;
        const selectionStart = input.selectionStart ?? 0;
        const selectionEnd = input.selectionEnd ?? 0;
        const valueLength = input.value.length;
        
        // 如果有文本被选中，允许方向键正常处理（用于取消选中或移动光标）
        if (selectionStart !== selectionEnd) {
          return; // 不拦截，让输入框正常处理
        }
        
        // 对于左箭头：只有当横向列表选中的不是第1个元素时，才优先用于横向列表
        // 如果横向列表选中的是第1个元素（索引0）或没有选中项，允许在输入框内移动光标
        if (e.key === "ArrowLeft") {
          // 如果横向列表选中的不是第1个元素，优先用于横向列表导航
          if (selectedHorizontalIndex !== null && selectedHorizontalIndex !== 0) {
            // 不返回，继续执行横向列表切换逻辑
          } else {
            // 横向列表没有选中项或选中第1个元素，允许在输入框内移动光标
            // 无论光标在哪里，都让输入框处理（即使光标在开头无法移动，也不应该跳到横向列表）
            return; // 让输入框处理左箭头
          }
        }
        
        // 对于右箭头：如果光标不在最右端，优先用于输入框；否则用于横向列表切换
        if (e.key === "ArrowRight") {
          // 如果光标不在最右端，优先用于输入框移动光标
          if (selectionEnd < valueLength) {
            return; // 光标不在结尾，允许右移
          }
          // 如果光标在最右端，不返回，继续执行横向列表切换逻辑
        }
      }
      
      // 立即阻止默认行为和事件传播，防止页面滚动
      e.preventDefault();
      e.stopPropagation();
      
      // 如果横向结果为空，不处理但已阻止默认行为
      if (horizontalResults.length === 0) {
        return;
      }
      
      // 标记这是横向导航，避免触发 scrollIntoView
      isHorizontalNavigationRef.current = true;
      
      // 如果当前选中的是横向结果
      if (selectedHorizontalIndex !== null) {
        // 在横向结果之间切换
        if (e.key === "ArrowRight") {
          // 切换到下一个横向结果
          const nextIndex = selectedHorizontalIndex < horizontalResults.length - 1 
            ? selectedHorizontalIndex + 1 
            : 0; // 循环到第一个
          setSelectedHorizontalIndex(nextIndex);
          setSelectedVerticalIndex(null);
        } else if (e.key === "ArrowLeft") {
          // 如果是在第一个横向结果，跳到最后一个横向结果
          if (selectedHorizontalIndex === 0) {
            setSelectedHorizontalIndex(horizontalResults.length - 1);
            setSelectedVerticalIndex(null);
            return;
          }
          // 否则切换到上一个横向结果
          const prevIndex = selectedHorizontalIndex > 0 
            ? selectedHorizontalIndex - 1 
            : horizontalResults.length - 1; // 循环到最后一个
          setSelectedHorizontalIndex(prevIndex);
          setSelectedVerticalIndex(null);
        }
      } else {
        // 当前选中的是纵向结果，切换到横向结果的第一个或最后一个
        if (e.key === "ArrowRight") {
          // 切换到横向结果的第一个
          setSelectedHorizontalIndex(0);
          setSelectedVerticalIndex(null);
        } else if (e.key === "ArrowLeft") {
          // 切换到横向结果的最后一个
          setSelectedHorizontalIndex(horizontalResults.length - 1);
          setSelectedVerticalIndex(null);
        }
      }
      
      // 在下一个 tick 重置标志，允许后续的垂直导航触发滚动
      setTimeout(() => {
        isHorizontalNavigationRef.current = false;
      }, 0);
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      // Get the selected result from either horizontal or vertical
      let selectedResult: SearchResult | null = null;
      if (selectedHorizontalIndex !== null && horizontalResults[selectedHorizontalIndex]) {
        selectedResult = horizontalResults[selectedHorizontalIndex];
      } else if (selectedVerticalIndex !== null && verticalResults[selectedVerticalIndex]) {
        selectedResult = verticalResults[selectedVerticalIndex];
      }
      if (selectedResult) {
        await handleLaunch(selectedResult);
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
            className={`${layout.header} select-none`}
            onMouseDown={async (e) => {
              // 手动触发拖拽，移除 data-tauri-drag-region 避免冲突
              // 排除输入框和应用中心按钮
              // 注意：wrapper 区域会 stopPropagation，所以这里主要处理 wrapper 上方的区域
              const target = e.target as HTMLElement;
              const isInput = target.tagName === 'INPUT' || target.closest('input');
              const isAppCenterButton = target.closest('[title="应用中心"]');
              if (!isInput && !isAppCenterButton) {
                // 使用和 wrapper 相同的可靠逻辑：先阻止默认行为和冒泡，再调用拖拽
                e.preventDefault();
                e.stopPropagation();
                await startWindowDragging();
              }
            }}
          >
            <div className="flex items-center gap-3 select-none h-full">
              {/* 拖拽手柄图标 */}
              <svg
                className={layout.dragHandleIcon}
                fill="currentColor"
                viewBox="0 0 24 24"
                style={{ pointerEvents: 'none' }}
              >
                <circle cx="9" cy="5" r="1.5" />
                <circle cx="15" cy="5" r="1.5" />
                <circle cx="9" cy="12" r="1.5" />
                <circle cx="15" cy="12" r="1.5" />
                <circle cx="9" cy="19" r="1.5" />
                <circle cx="15" cy="19" r="1.5" />
              </svg>
              <svg
                className={layout.searchIcon}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                style={{ pointerEvents: 'none' }}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              {/* 输入框包裹层 - 负责占位和拖拽，缩小 input 的实际点击区域 */}
              <div 
                className="flex-1 flex select-none" 
                style={{ 
                  userSelect: 'none', 
                  WebkitUserSelect: 'none',
                  height: '100%',
                  alignItems: 'center',
                  gap: '8px'
                }}
                onMouseDown={async (e) => {
                  // 如果点击的不是输入框，触发拖拽（这个逻辑是可靠的，从不失效）
                  const target = e.target as HTMLElement;
                  const isInput = target.tagName === 'INPUT' || target.closest('input');
                  const isImage = target.tagName === 'IMG' || target.closest('img');
                  if (!isInput && !isImage) {
                    // 阻止事件冒泡，避免 header 重复处理
                    e.stopPropagation();
                    e.preventDefault();
                    await startWindowDragging();
                  }
                  // 如果是输入框，不阻止冒泡，让输入框自己处理
                }}
              >
                {/* 粘贴图片预览 */}
                {pastedImageDataUrl && (
                  <img
                    src={pastedImageDataUrl}
                    alt="粘贴的图片"
                    className="w-8 h-8 object-cover rounded border border-gray-300 flex-shrink-0"
                    style={{ imageRendering: 'auto' }}
                    onError={(e) => {
                      // 如果图片加载失败，隐藏预览
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                    }}
                  />
                )}
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder="输入应用名称或粘贴文件路径..."
                  className={`w-full bg-transparent border-none outline-none p-0 text-lg ${layout.input.split(' ').filter(c => c.includes('placeholder') || c.includes('text-')).join(' ') || 'placeholder-gray-400 text-gray-700'}`}
                  style={{ 
                    cursor: 'text',
                    height: 'auto',
                    lineHeight: '1.5',
                    minHeight: '1.5em'
                  }}
                  autoFocus
                  onFocus={(e) => {
                    // Ensure input is focused, but don't select text if user is typing
                    e.target.focus();
                  }}
                  onMouseDown={(e) => {
                    // 阻止事件冒泡，防止触发窗口拖拽
                    // 输入框内应该只处理输入和文本选择，不应该触发窗口拖拽
                    e.stopPropagation();
                    // Close context menu when clicking on search input
                    if (contextMenu) {
                      setContextMenu(null);
                    }
                  }}
                  onClick={(e) => {
                    // 点击输入框时，确保焦点正确，阻止事件冒泡避免触发其他操作
                    e.stopPropagation();
                  }}
                />
              </div>
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
                  // 阻止拖拽，让按钮可以正常点击
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
              className="flex-1 min-h-0 results-list-scroll"
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
              className="flex-1 min-h-0 results-list-scroll py-2"
              style={{ maxHeight: '500px' }}
            >
              {(() => {
                return (
                  <>
                    {/* 可执行文件和插件横向排列在第一行 */}
                    {horizontalResults.length > 0 && (
                      <div className="px-4 py-3 mb-2 border-b border-gray-200">
                        <div 
                          ref={horizontalScrollContainerRef}
                          className="flex gap-3 pb-2 executable-scroll-container"
                        >
                          {horizontalResults.map((result, execIndex) => {
                            const isSelected = selectedHorizontalIndex === execIndex;
                            const isLaunching = result.type === "app" && launchingAppPath === result.path;
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
                                className={`flex flex-col items-center justify-center gap-1.5 p-2 rounded-xl cursor-pointer transition-all duration-200 relative ${
                                  isSelected 
                                    ? resultStyle === "soft"
                                      ? "bg-blue-50 border-2 border-blue-400 shadow-md shadow-blue-200/50 scale-[1.2]"
                                      : resultStyle === "skeuomorphic"
                                      ? "bg-gradient-to-br from-[#f0f5fb] to-[#e5edf9] border-2 border-[#a8c0e0] shadow-[0_4px_12px_rgba(20,32,50,0.12)] scale-[1.2]"
                                      : "bg-indigo-50 border-2 border-indigo-400 shadow-md shadow-indigo-200/50 scale-[1.2]"
                                    : "bg-white hover:bg-gray-50 border border-gray-200 hover:border-gray-300 hover:shadow-md"
                                } ${isLaunching ? 'rocket-launching' : ''}`}
                                style={{
                                  animation: isLaunching 
                                    ? `launchApp 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards` 
                                    : `fadeInUp 0.18s ease-out ${execIndex * 0.02}s both`,
                                  marginLeft: execIndex === 0 && isSelected ? '10px' : '0px', // 第一个item选中时添加左边距，防止放大后被裁剪
                                  width: '80px',
                                  height: '80px',
                                  minWidth: '80px',
                                  minHeight: '80px',
                                }}
                              >
                                {isSelected && (
                                  <div 
                                    className={`absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full ${
                                      resultStyle === "soft"
                                        ? "bg-blue-500"
                                        : resultStyle === "skeuomorphic"
                                        ? "bg-[#6b8fc4]"
                                        : "bg-indigo-500"
                                    }`}
                                  />
                                )}
                                <div className="flex-shrink-0 flex items-center justify-center" >
                                  <ResultIcon
                                    result={result}
                                    isSelected={isSelected}
                                    theme={theme}
                                    apps={apps}
                                    filteredApps={filteredApps}
                                    resultStyle={resultStyle}
                                    getPluginIcon={getPluginIcon}
                                    size="horizontal"
                                  />
                                </div>
                                <div 
                                  className={`text-xs text-center leading-tight ${
                                    isSelected 
                                      ? resultStyle === "soft"
                                        ? "text-blue-700 font-medium"
                                        : resultStyle === "skeuomorphic"
                                        ? "text-[#2a3f5f] font-medium"
                                        : "text-indigo-700 font-medium"
                                      : "text-gray-700"
                                  }`}
                                  style={{ 
                                    display: '-webkit-box',
                                    WebkitLineClamp: 2,
                                    WebkitBoxOrient: 'vertical',
                                    overflow: 'hidden',
                                    wordBreak: 'break-word',
                                    textOverflow: 'ellipsis',
                                    lineHeight: '1.3',
                                    maxHeight: '2.4em',
                                    minHeight: '2.4em',
                                    width: '65px',
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
                    {verticalResults.map((result, index) => {
                      const isSelected = selectedVerticalIndex === index;
                      // 计算垂直结果的序号（从1开始，只计算垂直结果）
                      const verticalIndex = index + 1;
                      const isLaunching = result.type === "app" && launchingAppPath === result.path;
                      return (
                <div
                  key={`${result.type}-${result.path}-${index}`}
                  data-item-key={`${result.type}-${result.path}-${index}`}
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
                  className={`${theme.card(isSelected)} ${isLaunching ? 'rocket-launching' : ''}`}
                  style={{
                    animation: isLaunching 
                      ? `launchApp 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards` 
                      : `fadeInUp 0.18s ease-out ${index * 0.02}s both`,
                  }}
                >
                  <div className={theme.indicator(isSelected)} />
                  <div className="flex items-center gap-3">
                    {/* 序号 - 使用垂直结果的序号（从1开始） */}
                    <div className={theme.indexBadge(isSelected)}>
                      {verticalIndex}
                    </div>
                    <div className={theme.iconWrap(isSelected)}>
                      <ResultIcon
                        result={result}
                        isSelected={isSelected}
                        theme={theme}
                        apps={apps}
                        filteredApps={filteredApps}
                        resultStyle={resultStyle}
                        getPluginIcon={getPluginIcon}
                        size="vertical"
                      />
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
                      {/* 粘贴图片的保存选项 */}
                      {result.type === "file" && result.path === pastedImagePath && (
                        <div 
                          className="flex items-center gap-2 mt-1.5"
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                          }}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                          }}
                        >
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              e.preventDefault();
                              await handleSaveImageToDownloads(result.path);
                            }}
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                            }}
                            className="text-xs px-3 py-1.5 rounded-md font-medium transition-all text-white hover:bg-blue-600"
                            style={{ backgroundColor: '#3b82f6' }}
                            title="保存到下载目录"
                          >
                            <div className="flex items-center gap-1.5">
                              <svg
                                className="w-3.5 h-3.5"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                                />
                              </svg>
                              <span>保存到下载目录</span>
                            </div>
                          </button>
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
                      {result.type === "email" && (
                        <div className="flex items-center gap-2 mt-1.5">
                          <span
                            className={`text-xs px-2.5 py-1 rounded-md font-medium transition-all ${theme.tag("email", isSelected)}`}
                            title="可打开的邮箱地址"
                          >
                            邮箱
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
      <ContextMenu
        menu={contextMenu}
        onClose={() => setContextMenu(null)}
        onRevealInFolder={handleRevealInFolder}
        onDebugAppIcon={async (appName: string) => {
          try {
            const result = await tauriApi.debugAppIcon(appName);
            console.log("=== 图标调试结果 ===");
            console.log("应用名称:", appName);
            console.log("调试信息:\n", result);
            alert(`应用: ${appName}\n\n${result}`);
            // 尝试重新加载应用列表以获取可能的图标更新
            await searchApplications(query);
          } catch (error: any) {
            console.error("调试失败:", error);
            alert(`调试失败: ${error?.message || error}`);
          }
        }}
        onDebugFileIcon={async (fileName: string, filePath: string) => {
          try {
            const result = await tauriApi.debugAppIcon(fileName);
            console.log("=== 图标调试结果（文件类型）===");
            console.log("文件名称:", fileName);
            console.log("文件路径:", filePath);
            console.log("调试信息:\n", result);
            alert(`文件: ${fileName}\n路径: ${filePath}\n\n${result}`);
            // 尝试重新搜索
            await searchApplications(query);
          } catch (error: any) {
            console.error("调试失败:", error);
            alert(`调试失败: ${error?.message || error}`);
          }
        }}
        onEditMemo={() => {
          if (!contextMenu?.result.memo) return;
          setSelectedMemo(contextMenu.result.memo);
          setMemoEditTitle(contextMenu.result.memo.title);
          setMemoEditContent(contextMenu.result.memo.content);
          setIsEditingMemo(true);
          setIsMemoModalOpen(true);
        }}
        onDeleteMemo={async (memoId: string) => {
          await tauriApi.deleteMemo(memoId);
        }}
        onOpenUrl={async (url: string) => {
          await tauriApi.openUrl(url);
        }}
        onCopyJson={async (json: string) => {
          await navigator.clipboard.writeText(json);
          alert("JSON 内容已复制到剪贴板");
        }}
        onCopyAiAnswer={async (answer: string) => {
          await navigator.clipboard.writeText(answer);
          alert("AI 回答已复制到剪贴板");
        }}
        query={query}
        selectedMemoId={selectedMemo?.id || null}
        onRefreshMemos={async () => {
          const list = await tauriApi.getAllMemos();
          setMemos(list);
        }}
        onCloseMemoModal={() => {
          setIsMemoModalOpen(false);
          setSelectedMemo(null);
        }}
        tauriApi={tauriApi}
      />

      {/* Memo Detail Modal */}
      <MemoModal
        isOpen={isMemoModalOpen}
        isListMode={isMemoListMode}
        memos={memos}
        selectedMemo={selectedMemo}
        isEditing={isEditingMemo}
        editTitle={memoEditTitle}
        editContent={memoEditContent}
        onClose={() => setIsMemoModalOpen(false)}
        onSetListMode={setIsMemoListMode}
        onSetSelectedMemo={setSelectedMemo}
        onSetEditing={setIsEditingMemo}
        onSetEditTitle={setMemoEditTitle}
        onSetEditContent={setMemoEditContent}
        onRefreshMemos={async () => {
          const list = await tauriApi.getAllMemos();
          setMemos(list);
        }}
        onHideLauncher={async () => {
          await hideLauncherAndResetState({ resetMemo: true });
        }}
        tauriApi={tauriApi}
      />


      {/* 应用中心弹窗 */}
      {isPluginListModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl flex flex-col m-4" style={{ maxHeight: '90vh', height: '80vh' }}>
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-200 flex-shrink-0">
              <h2 className="text-lg font-semibold text-gray-800">应用中心</h2>
              <button
                onClick={async () => {
                  closePluginModalAndHide(setIsPluginListModalOpen, hideLauncherAndResetState);
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
                    query,
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
                  closePluginModalAndHide(setIsPluginListModalOpen, hideLauncherAndResetState);
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* 错误提示弹窗 */}
      <ErrorDialog
        isOpen={!!errorMessage}
        type="error"
        title="启动失败"
        message={errorMessage || ""}
        onClose={() => {
          setErrorMessage(null);
        }}
      />

      {/* 成功提示弹窗 */}
      <ErrorDialog
        isOpen={!!successMessage}
        type="success"
        title="操作成功"
        message={successMessage || ""}
        onClose={() => {
          setSuccessMessage(null);
        }}
      />
    </div>
  );
}
