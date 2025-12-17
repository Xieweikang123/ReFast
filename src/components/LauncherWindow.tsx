import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { flushSync } from "react-dom";

// 格式化最近使用时间的相对时间显示
function formatLastUsedTime(timestamp: number): string {
  // 判断时间戳是秒级还是毫秒级（毫秒级时间戳 > 1e12）
  const ts = timestamp > 1e12 ? timestamp : timestamp * 1000;
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (seconds < 60) {
    return "刚刚";
  } else if (minutes < 60) {
    return `${minutes}分钟前`;
  } else if (hours < 24) {
    return `${hours}小时前`;
  } else if (days === 1) {
    return "昨天";
  } else if (days < 7) {
    return `${days}天前`;
  } else {
    // 超过7天显示具体日期
    const date = new Date(ts);
    const today = new Date();
    const isThisYear = date.getFullYear() === today.getFullYear();
    if (isThisYear) {
      return `${date.getMonth() + 1}月${date.getDate()}日`;
    } else {
      return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    }
  }
}
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { tauriApi } from "../api/tauri";
import { trackEvent } from "../api/events";
import type { AppInfo, FileHistoryItem, EverythingResult, MemoItem, PluginContext } from "../types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { plugins, searchPlugins, executePlugin } from "../plugins";
import { AppCenterContent } from "./AppCenterContent";
import { MemoModal } from "./MemoModal";
import { ContextMenu } from "./ContextMenu";

// Icon extraction failure marker (must match backend constant)
const ICON_EXTRACTION_FAILED_MARKER = "__ICON_EXTRACTION_FAILED__";

// Check if an icon value represents a failed extraction
const isIconExtractionFailed = (icon: string | null | undefined): boolean => {
  return icon === ICON_EXTRACTION_FAILED_MARKER;
};

// Check if an icon is valid (not empty and not failed)
const isValidIcon = (icon: string | null | undefined): boolean => {
  return icon !== null && icon !== undefined && icon.trim() !== '' && !isIconExtractionFailed(icon);
};
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
  type: "app" | "file" | "everything" | "url" | "email" | "memo" | "plugin" | "history" | "ai" | "json_formatter" | "settings";
  app?: AppInfo;
  file?: FileHistoryItem;
  everything?: EverythingResult;
  url?: string;
  email?: string;
  memo?: MemoItem;
  plugin?: { id: string; name: string; description?: string };
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
  const [systemFolders, setSystemFolders] = useState<Array<{ name: string; path: string; display_name: string; is_folder: boolean; icon?: string; name_pinyin?: string; name_pinyin_initials?: string }>>([]);
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
  const downloadButtonRef = useRef<HTMLButtonElement | null>(null);
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
  // 所有应用列表缓存（前端搜索使用）
  const allAppsCacheRef = useRef<AppInfo[]>([]);
  const allAppsCacheLoadedRef = useRef<boolean>(false);
  
  // 存储从文件历史记录中提取的图标（路径 -> 图标数据）
  const extractedFileIconsRef = useRef<Map<string, string>>(new Map());

  const getMainContainer = () => containerRef.current || getMainContainerUtil();

  useEffect(() => {
    isMemoModalOpenRef.current = isMemoModalOpen;
  }, [isMemoModalOpen]);

  // 组件卸载时清理 Everything 搜索会话
  // 注意：这个 useEffect 需要在 closeSessionSafe 定义之后，所以放在后面

  useEffect(() => {
    isPluginListModalOpenRef.current = isPluginListModalOpen;
  }, [isPluginListModalOpen]);

  useEffect(() => {
    closeOnBlurRef.current = closeOnBlur;
  }, [closeOnBlur]);

  // 注意：组件卸载时清理 Everything 搜索会话的 useEffect 在 closeSessionSafe 定义之后

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
  const resetMemoState = useCallback(() => {
    setIsMemoModalOpen(false);
    setIsMemoListMode(true);
    setSelectedMemo(null);
    setMemoEditTitle("");
    setMemoEditContent("");
    setIsEditingMemo(false);
  }, []);

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
  const hideLauncherAndResetState = useCallback(async (options?: { resetMemo?: boolean; resetAi?: boolean }) => {
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
  }, [resetMemoState]);

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

  // Check if Everything is available on mount and periodically if not available
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;
    
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
              // Path found
            }
            
            // Get Everything version
            try {
              const version = await tauriApi.getEverythingVersion();
              setEverythingVersion(version);
              if (version) {
                // Version retrieved
              }
            } catch (error) {
              console.error("Failed to get Everything version:", error);
            }
          } catch (error) {
            console.error("Failed to get Everything path:", error);
          }
          
          // 如果检测到已安装，清除定时器
          if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
            console.log("[Everything检测] 检测到 Everything 已安装，停止定时检测");
          }
          
          return true;
        } else {
          console.warn("Everything is not available:", status.error);
          setEverythingPath(null);
          setEverythingVersion(null);
          return false;
        }
      } catch (error) {
        console.error("Failed to check Everything availability:", error);
        setIsEverythingAvailable(false);
        setEverythingPath(null);
        setEverythingVersion(null);
        setEverythingError("检查失败");
        return false;
      }
    };
    
    // 立即检查一次
    checkEverything().then((isAvailable) => {
      // 如果 Everything 不可用，设置定时检测（每 5 秒检查一次）
      if (!isAvailable) {
        console.log("[Everything检测] Everything 未安装，开始定时检测（每 5 秒）");
        intervalId = setInterval(async () => {
          await checkEverything();
        }, 5000); // 每 5 秒检查一次
      }
    });
    
    // 组件卸载时清除定时器
    return () => {
      if (intervalId) {
        clearInterval(intervalId);
        console.log("[Everything检测] 组件卸载，清除定时检测");
      }
    };
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

  // 静默预加载应用列表（组件挂载时，不显示加载状态）
  useEffect(() => {
    let isMounted = true;
    const preloadApplications = async () => {
      try {
        // 静默加载，不设置 isLoading 状态
        const allApps = await tauriApi.scanApplications();
        if (isMounted) {
          const filteredApps = filterWindowsApps(allApps);
          setApps(filteredApps);
          // 不设置 filteredApps，等待用户输入查询时再设置
          // 注意：allAppsCacheRef 在函数组件内部定义，这里无法直接访问
          // 应用列表会在 performAppSearch 首次调用时自动加载到缓存
        }
      } catch (error) {
        console.error("Failed to preload applications:", error);
        // 预加载失败不影响用户体验，静默处理
      }
    };
    // 延迟一小段时间，避免阻塞初始渲染
    const timer = setTimeout(preloadApplications, 100);
    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, []);

  // 静默预加载文件历史（组件挂载时，不显示加载状态）
  useEffect(() => {
    let isMounted = true;
    const preloadFileHistory = async () => {
      try {
        // 静默加载所有文件历史到前端缓存
        const allFileHistory = await tauriApi.getAllFileHistory();
        if (isMounted) {
          allFileHistoryCacheRef.current = allFileHistory;
          allFileHistoryCacheLoadedRef.current = true;
        }
      } catch (error) {
        console.error("Failed to preload file history:", error);
        // 预加载失败不影响用户体验，静默处理
      }
    };
    // 延迟一小段时间，避免阻塞初始渲染
    const timer = setTimeout(preloadFileHistory, 200);
    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
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
        } catch (error) {
          console.error(`[PluginHotkeys] ❌ Failed to execute plugin ${pluginId}:`, error);
        }
      });
      
      // 监听插件快捷键更新事件
      unsubscribeUpdated = await listen<Record<string, { modifiers: string[]; key: string }>>(
        "plugin-hotkeys-updated",
        () => {
          // 插件快捷键更新事件处理（当前为空）
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
          
          const horizontalResults = [...executableResults, ...pluginResults];
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
      setEverythingResults([]);
      setEverythingTotalCount(null);
      setEverythingCurrentCount(0);
      setDirectPathResult(null);
    }
    
    if (trimmedQuery === "") {
      // 关闭当前 Everything 搜索会话
      const oldSessionId = pendingSessionIdRef.current;
      if (oldSessionId) {
        closeSessionSafe(oldSessionId);
      }
      pendingSessionIdRef.current = null;
      currentSearchQueryRef.current = "";
      displayedSearchQueryRef.current = "";
      lastSearchQueryRef.current = "";
      
      // React 会自动批处理 useEffect 中的状态更新，不需要 flushSync
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
                       filteredPlugins.length > 0 || everythingResults.length > 0;
    console.log("[搜索调试] useEffect去重检查:", {
      trimmedQuery,
      lastSearchQuery: lastSearchQueryRef.current,
      hasResults,
      filteredApps: filteredApps.length,
      filteredFiles: filteredFiles.length,
      filteredMemos: filteredMemos.length,
      filteredPlugins: filteredPlugins.length,
      everythingResults: everythingResults.length,
      willSkip: trimmedQuery === lastSearchQueryRef.current && hasResults
    });
    if (trimmedQuery === lastSearchQueryRef.current && hasResults) {
      console.log("[搜索调试] ✓ 去重检查通过，跳过搜索");
      return;
    }
    
    // Debounce search to avoid too many requests
    // 优化防抖时间：与 EverythingSearchWindow 保持一致，提升响应速度
    // Short queries (1-2 chars): 320ms (与 EverythingSearchWindow 一致)
    // Medium queries (3-5 chars): 300ms
    // Long queries (6+ chars): 200ms (仍然较快响应长查询)
    const queryLength = trimmedQuery.length;
    let debounceTime = 320; // default for short queries (与 EverythingSearchWindow 一致)
    if (queryLength >= 3 && queryLength <= 5) {
      debounceTime = 300; // medium queries
    } else if (queryLength >= 6) {
      debounceTime = 200; // long queries
    }
    console.log("[搜索调试] ✗ 去重检查失败，进入防抖，防抖时间:", debounceTime, "ms");
    
    const timeoutId = setTimeout(() => {
      
      // 再次检查查询是否仍然有效（可能在防抖期间已被清空或改变）
      const currentQuery = query.trim();
      if (currentQuery === "" || currentQuery !== trimmedQuery) {
        console.log("[搜索调试] ✗ 查询已改变或为空，取消搜索");
        return;
      }
      
      const isPathQuery = isLikelyAbsolutePath(trimmedQuery);
      
      // 检查是否已有相同查询的活跃会话（快速检查，避免重复搜索）
      const hasActiveSession = pendingSessionIdRef.current && currentSearchQueryRef.current === trimmedQuery;
      const hasResults = filteredApps.length > 0 || filteredFiles.length > 0 || filteredMemos.length > 0 || 
                         filteredPlugins.length > 0 || everythingResults.length > 0;
      
      // 如果已有相同查询的活跃会话且有结果，跳过重复搜索
      if (hasActiveSession && hasResults) {
        console.log("[搜索调试] ✓ 相同查询已有活跃会话且有结果，跳过重复搜索");
        return;
      }
      
      // 如果查询不同，关闭旧会话（不阻塞，异步执行）
      if (pendingSessionIdRef.current && currentSearchQueryRef.current !== trimmedQuery) {
        console.log("[搜索调试] ✗ 查询不同，关闭旧会话");
        const oldSessionId = pendingSessionIdRef.current;
        // 不阻塞等待，立即开始新搜索
        closeSessionSafe(oldSessionId).catch((err) => {
          console.warn("[搜索调试] 关闭旧会话失败:", err);
        });
        pendingSessionIdRef.current = null;
        currentSearchQueryRef.current = "";
        displayedSearchQueryRef.current = "";
      }
      
      // 如果会话存在但结果为空，说明结果被清空了，需要重新搜索
      if (hasActiveSession && !hasResults) {
        console.log("[搜索调试] ⚠ 会话存在但结果为空，重新搜索");
        // 重置会话状态，强制重新搜索
        const oldSessionId = pendingSessionIdRef.current;
        if (oldSessionId) {
          closeSessionSafe(oldSessionId).catch((err) => {
            console.warn("[搜索调试] 关闭空结果会话失败:", err);
          });
        }
        pendingSessionIdRef.current = null;
        currentSearchQueryRef.current = "";
        displayedSearchQueryRef.current = "";
      }
      
      // 标记当前查询为已搜索
      lastSearchQueryRef.current = trimmedQuery;
      console.log("[搜索调试] ✓ 开始执行搜索，更新lastSearchQueryRef为:", trimmedQuery);
      
      // 处理绝对路径查询
      if (isPathQuery) {
        handleDirectPathLookup(trimmedQuery);
        // 绝对路径查询不需要 Everything 结果
        setEverythingResults([]);
        setEverythingTotalCount(null);
        setEverythingCurrentCount(0);
        setIsSearchingEverything(false);
        // 关闭当前会话
        const oldSessionId = pendingSessionIdRef.current;
        if (oldSessionId) {
          closeSessionSafe(oldSessionId).catch((err) => {
            console.warn("[搜索调试] 关闭会话失败:", err);
          });
        }
        pendingSessionIdRef.current = null;
        currentSearchQueryRef.current = "";
        displayedSearchQueryRef.current = "";
      } else {
        setDirectPathResult(null);
        
        // Everything 搜索立即执行，不延迟
        if (isEverythingAvailable) {
          console.log("[搜索调试] 准备调用startSearchSession:", trimmedQuery);
          startSearchSession(trimmedQuery).catch((error) => {
            console.error("[搜索调试] startSearchSession错误:", error);
          });
        }
      }
      
      // ========== 性能优化：并行执行所有搜索 ==========
      // 系统文件夹和文件历史搜索立即执行
      Promise.all([
        searchSystemFolders(trimmedQuery),
        searchFileHistory(trimmedQuery),
      ]).catch((error) => {
        console.error("[搜索错误] 并行搜索失败:", error);
      });
      
      // 应用搜索延迟1秒执行，避免阻塞其他搜索
      // setTimeout(() => {
      //   searchApplications(trimmedQuery).catch((error) => {
      //     console.error("[搜索错误] 应用搜索失败:", error);
      //   });
      // }, 51000);
      
      console.log(`[搜索流程] 准备调用 searchApplications: query="${trimmedQuery}"`);
      searchApplications(trimmedQuery).catch((error) => {
        console.error("[搜索错误] searchApplications 调用失败:", error);
      });
      
      // 备忘录和插件搜索是纯前端过滤，立即执行（不会阻塞）
      searchMemos(trimmedQuery);
      handleSearchPlugins(trimmedQuery);
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

  const handleSearchPlugins = useCallback((q: string) => {
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
  }, [query]);


  // 处理绝对路径直达：存在则生成一个临时文件结果，减少 Everything/系统目录压力
  const handleDirectPathLookup = useCallback(async (rawPath: string) => {
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
  }, [query]);


  // Combine apps, files, Everything results, and URLs into results when they change
  // 使用 useMemo 优化，避免不必要的重新计算
  const combinedResults = useMemo(() => {
    // 如果查询为空且没有 AI 回答，直接返回空数组，不显示任何结果
    // 如果有 AI 回答，即使查询为空也要显示
    if (query.trim() === "" && !aiAnswer) {
      return [];
    }
    
    // 先对 everythingResults 进行去重（基于路径），防止重复触发 useMemo 重新计算
    const seenEverythingPaths = new Set<string>();
    const deduplicatedEverythingResults: EverythingResult[] = [];
    for (const everything of everythingResults) {
      const normalizedPath = everything.path.toLowerCase().replace(/\\/g, "/");
      if (!seenEverythingPaths.has(normalizedPath)) {
        seenEverythingPaths.add(normalizedPath);
        deduplicatedEverythingResults.push(everything);
      }
    }
    
    // 使用去重后的 everythingResults
    const uniqueEverythingResults = deduplicatedEverythingResults;
    
    // 预处理 Everything 结果：分离可执行文件和普通文件，并统计过滤情况
    const executableEverythingResults = uniqueEverythingResults
      .filter((everything) => {
        const pathLower = everything.path.toLowerCase();
        return pathLower.endsWith('.exe') || pathLower.endsWith('.lnk');
      });
    
    let recycleBinFilteredCount = 0;
    let duplicateFilteredCount = 0;

    // 规范化应用名称用于去重，忽略大小写与可执行/快捷方式后缀
    const normalizeAppName = (name: string): string =>
      name.toLowerCase().replace(/\.(exe|lnk)$/i, "").trim();
    // 已存在的应用名称集合（含 filteredApps）
    const normalizedAppNameSet = new Set<string>(
      filteredApps.map((app) => normalizeAppName(app.name))
    );
    
    const filteredExecutableEverything = executableEverythingResults
      .filter((everything) => {
        // 过滤掉回收站中的文件（$RECYCLE.BIN）
        const pathLower = everything.path.toLowerCase();
        if (pathLower.includes('$recycle.bin')) {
          recycleBinFilteredCount++;
          return false;
        }
        return true;
      })
      .filter((everything) => {
        // 检查是否已经在 filteredApps 或 filteredFiles 中，如果已存在则过滤掉
        const normalizedEverythingPath = everything.path.toLowerCase().replace(/\\/g, "/");
        const normalizedEverythingName = normalizeAppName(
          everything.name || normalizedEverythingPath.split("/").pop() || ""
        );
        const isInFilteredApps = filteredApps.some(app => {
          const normalizedAppPath = app.path.toLowerCase().replace(/\\/g, "/");
          return normalizedAppPath === normalizedEverythingPath;
        });
        const isInFilteredFiles = filteredFiles.some(file => {
          const normalizedFilePath = file.path.toLowerCase().replace(/\\/g, "/");
          return normalizedFilePath === normalizedEverythingPath;
        });
        // 额外通过名称去重，避免同名的 exe 与 lnk 同时出现
        const isDuplicateByName = normalizedAppNameSet.has(normalizedEverythingName);
        const shouldInclude = !isInFilteredApps && !isInFilteredFiles && !isDuplicateByName;
        if (!shouldInclude) {
          duplicateFilteredCount++;
        }
        if (shouldInclude) {
          normalizedAppNameSet.add(normalizedEverythingName);
        }
        return shouldInclude;
      })
      .map((everything): SearchResult => {
        return {
          type: "app" as const,
          app: {
            name: everything.name,
            path: everything.path,
            icon: undefined,
            description: undefined,
            name_pinyin: undefined,
            name_pinyin_initials: undefined,
          },
          displayName: everything.name,
          path: everything.path,
        };
      });
    
    
    const nonExecutableEverythingResults = uniqueEverythingResults
      .filter((everything) => {
        const pathLower = everything.path.toLowerCase();
        return !pathLower.endsWith('.exe') && !pathLower.endsWith('.lnk');
      });
    
    let recycleBinFilteredCount2 = 0;
    const filteredNonExecutableEverything = nonExecutableEverythingResults
      .filter((everything) => {
        // 过滤掉回收站中的文件（$RECYCLE.BIN）
        const pathLower = everything.path.toLowerCase();
        if (pathLower.includes('$recycle.bin')) {
          recycleBinFilteredCount2++;
          return false;
        }
        return true;
      })
      .map((everything) => ({
        type: "everything" as const,
        everything,
        displayName: everything.name,
        path: everything.path,
      }));
    
    
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
    
    // 创建文件历史记录的映射，用于关联应用的使用频率数据
    const fileHistoryMap = new Map<string, FileHistoryItem>();
    filteredFiles.forEach((file) => {
      const normalizedPath = file.path.toLowerCase().replace(/\\/g, "/");
      fileHistoryMap.set(normalizedPath, file);
    });
    
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
      // 系统文件夹结果，优先显示
      ...systemFolders.map((folder) => ({
        type: "file" as const,
        file: {
          path: folder.path,
          name: folder.name,
          last_used: 0,
          use_count: 0,
          is_folder: folder.is_folder,
        },
        displayName: folder.name,
        path: folder.path,
      })),
      // 如果查询匹配设置关键词，优先显示 Windows 设置应用（通过提高其优先级实现）
      ...filteredApps.map((app) => {
        // 尝试从文件历史记录中查找对应的使用频率数据
        const normalizedAppPath = app.path.toLowerCase().replace(/\\/g, "/");
        const fileHistory = fileHistoryMap.get(normalizedAppPath);
        
        // 如果应用没有图标，尝试从缓存中查找匹配的应用并获取图标
        // 优先从 apps 状态查找，如果没有则从 allAppsCacheRef 查找
        let appWithIcon = app;
        if (!isValidIcon(app.icon)) {
          // 先从 apps 状态查找
          let matchedApp = apps.find((a) => {
            const normalizedPath = a.path.toLowerCase().replace(/\\/g, "/");
            return normalizedPath === normalizedAppPath;
          });
          
          // 如果 apps 状态中没有找到，从 allAppsCacheRef 查找
          if (!matchedApp || !isValidIcon(matchedApp.icon)) {
            matchedApp = allAppsCacheRef.current.find((a) => {
              const normalizedPath = a.path.toLowerCase().replace(/\\/g, "/");
              return normalizedPath === normalizedAppPath;
            });
          }
          
          if (matchedApp && isValidIcon(matchedApp.icon)) {
            appWithIcon = { ...app, icon: matchedApp.icon! };
          }
        }
        
        return {
          type: "app" as const,
          app: appWithIcon,
          // 如果找到对应的文件历史记录，设置 file 字段以便排序时使用 use_count 和 last_used
          file: fileHistory,
          displayName: app.name,
          path: app.path,
        };
      }),
      // 从文件历史记录中分离可执行文件
      ...(filteredFiles
        .filter((file) => {
          const pathLower = file.path.toLowerCase();
          // 过滤掉 WindowsApps 路径
          if (pathLower.includes("windowsapps")) {
            return false;
          }
          return pathLower.endsWith('.exe') || pathLower.endsWith('.lnk');
        })
        .filter((file) => {
          // 检查是否已经在 filteredApps 中，如果已存在则过滤掉
          // 不仅要检查路径完全相同，还要检查 .lnk 文件是否指向已存在的 .exe 文件
          const normalizedFilePath = file.path.toLowerCase().replace(/\\/g, "/");
          const filePathLower = file.path.toLowerCase();
          
          // 首先检查是否有完全相同的路径
          const hasExactMatch = filteredApps.some(app => {
            const normalizedAppPath = app.path.toLowerCase().replace(/\\/g, "/");
            return normalizedAppPath === normalizedFilePath;
          });
          if (hasExactMatch) return false;
          
          // 如果是 .lnk 文件，检查是否有对应的 .exe 文件在 filteredApps 中
          if (filePathLower.endsWith('.lnk')) {
            // 提取 .lnk 文件的关键信息用于匹配
            // 策略：提取路径中的公司目录和产品名称，检查是否有 .exe 文件包含这些信息
            const lnkNormalized = normalizedFilePath;
            
            // 查找 "programs/" 之后的目录结构
            const programsIdx = lnkNormalized.indexOf("/programs/");
            if (programsIdx !== -1) {
              const afterPrograms = lnkNormalized.substring(programsIdx + "/programs/".length);
              const productPart = afterPrograms.replace(/\.lnk$/, "");
              
              // 提取公司目录和产品名称
              const slashIdx = productPart.indexOf('/');
              if (slashIdx !== -1) {
                const companyDir = productPart.substring(0, slashIdx);
                const productName = productPart.substring(slashIdx + 1);
                
                // 检查 filteredApps 中是否有 .exe 文件包含这些信息
                const hasMatchingExe = filteredApps.some(app => {
                  const appPathLower = app.path.toLowerCase().replace(/\\/g, "/");
                  if (!appPathLower.endsWith('.exe')) return false;
                  // 检查 .exe 路径是否同时包含公司目录和产品名称
                  return appPathLower.includes(companyDir) && appPathLower.includes(productName);
                });
                if (hasMatchingExe) return false;
              } else {
                // 单层目录结构，检查名称匹配
                const companyOrProduct = productPart;
                const lnkNameLower = file.name.toLowerCase().replace(/\.lnk$/, "");
                const hasMatchingExe = filteredApps.some(app => {
                  const appPathLower = app.path.toLowerCase().replace(/\\/g, "/");
                  if (!appPathLower.endsWith('.exe')) return false;
                  // 检查路径包含目录名，且路径包含 .lnk 名称的核心部分
                  return appPathLower.includes(companyOrProduct) && appPathLower.includes(lnkNameLower);
                });
                if (hasMatchingExe) return false;
              }
            }
          }
          
          return true;
        })
        // 在 filteredFiles 内部去重：对于 .lnk 文件，检查是否存在对应的 .exe 文件
        // 优先保留 .exe 文件，如果 .lnk 文件指向相同的应用，则过滤掉 .lnk
        .reduce((acc: typeof filteredFiles, file) => {
          const pathLower = file.path.toLowerCase();
          if (pathLower.endsWith('.exe')) {
            // 直接添加 .exe 文件
            acc.push(file);
          } else if (pathLower.endsWith('.lnk')) {
            // 对于 .lnk 文件，检查是否已有对应的 .exe 文件
            const lnkPathLower = file.path.toLowerCase();
            const lnkName = file.name.toLowerCase().replace(/\.lnk$/, '').trim();
            
            // 检查是否已有对应的 .exe 文件（通过名称和路径判断）
            const hasCorrespondingExe = acc.some(existingFile => {
              const existingPathLower = existingFile.path.toLowerCase();
              if (!existingPathLower.endsWith('.exe')) return false;
              
              // 提取 .exe 文件的基本名称（不含扩展名）
              const exeName = existingFile.name.toLowerCase().replace(/\.exe$/, '').trim();
              
              // 方法1：名称匹配 - 如果 .lnk 名称包含 .exe 名称，或者 .exe 名称包含 .lnk 名称的核心部分
              // 例如："Navicat Premium 17.lnk" 包含 "navicat"
              if (lnkName.includes(exeName) || exeName.includes(lnkName.split(' ')[0])) {
                return true;
              }
              
              // 方法2：路径匹配 - 检查路径中的目录结构是否匹配
              // 提取路径中的关键目录名（通常是软件公司名或产品名）
              // 例如：C:\Program Files\PremiumSoft\Navicat Premium 17\navicat.exe
              //      C:\ProgramData\Microsoft\Windows\Start Menu\Programs\PremiumSoft\Navicat Premium 17.lnk
              // 两个路径都包含 "PremiumSoft"，说明可能是同一应用
              
              // 从 .exe 路径中提取目录名（排除常见系统目录）
              // 尝试匹配 Program Files\公司名 或 Program Files\公司名\产品名 的模式
              const exeDirMatches = existingPathLower.match(/(?:program files|program files \(x86\))\\([^\\/]+)(?:\\[^\\/]+)?\\/i);
              if (exeDirMatches && exeDirMatches[1]) {
                const exeDirName = exeDirMatches[1].toLowerCase();
                // 检查 .lnk 路径中是否也包含这个目录名
                if (lnkPathLower.includes(exeDirName)) {
                  // 进一步检查：如果路径中都包含相同的目录名，且 .lnk 名称与 .exe 所在路径相关
                  // 例如：.exe 在 PremiumSoft\Navicat Premium 17 目录下，.lnk 名称是 "Navicat Premium 17"
                  const exePathContainsLnkName = existingPathLower.includes(lnkName);
                  const lnkNameContainsExeDir = lnkName.includes(exeDirName);
                  if (exePathContainsLnkName || lnkNameContainsExeDir || existingPathLower.includes(lnkName.split(' ')[0])) {
                    return true;
                  }
                }
              }
              
              // 方法3：反向检查 - 从 .lnk 路径中提取目录名（在 Start Menu 中，通常在 Programs 子目录下）
              // 例如：Programs\PremiumSoft\Navicat Premium 17.lnk
              const lnkDirMatches = lnkPathLower.match(/programs\\([^\\/]+)/i);
              if (lnkDirMatches && lnkDirMatches[1]) {
                const lnkDirName = lnkDirMatches[1].toLowerCase();
                // 检查 .exe 路径中是否也包含这个目录名
                // 如果包含，且名称也相关，则认为是同一应用
                if (existingPathLower.includes(lnkDirName)) {
                  // 进一步检查名称相关性
                  const exePathContainsLnkName = existingPathLower.includes(lnkName);
                  const lnkNameContainsExeName = lnkName.includes(exeName);
                  if (exePathContainsLnkName || lnkNameContainsExeName) {
                    return true;
                  }
                }
              }
              
              return false;
            });
            
            // 如果没有对应的 .exe 文件，添加该 .lnk 文件
            if (!hasCorrespondingExe) {
              acc.push(file);
            }
          } else {
            // 其他类型的文件，直接添加
            acc.push(file);
          }
          return acc;
        }, [])
        .filter((file) => {
          // 同名去重：避免 file history 与 Everything/应用列表名称重复
          const normalizedName = normalizeAppName(file.name);
          if (normalizedAppNameSet.has(normalizedName)) {
            duplicateFilteredCount++;
            return false;
          }
          normalizedAppNameSet.add(normalizedName);
          return true;
        })
        .map((file): SearchResult => {
          // 尝试从提取的图标缓存中获取图标
          const extractedIcon = extractedFileIconsRef.current.get(file.path);
          return {
            type: "app" as const,
            app: {
              name: file.name,
              path: file.path,
              icon: extractedIcon, // 优先使用提取的图标，如果没有则尝试从应用列表获取
              description: undefined,
              name_pinyin: undefined,
              name_pinyin_initials: undefined,
            },
            displayName: file.name,
            path: file.path,
          };
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
      // 从 Everything 结果中分离可执行文件（已在数组外预处理）
      ...filteredExecutableEverything,
      // 普通 Everything 结果（非可执行文件，已在数组外预处理）
      ...filteredNonExecutableEverything,
    ];
    
    // 对结果进行去重：如果同一个路径出现在多个结果源中，只保留一个
    // 优先保留历史文件结果（因为历史记录包含使用频率和最近使用时间，排序更准确）
    // 先收集历史文件结果的路径集合
    const historyFilePaths = new Set<string>();
    const normalizeNameForResult = (result: SearchResult): string => {
      const base =
        result.displayName ||
        result.path.split(/[\\/]/).pop() ||
        result.path;
      return normalizeAppName(base);
    };
    // 记录已保留的应用名，用于后续过滤同名的非应用结果（避免“同名文档”覆盖/混淆应用）
    const seenAppNames = new Set<string>();
    for (const result of otherResults) {
      if (result.type === "file") {
        const normalizedPath = result.path.toLowerCase().replace(/\\/g, "/");
        historyFilePaths.add(normalizedPath);
      }
    }
    
    // 过滤掉 Everything 结果中与历史文件结果重复的路径
    const deduplicatedResults: SearchResult[] = [];
    const addedHistoryPaths = new Set<string>(); // 用于跟踪已添加的历史文件路径，防止历史文件结果之间的重复
    const addedAppPaths = new Set<string>(); // 用于跟踪已添加的应用路径，防止应用结果之间的重复
    let everythingFilteredByHistoryCount = 0; // 统计因与历史文件重复而被过滤的 Everything 结果数
    let appFilteredByHistoryCount = 0; // 统计因与历史文件重复而被过滤的 app 结果数
    
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
          // 如果已存在同名应用，跳过非应用结果，避免同名文档/文件干扰
          const normalizedName = normalizeNameForResult(result);
          if (seenAppNames.has(normalizedName)) {
            continue;
          }
          deduplicatedResults.push(result);
        }
        // 如果路径已添加过，跳过（保留第一次出现的，通常使用频率更高）
        continue;
      }
      
      // 对于 Everything 类型，检查是否已在历史文件结果中
      if (result.type === "everything") {
        const normalizedPath = result.path.toLowerCase().replace(/\\/g, "/");
        const normalizedName = normalizeNameForResult(result);
        // 如果已有同名应用，跳过 Everything 非应用结果，避免“打开文件夹”指向文档
        if (seenAppNames.has(normalizedName)) {
          everythingFilteredByHistoryCount++; // 复用统计
          continue;
        }
        if (!historyFilePaths.has(normalizedPath)) {
          deduplicatedResults.push(result);
        } else {
          everythingFilteredByHistoryCount++;
        }
        // 如果路径已在历史文件结果中，跳过（不添加 Everything 结果）
        continue;
      }
      
      // 对于 app 类型，检查路径是否重复（包括与其他 app 类型结果的重复）
      if (result.type === "app") {
        const normalizedPath = result.path.toLowerCase().replace(/\\/g, "/");
        const isInHistoryFilePaths = historyFilePaths.has(normalizedPath);
        const isInAddedAppPaths = addedAppPaths.has(normalizedPath);
        const normalizedName = normalizeNameForResult(result);
        // 检查是否已在历史文件结果中，或者是否已经添加过（防止重复）
        // 注意：如果同一个路径在 otherResults 中出现多次（比如来自 filteredFiles 和 Everything），只保留第一个
        if (!isInHistoryFilePaths && !isInAddedAppPaths) {
          addedAppPaths.add(normalizedPath);
          seenAppNames.add(normalizedName);
          deduplicatedResults.push(result);
        } else {
          if (isInHistoryFilePaths) {
            appFilteredByHistoryCount++;
          }
        }
        continue;
      }
      
      // 对于其他类型，检查路径是否重复
      const normalizedPath = result.path.toLowerCase().replace(/\\/g, "/");
      if (!historyFilePaths.has(normalizedPath)) {
        deduplicatedResults.push(result);
      }
    }
    
    // 使用去重后的结果
    otherResults = deduplicatedResults;
    
    // 统计最终结果列表中的应用数量（包括来自 filteredApps 和 filteredFiles 的应用）
    let finalAppResults = otherResults.filter(r => r.type === "app");
    
    // 对最终应用结果按名称去重：如果多个应用名称相同，优先保留 .exe 文件
    const seenFinalAppNames = new Set<string>();
    const deduplicatedAppResults = finalAppResults.reduce((acc: typeof finalAppResults, app) => {
      const normalizedName = normalizeAppName(app.displayName || app.path.split(/[\\/]/).pop() || "");
      const pathLower = app.path.toLowerCase();
      const isExe = pathLower.endsWith('.exe');
      
      if (!seenFinalAppNames.has(normalizedName)) {
        // 第一次遇到这个名称，直接添加
        seenFinalAppNames.add(normalizedName);
        acc.push(app);
      } else {
        // 已经存在同名应用，检查是否应该替换
        const existingIndex = acc.findIndex(existing => {
          const existingNormalizedName = normalizeAppName(existing.displayName || existing.path.split(/[\\/]/).pop() || "");
          return existingNormalizedName === normalizedName;
        });
        
        if (existingIndex !== -1) {
          const existing = acc[existingIndex];
          const existingPathLower = existing.path.toLowerCase();
          const existingIsLnk = existingPathLower.endsWith('.lnk');
          
          // 如果当前是 .exe 而已存在的是 .lnk，替换它
          if (isExe && existingIsLnk) {
            acc[existingIndex] = app;
          }
          // 如果当前是 .lnk 而已存在的是 .exe，跳过（不替换）
          // 其他情况保持原样（不添加）
        }
      }
      
      return acc;
    }, []);
    
    // 将去重后的应用结果更新回 otherResults
    // 移除原来的应用结果，然后添加去重后的应用结果
    otherResults = [
      ...otherResults.filter(r => r.type !== "app"),
      ...deduplicatedAppResults
    ];
    
    finalAppResults = deduplicatedAppResults;
    
    const appsFromFilteredFiles = filteredFiles.filter(f => {
      const pathLower = f.path.toLowerCase();
      return (pathLower.endsWith('.exe') || pathLower.endsWith('.lnk')) && 
             !pathLower.includes("windowsapps");
    });
    console.log("[启动器搜索] 最终结果列表中的应用统计:", {
      搜索词: query,
      来自filteredApps: filteredApps.length,
      filteredApps详情: filteredApps.map(app => ({ name: app.name, path: app.path, hasIcon: !!app.icon })),
      来自filteredFiles的可执行文件: appsFromFilteredFiles.length,
      filteredFiles详情: appsFromFilteredFiles.map(f => ({ name: f.name, path: f.path })),
      最终应用结果总数: finalAppResults.length,
      最终应用结果: finalAppResults.map(r => ({ 
        name: r.displayName, 
        path: r.path, 
        type: r.type,
        source: r.type === "app" && filteredApps.some(app => app.path === r.path) ? "filteredApps" : 
                r.type === "app" && appsFromFilteredFiles.some(f => f.path === r.path) ? "filteredFiles" : 
                "other"
      }))
    });
    
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
        
        // 调试：输出排序比较过程
        if (query.trim() && a.type === "app" && b.type === "app") {
          console.log(`[排序比较] "${a.displayName}" (${aScore}) vs "${b.displayName}" (${bScore}) => ${bScore - aScore > 0 ? a.displayName : b.displayName} 在前`);
        }

        // Everything 内部快捷方式 (.lnk) 优先
        if (a.type === "everything" && b.type === "everything") {
          const aLnk = isLnkPath(a.path);
          const bLnk = isLnkPath(b.path);
          if (aLnk !== bLnk) return aLnk ? -1 : 1;
        }

        // 历史文件始终优先于 Everything（即使分数更低）
        if (a.type === "file" && b.type === "everything") return -1;
        if (a.type === "everything" && b.type === "file") return 1;

        // 第一优先级：最近使用时间（最近打开的始终排在前面）
        if (aLastUsed !== undefined && aLastUsed > 0 && bLastUsed !== undefined && bLastUsed > 0) {
          // 两个都有使用时间，按时间降序排序（最近的在前面）
          if (aLastUsed !== bLastUsed) {
            return bLastUsed - aLastUsed;
          }
        } else if (aLastUsed !== undefined && aLastUsed > 0) {
          // 只有 a 有使用时间，a 排在前面
          return -1;
        } else if (bLastUsed !== undefined && bLastUsed > 0) {
          // 只有 b 有使用时间，b 排在前面
          return 1;
        }

        // 第二优先级：按评分降序排序（分数高的在前）
        if (bScore !== aScore) {
          return bScore - aScore;
        }

        // 第三优先级：类型优先级（应用 > 历史文件 > Everything > 其他）
        if (a.type === "app" && b.type !== "app") return -1;
        if (a.type !== "app" && b.type === "app") return 1;
        if (a.type === "file" && b.type === "everything") return -1; // 历史文件优先于 Everything
        if (a.type === "everything" && b.type === "file") return 1; // 历史文件优先于 Everything
        
        // 第四优先级：使用频率（使用次数多的在前）
        if (aUseCount !== undefined && bUseCount !== undefined && aUseCount !== bUseCount) {
          return bUseCount - aUseCount;
        }
        
        // 最后：按名称排序（保持稳定排序）
        return a.displayName.localeCompare(b.displayName);
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

        // 第一优先级：最近使用时间（最近打开的始终排在前面）
        if (aLastUsed !== undefined && aLastUsed > 0 && bLastUsed !== undefined && bLastUsed > 0) {
          // 两个都有使用时间，按时间降序排序（最近的在前面）
          if (aLastUsed !== bLastUsed) {
            return bLastUsed - aLastUsed;
          }
        } else if (aLastUsed !== undefined && aLastUsed > 0) {
          // 只有 a 有使用时间，a 排在前面
          return -1;
        } else if (bLastUsed !== undefined && bLastUsed > 0) {
          // 只有 b 有使用时间，b 排在前面
          return 1;
        }

        // 第二优先级：按评分降序排序（分数高的在前）
        if (bScore !== aScore) {
          // 如果查询匹配设置关键词，Windows 设置应用优先（即使分数稍低）
          if (shouldShowSettings) {
            const scoreDiff = Math.abs(bScore - aScore);
            if (scoreDiff <= 500) { // 允许更大的分数差距
              if (aIsSettingsApp && !bIsSettingsApp && !bIsSpecial && !bIsPlugin) return -1;
              if (!aIsSettingsApp && bIsSettingsApp && !aIsSpecial && !aIsPlugin) return 1;
            }
          }
          return bScore - aScore;
        }

        // 第三优先级：类型优先级（Windows 设置应用 > 应用 > 历史文件 > Everything > 其他）
        if (shouldShowSettings) {
          if (aIsSettingsApp && !bIsSettingsApp && !bIsSpecial && !bIsPlugin) return -1;
          if (!aIsSettingsApp && bIsSettingsApp && !aIsSpecial && !aIsPlugin) return 1;
        }
        if (a.type === "app" && b.type !== "app") return -1;
        if (a.type !== "app" && b.type === "app") return 1;
        if (a.type === "file" && b.type === "everything") return -1; // 历史文件优先于 Everything
        if (a.type === "everything" && b.type === "file") return 1; // 历史文件优先于 Everything
        
        // 第四优先级：使用频率（使用次数多的在前）
        if (aUseCount !== undefined && bUseCount !== undefined && aUseCount !== bUseCount) {
          return bUseCount - aUseCount;
        }
        
        // 最后：按名称排序（保持稳定排序）
        return a.displayName.localeCompare(b.displayName);
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
    const finalResults = jsonContainsLinks && jsonFormatterResult.length > 0
      ? [...pluginResults, ...jsonFormatterResult, ...urlResults, ...emailResults, ...otherResultsWithoutPlugins]
      : [...pluginResults, ...urlResults, ...emailResults, ...jsonFormatterResult, ...otherResultsWithoutPlugins];
    
    return finalResults;
  }, [filteredApps, filteredFiles, filteredMemos, filteredPlugins, everythingResults, detectedUrls, detectedEmails, detectedJson, openHistory, query, aiAnswer]);

  // 使用 ref 来跟踪当前的 query，避免闭包问题
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  // Helper function to split results into horizontal and vertical
  const splitResults = (allResults: SearchResult[], openHistoryData: Record<string, number> = {}, searchQuery: string = "") => {
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
    
    // 系统文件夹（如回收站、设置等）也应该显示在横向列表中
    const systemFolderResults = allResults.filter(result => {
      if (result.type === "file" && result.file) {
        const pathLower = result.path.toLowerCase();
        // 识别系统文件夹：回收站、设置等特殊路径
        // 设置路径是 "ms-settings:"
        // 回收站路径是 "::{645FF040-5081-101B-9F08-00AA002F954E}"（不区分大小写）
        return pathLower === "ms-settings:" ||
               pathLower.startsWith("::{") || // CLSID 路径（如回收站）
               (result.file.is_folder === true && result.file.path.toLowerCase().startsWith("::{"));
      }
      return false;
    });
    
    const pluginResults = allResults.filter(result => result.type === "plugin");
    const horizontalUnsorted = [...deduplicatedExecutableResults, ...systemFolderResults, ...pluginResults];
    
    // 对横向列表按相关性评分、使用频率和最近使用时间排序
    // 对横向列表按相关性评分、使用频率和最近使用时间排序
    const horizontal = horizontalUnsorted.sort((a, b) => {
      // 插件始终在最前面
      if (a.type === "plugin" && b.type !== "plugin") return -1;
      if (a.type !== "plugin" && b.type === "plugin") return 1;
      if (a.type === "plugin" && b.type === "plugin") return 0;
      
      // 获取使用频率和最近使用时间
      const aUseCount = a.app?.name ? undefined : (a.file?.use_count);
      const aLastUsed = a.app?.name ? undefined : (a.file?.last_used || openHistoryData[a.path] || 0);
      const bUseCount = b.app?.name ? undefined : (b.file?.use_count);
      const bLastUsed = b.app?.name ? undefined : (b.file?.last_used || openHistoryData[b.path] || 0);
      
      // 如果有查询，优先按相关性评分排序（评分高的在前）
      if (searchQuery.trim()) {
        const aScore = calculateRelevanceScore(
          a.displayName,
          a.path,
          searchQuery,
          aUseCount,
          aLastUsed,
          a.type === "everything",
          a.type === "app",
          a.app?.name_pinyin,
          a.app?.name_pinyin_initials,
          a.type === "file"
        );
        const bScore = calculateRelevanceScore(
          b.displayName,
          b.path,
          searchQuery,
          bUseCount,
          bLastUsed,
          b.type === "everything",
          b.type === "app",
          b.app?.name_pinyin,
          b.app?.name_pinyin_initials,
          b.type === "file"
        );
        
        // 第一优先级：最近使用时间（最近打开的始终排在前面）
        if (aLastUsed !== undefined && aLastUsed > 0 && bLastUsed !== undefined && bLastUsed > 0) {
          // 两个都有使用时间，按时间降序排序（最近的在前面）
          if (aLastUsed !== bLastUsed) {
            return bLastUsed - aLastUsed;
          }
        } else if (aLastUsed !== undefined && aLastUsed > 0) {
          // 只有 a 有使用时间，a 排在前面
          return -1;
        } else if (bLastUsed !== undefined && bLastUsed > 0) {
          // 只有 b 有使用时间，b 排在前面
          return 1;
        }
        
        // 第二优先级：按评分降序排序（分数高的在前）
        if (bScore !== aScore) {
          return bScore - aScore;
        }
      } else {
        // 没有查询时，直接按最近使用时间排序
        // 第一优先级：最近使用时间（最近打开的始终排在前面）
        if (aLastUsed !== undefined && aLastUsed > 0 && bLastUsed !== undefined && bLastUsed > 0) {
          // 两个都有使用时间，按时间降序排序（最近的在前面）
          if (aLastUsed !== bLastUsed) {
            return bLastUsed - aLastUsed;
          }
        } else if (aLastUsed !== undefined && aLastUsed > 0) {
          // 只有 a 有使用时间，a 排在前面
          return -1;
        } else if (bLastUsed !== undefined && bLastUsed > 0) {
          // 只有 b 有使用时间，b 排在前面
          return 1;
        }
      }
      
      // 再次按使用频率排序（使用次数多的在前）
      if (aUseCount !== undefined && bUseCount !== undefined) {
        if (aUseCount !== bUseCount) {
          return bUseCount - aUseCount; // 降序：使用次数多的在前
        }
      } else if (aUseCount !== undefined && bUseCount === undefined) {
        return -1; // a 有使用次数，b 没有，a 在前
      } else if (aUseCount === undefined && bUseCount !== undefined) {
        return 1; // b 有使用次数，a 没有，b 在前
      }
      
      // 最后按名称排序（保持稳定排序）
      return (a.displayName || "").localeCompare(b.displayName || "");
    });
    
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
      // 排除系统文件夹（它们应该在横向列表中）
      if (result.type === "file" && result.file) {
        const pathLower = result.path.toLowerCase();
        const isSystemFolder = pathLower === "control" || 
                              pathLower === "ms-settings:" ||
                              pathLower.startsWith("::{") ||
                              (result.file.is_folder === true && result.file.path.toLowerCase().startsWith("::{"));
        return !isSystemFolder;
      }
      return result.type !== "plugin";
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
      });
      return;
    }

    // 保存当前要加载的结果引用，用于后续验证
    currentLoadResultsRef.current = allResults;

    // Split results into horizontal and vertical
    const { horizontal, vertical } = splitResults(allResults, openHistory, query);

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
      const { horizontal: initialHorizontal, vertical: initialVertical } = splitResults(initialResults, openHistory, query);
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
          const { horizontal: currentHorizontal, vertical: currentVertical } = splitResults(currentResults, openHistory, query);
          setResults(currentResults);
          // 同步更新横向和纵向结果
          setHorizontalResults(currentHorizontal);
          setVerticalResults(currentVertical);
          // 更新ref以跟踪当前的横向结果
          horizontalResultsRef.current = currentHorizontal;
          // 打印横向结果列表（增量加载中）
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
    
    
    const horizontalResults = [...executableResults, ...pluginResults];
    
    
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
              const filteredApps = filterWindowsApps(apps);
              setApps(filteredApps);
              setFilteredApps(filteredApps.slice(0, 10));
              setIsLoading(false);
              // 应用列表更新，更新前端搜索缓存（通过 clearAppSearchCache 触发重新加载）
              clearAppSearchCache();
              
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
        // 正常扫描：直接返回结果（移除不必要的延迟包装）
        try {
          const allApps = await tauriApi.scanApplications();
          const filteredApps = filterWindowsApps(allApps);
          setApps(filteredApps);
          setFilteredApps(filteredApps.slice(0, 10));
          // 应用列表更新，更新前端搜索缓存
          allAppsCacheRef.current = filteredApps;
          allAppsCacheLoadedRef.current = true;
        } catch (error) {
          console.error("Failed to load applications:", error);
          setApps([]);
          setFilteredApps([]);
        } finally {
          setIsLoading(false);
        }
      }
    } catch (error) {
      console.error("Failed to load applications:", error);
      setApps([]);
      setFilteredApps([]);
      setIsLoading(false);
    }
  };

  // ========== 性能调试配置：用于定位性能瓶颈 ==========
  // 修改这些值来屏蔽/启用各个功能，定位性能问题
  const APP_SEARCH_DEBUG_CONFIG = {
    // 是否启用查询验证
    enableQueryValidation: true,
    // 是否启用应用列表加载检查
    enableEnsureAppsLoaded: false,  // 已屏蔽：测试其他步骤性能
    // 是否执行实际搜索（调用后端 API）
    enablePerformSearch: true,       // ❌ 已屏蔽：应用搜索功能已禁用
    // 是否更新搜索结果
    enableUpdateResults: true,
    // 是否清空旧结果
    enableClearResults: true,
    // 是否输出性能日志
    enablePerformanceLog: true,
  };
  // ========== 调试配置结束 ==========

  // 验证搜索查询是否有效
  const validateSearchQuery = (searchQuery: string): boolean => {
    return !!(searchQuery && searchQuery.trim() !== "");
  };

  // 确保应用列表已加载
  const ensureAppsLoaded = async (): Promise<void> => {
    if (apps.length === 0 && !isLoading) {
      await loadApplications();
    }
  };

  // 过滤掉 WindowsApps 路径的应用（前端双重保险）
  const filterWindowsApps = useCallback((apps: AppInfo[]): AppInfo[] => {
    return apps.filter((app) => {
      const pathLower = app.path.toLowerCase();
      return !pathLower.includes("windowsapps");
    });
  }, []);

  // 所有文件历史缓存（前端搜索使用）
  const allFileHistoryCacheRef = useRef<FileHistoryItem[]>([]);
  const allFileHistoryCacheLoadedRef = useRef<boolean>(false);

  // 检查是否包含中文字符（简化版，用于判断是否为拼音查询）
  const containsChinese = (str: string): boolean => {
    return /[\u4e00-\u9fa5]/.test(str);
  };

  // 前端搜索应用（基于缓存的应用列表）
  const searchAppsFrontend = (query: string, apps: AppInfo[]): AppInfo[] => {
    if (!query || query.trim() === "") {
      const defaultResults = apps.slice(0, 10);
      console.log("[启动器搜索] 应用结果列表 - 无搜索条件，返回前10个应用，数量:", defaultResults.length);
      console.log("[启动器搜索] 返回的应用:", defaultResults);
      return defaultResults;
    }

    const queryLower = query.trim().toLowerCase();
    const queryIsPinyin = !containsChinese(queryLower);
    
    const MAX_PERFECT_MATCHES = 3;
    const MAX_RESULTS = 20;

    // 使用索引和分数，避免频繁克隆
    const results: Array<{ index: number; score: number }> = [];
    let perfectMatches = 0;

    for (let idx = 0; idx < apps.length; idx++) {
      const app = apps[idx];
      let score = 0;

      // 名称匹配（最高优先级）
      const nameLower = app.name.toLowerCase();
      
        // 优化：使用更高效的匹配顺序，减少不必要的字符串操作
        if (nameLower === queryLower) {
          score += 1000;
          perfectMatches++;
          // 短查询（如 "qq"）立即返回第一个完全匹配
          if (queryLower.length <= 3 && perfectMatches >= 1) {
            results.push({ index: idx, score });
            break;
          }
          // 找到足够完全匹配时提前退出
          if (perfectMatches >= MAX_PERFECT_MATCHES) {
            results.push({ index: idx, score });
            break;
          }
        } else {
          // 优化：只在非完全匹配时才执行其他检查
          // 先检查 startsWith（更常见的情况），再检查 includes（更耗时）
          if (nameLower.startsWith(queryLower)) {
            score += 500;
          } else if (nameLower.includes(queryLower)) {
            score += 100;
          }
        }

      // 拼音匹配（如果查询是拼音，且名称未完全匹配）
      // 优化：只在名称匹配分数较低时才检查拼音，避免不必要的字符串操作
      if (score < 500 && queryIsPinyin && app.name_pinyin && app.name_pinyin_initials) {
        // 完整拼音匹配
        if (app.name_pinyin === queryLower) {
          score += 800;
          perfectMatches++;
          if (perfectMatches >= MAX_PERFECT_MATCHES) {
            results.push({ index: idx, score });
            break;
          }
        } else if (app.name_pinyin.startsWith(queryLower)) {
          score += 400;
        } else if (app.name_pinyin.includes(queryLower)) {
          score += 150;
        }

        // 拼音首字母匹配（只在拼音未完全匹配时检查）
        if (score < 800) {
          if (app.name_pinyin_initials === queryLower) {
            score += 600;
          } else if (app.name_pinyin_initials.startsWith(queryLower)) {
            score += 300;
          } else if (app.name_pinyin_initials.includes(queryLower)) {
            score += 120;
          }
        }
      }

      // 路径匹配（仅在名称未匹配时检查，节省时间）
      if (score === 0) {
        const pathLower = app.path.toLowerCase();
        if (pathLower.includes(queryLower)) {
          score += 10;
        }
      }

      if (score > 0) {
        results.push({ index: idx, score });
      }
    }

    // 如果有完全匹配且提前退出，直接返回
    if (perfectMatches >= MAX_PERFECT_MATCHES && results.length <= MAX_PERFECT_MATCHES) {
      const finalResults = results.map((r) => apps[r.index]);
      console.log("[启动器搜索] 应用结果列表 - 搜索词:", query, "原始数量:", apps.length, "筛选后数量:", finalResults.length);
      console.log("[启动器搜索] 筛选后的应用:", finalResults);
      return finalResults;
    }

    // 按分数排序
    results.sort((a, b) => b.score - a.score);
    
    // 限制结果数量并返回
    const finalResults = results.slice(0, MAX_RESULTS).map((r) => apps[r.index]);
    console.log("[启动器搜索] 应用结果列表 - 搜索词:", query, "原始数量:", apps.length, "筛选后数量:", finalResults.length);
    console.log("[启动器搜索] 筛选后的应用:", finalResults);
    return finalResults;
  };

  // 执行应用搜索（前端搜索，使用缓存的应用列表）
  const performAppSearch = async (searchQuery: string): Promise<AppInfo[]> => {
    console.log(`[performAppSearch] 开始搜索: query="${searchQuery}"`);
    console.log(`[performAppSearch] 缓存状态: loaded=${allAppsCacheLoadedRef.current}, cachedAppsCount=${allAppsCacheRef.current.length}`);
    
    // 如果缓存未加载，先加载所有应用
    if (!allAppsCacheLoadedRef.current || allAppsCacheRef.current.length === 0) {
      console.log(`[performAppSearch] 缓存未加载或为空，开始加载应用列表...`);
      try {
        const allApps = await tauriApi.scanApplications();
        console.log(`[performAppSearch] scanApplications 返回: ${allApps.length} 个应用`);
        const filteredApps = filterWindowsApps(allApps);
        console.log(`[performAppSearch] filterWindowsApps 后: ${filteredApps.length} 个应用`);
        allAppsCacheRef.current = filteredApps;
        allAppsCacheLoadedRef.current = true;
      } catch (error) {
        console.error(`[performAppSearch] 加载应用列表失败:`, error);
        return [];
      }
    }

    console.log(`[performAppSearch] 使用缓存的应用列表进行搜索: ${allAppsCacheRef.current.length} 个应用`);
    // 使用前端搜索
    const results = searchAppsFrontend(searchQuery, allAppsCacheRef.current);
    console.log(`[performAppSearch] 搜索完成: 返回 ${results.length} 个结果`);
    if (results.length > 0) {
      console.log(`[performAppSearch] 前3个结果:`, results.slice(0, 3).map(app => ({ name: app.name, path: app.path, hasIcon: !!app.icon })));
    }
    return results;
  };
  
  // 清空应用列表缓存（当应用列表更新时调用）
  const clearAppSearchCache = useCallback(() => {
    allAppsCacheRef.current = [];
    allAppsCacheLoadedRef.current = false;
  }, []);

  // 更新搜索结果（带查询验证）
  const updateAppSearchResults = (results: AppInfo[], searchQuery: string): void => {
    const currentQueryTrimmed = query.trim();
    const searchQueryTrimmed = searchQuery.trim();
    const shouldUpdate = currentQueryTrimmed === searchQueryTrimmed;
    
    // 使用普通状态更新，React 18 会自动优化渲染性能
    // 移除 flushSync，因为它会在某些情况下导致同步渲染阻塞主线程
    if (shouldUpdate) {
      console.log("[启动器搜索] 更新应用结果列表 - 搜索词:", searchQuery, "结果数量:", results.length);
      setFilteredApps(results);
    } else {
      // 查询在搜索过程中已改变，忽略结果
      console.log("[启动器搜索] 查询已改变，忽略结果 - 当前查询:", currentQueryTrimmed, "搜索查询:", searchQueryTrimmed);
      setFilteredApps([]);
    }
  };

  // 清空应用搜索结果
  const clearAppSearchResults = (): void => {
    setFilteredApps([]);
  };

  // 系统文件夹列表（缓存，避免每次搜索都调用后端）
  const systemFoldersListRef = useRef<Array<{ name: string; path: string; display_name: string; is_folder: boolean; icon?: string; name_pinyin?: string; name_pinyin_initials?: string }>>([]);
  const systemFoldersListLoadedRef = useRef(false);

  // 初始化系统文件夹列表（只加载一次）
  useEffect(() => {
    if (!systemFoldersListLoadedRef.current) {
      tauriApi.searchSystemFolders("").then((folders) => {
        systemFoldersListRef.current = folders;
        systemFoldersListLoadedRef.current = true;
      }).catch((error) => {
        console.error("Failed to load system folders:", error);
      });
    }
  }, []);

  // 搜索系统文件夹（前端搜索，避免每次调用后端）
  const searchSystemFolders = async (searchQuery: string) => {
    try {
      if (!searchQuery || searchQuery.trim() === "") {
        setSystemFolders([]);
        return;
      }
      
      // 如果列表未加载，先加载
      if (!systemFoldersListLoadedRef.current) {
        const folders = await tauriApi.searchSystemFolders("");
        systemFoldersListRef.current = folders;
        systemFoldersListLoadedRef.current = true;
      }
      
      // 前端搜索（支持拼音匹配）
      const queryLower = searchQuery.trim().toLowerCase();
      const queryIsPinyin = !containsChinese(queryLower);
      
      const results = systemFoldersListRef.current.filter((folder) => {
        const nameLower = folder.name.toLowerCase();
        const displayLower = folder.display_name.toLowerCase();
        const pathLower = folder.path.toLowerCase();
        
        // 直接文本匹配
        if (nameLower.includes(queryLower) || 
            displayLower.includes(queryLower) || 
            pathLower.includes(queryLower)) {
          return true;
        }
        
        // 拼音匹配（如果查询是拼音，且文件夹有拼音字段）
        if (queryIsPinyin && (folder.name_pinyin || folder.name_pinyin_initials)) {
          // 拼音全拼匹配
          if (folder.name_pinyin) {
            if (folder.name_pinyin === queryLower ||
                folder.name_pinyin.startsWith(queryLower) ||
                folder.name_pinyin.includes(queryLower)) {
              return true;
            }
          }
          
          // 拼音首字母匹配
          if (folder.name_pinyin_initials) {
            if (folder.name_pinyin_initials === queryLower ||
                folder.name_pinyin_initials.startsWith(queryLower) ||
                folder.name_pinyin_initials.includes(queryLower)) {
              return true;
            }
          }
        }
        
        return false;
      });
      
      if (query.trim() === searchQuery.trim()) {
        setSystemFolders(results);
      } else {
        setSystemFolders([]);
      }
    } catch (error) {
      console.error("Failed to search system folders:", error);
      setSystemFolders([]);
    }
  };

  // 主搜索函数：协调各个子功能
  const searchApplications = async (searchQuery: string) => {
    console.log(`[searchApplications] 函数被调用: query="${searchQuery}"`);
    
    // 立即清空旧结果，避免显示上一个搜索的结果
    if (APP_SEARCH_DEBUG_CONFIG.enableClearResults) {
      clearAppSearchResults();
    }
    
    try {
      // 简化验证：只验证一次，避免重复验证的开销
      if (APP_SEARCH_DEBUG_CONFIG.enableQueryValidation) {
        const isValid = validateSearchQuery(searchQuery);
        if (!isValid) {
          console.log(`[searchApplications] 查询验证失败: query="${searchQuery}"`);
          if (APP_SEARCH_DEBUG_CONFIG.enableClearResults) {
            clearAppSearchResults();
          }
          return;
        }
      }
      
      // 确保应用列表已加载（仅在需要时）
      if (APP_SEARCH_DEBUG_CONFIG.enableEnsureAppsLoaded) {
        await ensureAppsLoaded();
      }
      
      // 执行搜索
      let results: AppInfo[] = [];
      if (APP_SEARCH_DEBUG_CONFIG.enablePerformSearch) {
        console.log(`[searchApplications] 开始执行前端搜索: query="${searchQuery}"`);
        results = await performAppSearch(searchQuery);
        console.log(`[searchApplications] 前端搜索完成: 结果数量=${results.length}, results=`, results);
        console.log(`[searchApplications] results 是否为数组:`, Array.isArray(results));
        console.log(`[searchApplications] results 的详细信息:`, JSON.stringify(results.map(r => ({ name: r.name, path: r.path, hasIcon: !!r.icon })), null, 2));
      } else {
        console.log(`[searchApplications] 前端搜索已禁用 (enablePerformSearch=false)`);
      }
      
      // 触发后端图标提取：调用后端搜索以触发图标提取逻辑（即使不使用返回结果）
      // 后端会在后台提取缺少图标的应用图标，并通过事件通知前端更新
      console.log(`[searchApplications] 检查是否需要触发图标提取: results.length=${results.length}, results=`, results);
      
      // 总是调用后端搜索以触发图标提取（后端会自己检查哪些应用缺少图标）
      // 即使前端搜索结果为空或所有应用都有图标，后端也可能需要更新某些应用的图标
      // 因为前端搜索可能因为缓存问题没有返回完整结果，而后端搜索会返回完整结果
      console.log(`[图标提取触发] 调用后端 searchApplications: query=${searchQuery}`);
      tauriApi.searchApplications(searchQuery)
        .then((backendResults) => {
          console.log(`[图标提取触发] 后端 searchApplications 调用成功，返回 ${backendResults.length} 个结果`);
          if (results.length > 0) {
            const appsWithoutIcons = results.filter(app => !isValidIcon(app.icon));
            console.log(`[图标提取触发] 前端搜索结果: ${results.length} 个，缺少图标: ${appsWithoutIcons.length} 个`);
            if (appsWithoutIcons.length > 0) {
              console.log(`[图标提取触发] 缺少图标的应用列表:`, appsWithoutIcons.map(app => ({ name: app.name, path: app.path })));
            }
          }
        })
        .catch((error) => {
          console.error(`[图标提取触发] 后端 searchApplications 调用失败:`, error);
        });
      
      // 更新搜索结果（带查询验证）
      if (APP_SEARCH_DEBUG_CONFIG.enableUpdateResults) {
        updateAppSearchResults(results, searchQuery);
      }
    } catch (error) {
      // 仅在查询为空时清空结果
      if (APP_SEARCH_DEBUG_CONFIG.enableQueryValidation && !validateSearchQuery(searchQuery)) {
        if (APP_SEARCH_DEBUG_CONFIG.enableClearResults) {
          clearAppSearchResults();
        }
      }
    } finally {
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

  // 刷新文件历史缓存（当文件历史更新时调用）
  const refreshFileHistoryCache = useCallback(async () => {
    try {
      const allFileHistory = await tauriApi.getAllFileHistory();
      allFileHistoryCacheRef.current = allFileHistory;
      allFileHistoryCacheLoadedRef.current = true;
    } catch (error) {
      console.error("Failed to refresh file history cache:", error);
    }
  }, []);

  // 前端搜索文件历史（基于缓存的文件历史列表）
  const searchFileHistoryFrontend = (query: string, fileHistory: FileHistoryItem[]): FileHistoryItem[] => {
    if (!query || query.trim() === "") {
      // 返回所有文件，按最后使用时间排序
      const sorted = [...fileHistory].sort((a, b) => b.last_used - a.last_used);
      return sorted.slice(0, 100); // 限制返回数量
    }

    const queryLower = query.trim().toLowerCase();

    const results: Array<{ item: FileHistoryItem; score: number }> = [];

    for (const item of fileHistory) {
      const nameLower = item.name.toLowerCase();
      const pathLower = item.path.toLowerCase();
      let score = 0;

      // 名称匹配（最高优先级）
      if (nameLower === queryLower) {
        score += 1000;
      } else if (nameLower.startsWith(queryLower)) {
        score += 500;
      } else if (nameLower.includes(queryLower)) {
        score += 100;
      }

      // 路径匹配（较低优先级）
      if (score === 0 && pathLower.includes(queryLower)) {
        score += 10;
      }

      if (score > 0) {
        results.push({ item, score });
      }
    }

    // 按分数排序，然后按最后使用时间排序
    results.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return b.item.last_used - a.item.last_used;
    });

    // 限制结果数量并返回
    return results.slice(0, 100).map((r) => r.item);
  };

  const searchFileHistory = async (searchQuery: string) => {
    try {
      // Don't search if query is empty
      if (!searchQuery || searchQuery.trim() === "") {
        setFilteredFiles([]);
        return;
      }

      // 如果缓存未加载，先加载所有文件历史
      if (!allFileHistoryCacheLoadedRef.current || allFileHistoryCacheRef.current.length === 0) {
        try {
          const allFileHistory = await tauriApi.getAllFileHistory();
          allFileHistoryCacheRef.current = allFileHistory;
          allFileHistoryCacheLoadedRef.current = true;
        } catch (error) {
          console.error("Failed to load file history for search:", error);
          // 如果加载失败，回退到后端搜索
          const results = await tauriApi.searchFileHistory(searchQuery);
          if (query.trim() === searchQuery.trim()) {
            setFilteredFiles(results);
          } else {
            setFilteredFiles([]);
          }
          return;
        }
      }

      // 使用前端搜索
      const results = searchFileHistoryFrontend(searchQuery, allFileHistoryCacheRef.current);

      // Only update if query hasn't changed
      const currentQueryTrimmed = query.trim();
      const searchQueryTrimmed = searchQuery.trim();
      if (currentQueryTrimmed === searchQueryTrimmed) {
        setFilteredFiles(results);
        
        // 检查 filteredFiles 中是否有可执行文件（.exe/.lnk），如果有，触发图标提取
        const executableFiles = results.filter(file => {
          const pathLower = file.path.toLowerCase();
          return (pathLower.endsWith('.exe') || pathLower.endsWith('.lnk')) && 
                 !pathLower.includes("windowsapps");
        });
        
        if (executableFiles.length > 0) {
          console.log(`[文件历史图标提取] 发现 ${executableFiles.length} 个可执行文件，触发图标提取:`, executableFiles.map(f => ({ name: f.name, path: f.path })));
          
          // 直接为每个文件路径调用图标提取API（因为这些文件可能不在应用列表中）
          // 限制最多提取前10个文件，避免过多请求
          const filesToExtract = executableFiles.slice(0, 10);
          filesToExtract.forEach((file, index) => {
            console.log(`[文件历史图标提取] [${index + 1}/${filesToExtract.length}] 提取图标: path=${file.path}`);
            tauriApi.extractIconFromPath(file.path)
              .then((icon) => {
                if (icon) {
                  console.log(`[文件历史图标提取] ✓ 图标提取成功: path=${file.path}, iconLength=${icon.length}`);
                  // 将提取的图标保存到缓存中
                  extractedFileIconsRef.current.set(file.path, icon);
                  // 更新 filteredFiles 中对应文件的显示（通过重新设置 filteredFiles 触发重新渲染）
                  setFilteredFiles((prevFiles) => {
                    // 返回相同的数组，但会触发重新渲染，SearchResult 构建时会使用新的图标
                    return [...prevFiles];
                  });
                } else {
                  console.log(`[文件历史图标提取] ✗ 图标提取失败: path=${file.path}`);
                }
              })
              .catch((error) => {
                console.error(`[文件历史图标提取] ✗ 图标提取错误: path=${file.path}, error=`, error);
              });
          });
          
          // 注意：不再调用后端搜索，避免重复调用
          // 后端搜索会在 searchApplications 函数中统一调用
        }
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


  // 会话模式相关的 ref（完全复刻 EverythingSearchWindow）
  const pendingSessionIdRef = useRef<string | null>(null);
  const currentSearchQueryRef = useRef<string>("");
  const creatingSessionQueryRef = useRef<string | null>(null);
  const displayedSearchQueryRef = useRef<string>("");
  const LAUNCHER_PAGE_SIZE = 50; // 启动器只显示前 50 条结果
  const LAUNCHER_MAX_RESULTS = 50; // 启动器会话最大结果数

  // 关闭会话的安全方法（完全复刻 EverythingSearchWindow）
  const closeSessionSafe = useCallback(
    async (id?: string | null) => {
      const target = id ?? pendingSessionIdRef.current;
      if (!target) return;
      try {
        await tauriApi.closeEverythingSearchSession(target);
      } catch (error) {
        // 静默处理错误
      }
    },
    []
  );

  // 启动 Everything 搜索会话（完全复刻 EverythingSearchWindow 的模式）
  const startSearchSession = useCallback(
    async (searchQuery: string) => {
      if (!searchQuery || searchQuery.trim() === "") {
        const oldSessionId = pendingSessionIdRef.current;
        if (oldSessionId) {
          await closeSessionSafe(oldSessionId);
        }
        pendingSessionIdRef.current = null;
        currentSearchQueryRef.current = "";
        displayedSearchQueryRef.current = "";
        setEverythingResults([]);
        setEverythingTotalCount(null);
        setEverythingCurrentCount(0);
        setIsSearchingEverything(false);
        return;
      }

      if (!isEverythingAvailable) {
        const oldSessionId = pendingSessionIdRef.current;
        if (oldSessionId) {
          await closeSessionSafe(oldSessionId);
        }
        pendingSessionIdRef.current = null;
        currentSearchQueryRef.current = "";
        displayedSearchQueryRef.current = "";
        setEverythingResults([]);
        setEverythingTotalCount(null);
        setEverythingCurrentCount(0);
        setIsSearchingEverything(false);
        return;
      }

      const trimmed = searchQuery.trim();
      // 性能优化：根据查询长度动态调整 maxResults
      // 短查询（1-2字符）通常返回大量结果，使用较小的 maxResults 以加快会话创建
      // 长查询（3+字符）结果更精确，可以使用较大的 maxResults
      const queryLength = trimmed.length;
      let maxResultsToUse = LAUNCHER_MAX_RESULTS; // 默认 50
      if (queryLength === 1) {
        // 单字符查询：使用最小的 maxResults，因为通常返回数百万结果
        maxResultsToUse = 50; // 进一步降低到 50，最大化性能
      } else if (queryLength === 2) {
        // 双字符查询：使用较小的 maxResults
        maxResultsToUse = 100;
      } else if (queryLength <= 4) {
        // 3-4字符查询：中等大小
        maxResultsToUse = 200;
      } else {
        // 5+字符查询：可以使用更大的值
        maxResultsToUse = 500;
      }

      // 保存当前搜索的 query
      currentSearchQueryRef.current = trimmed;

      // 如果相同查询的会话正在创建中，直接返回
      if (creatingSessionQueryRef.current === trimmed) {
        return;
      }

      // 检查是否已有相同查询的活跃会话
      if (
        pendingSessionIdRef.current &&
        currentSearchQueryRef.current === trimmed
      ) {
        return;
      }

      // 标记正在创建会话
      creatingSessionQueryRef.current = trimmed;

      // 关闭旧会话（不阻塞，异步执行）
      const oldSessionId = pendingSessionIdRef.current;
      if (oldSessionId) {
        // 不等待关闭完成，立即开始新搜索
        closeSessionSafe(oldSessionId).catch(() => {
          // 静默处理错误
        });
      }
      // 在创建新会话前先清空 pendingSessionIdRef，防止旧的请求使用已失效的会话
      pendingSessionIdRef.current = null;
      // 注意：不要清空 currentSearchQueryRef.current，它应该保持当前查询
      displayedSearchQueryRef.current = "";
      setEverythingResults([]);
      setEverythingTotalCount(null);
      setEverythingCurrentCount(0);
      setIsSearchingEverything(true);

      try {
        const sessionTimeoutMs = 60000; // 60秒超时
        const sessionTimeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`创建搜索会话超时（${sessionTimeoutMs}ms）`));
          }, sessionTimeoutMs);
        });

        const session = await Promise.race([
          tauriApi.startEverythingSearchSession(trimmed, {
            maxResults: maxResultsToUse,
            chunkSize: 50, // 启动器使用较小的 chunk_size，提升响应速度
          }),
          sessionTimeoutPromise,
        ]);

        // 检查查询是否仍然有效
        if (currentSearchQueryRef.current !== trimmed) {
          await closeSessionSafe(session.sessionId);
          pendingSessionIdRef.current = null;
          creatingSessionQueryRef.current = null;
          setIsSearchingEverything(false);
          return;
        }

        pendingSessionIdRef.current = session.sessionId;
        creatingSessionQueryRef.current = null;
        // 保存针对该关键字查询到的实际总数（不受maxResults限制）
        setEverythingTotalCount(session.totalCount ?? 0);

        // 立即获取第一页结果（启动器只需要第一页）
        const offset = 0;
        const currentSessionId = session.sessionId;
        const currentQueryForPage = trimmed;

        const timeoutMs = 30000; // 30秒超时
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`获取首屏页超时（${timeoutMs}ms）`));
          }, timeoutMs);
        });

        Promise.race([
          tauriApi.getEverythingSearchRange(currentSessionId, offset, LAUNCHER_PAGE_SIZE, {}),
          timeoutPromise,
        ])
          .then((res) => {
            // 检查会话和查询是否仍然有效
            const currentPendingSessionId = pendingSessionIdRef.current;
            const isSessionStillValid = currentPendingSessionId === currentSessionId;
            const isQueryStillValid = currentSearchQueryRef.current === currentQueryForPage;

            if (!isSessionStillValid || !isQueryStillValid) {
              if (!pendingSessionIdRef.current) {
                setIsSearchingEverything(false);
              }
              return;
            }

            // 更新结果
            setEverythingResults(res.items);
            setEverythingCurrentCount(res.items.length);
            displayedSearchQueryRef.current = trimmed;
            setIsSearchingEverything(false);
          })
          .catch((error) => {
            const currentPendingSessionId = pendingSessionIdRef.current;
            const isSessionStillValid = currentPendingSessionId === currentSessionId;
            const isQueryStillValid = currentSearchQueryRef.current === currentQueryForPage;

            if (!isSessionStillValid || !isQueryStillValid) {
              return;
            }
            const errorStr = typeof error === "string" ? error : String(error);
            
            // 检查是否是服务不可用错误
            if (
              errorStr.includes('NOT_INSTALLED') ||
              errorStr.includes('SERVICE_NOT_RUNNING') ||
              errorStr.includes('not found') ||
              errorStr.includes('未找到') ||
              errorStr.includes('未运行')
            ) {
              tauriApi.getEverythingStatus()
                .then((status) => {
                  setIsEverythingAvailable(status.available);
                  setEverythingError(status.error || null);
                })
                .catch(() => {
                  setIsEverythingAvailable(false);
                  setEverythingError("搜索失败后无法重新检查状态");
                });
            }
            
            setEverythingResults([]);
            setEverythingTotalCount(null);
            setEverythingCurrentCount(0);
            setIsSearchingEverything(false);
          });
      } catch (error) {
        creatingSessionQueryRef.current = null;
        const errorStr = typeof error === "string" ? error : String(error);
        if (
          errorStr.includes('NOT_INSTALLED') ||
          errorStr.includes('SERVICE_NOT_RUNNING') ||
          errorStr.includes('not found') ||
          errorStr.includes('未找到') ||
          errorStr.includes('未运行')
        ) {
          tauriApi.getEverythingStatus()
            .then((status) => {
              setIsEverythingAvailable(status.available);
              setEverythingError(status.error || null);
            })
            .catch(() => {
              setIsEverythingAvailable(false);
              setEverythingError("搜索失败后无法重新检查状态");
            });
        }
        
        setEverythingResults([]);
        setEverythingTotalCount(null);
        setEverythingCurrentCount(0);
        setIsSearchingEverything(false);
      }
    },
    [isEverythingAvailable, closeSessionSafe]
  );

  // 组件卸载时清理 Everything 搜索会话
  useEffect(() => {
    return () => {
      const oldSessionId = pendingSessionIdRef.current;
      if (oldSessionId) {
        closeSessionSafe(oldSessionId).catch(() => {
          // 静默处理错误
        });
      }
    };
  }, [closeSessionSafe]);


  const handleCheckAgain = useCallback(async () => {
    try {
      // Force a fresh check with detailed status
      const status = await tauriApi.getEverythingStatus();
      
      // 如果服务未运行，尝试自动启动
      if (!status.available && status.error === "SERVICE_NOT_RUNNING") {
        try {
          await tauriApi.startEverything();
          // 等待一下让 Everything 启动并初始化
          await new Promise(resolve => setTimeout(resolve, 2000));
          // 重新检查状态
          const newStatus = await tauriApi.getEverythingStatus();
          setIsEverythingAvailable(newStatus.available);
          setEverythingError(newStatus.error || null);
          
          if (!newStatus.available) {
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
      }
    } catch (error) {
      console.error("Failed to check Everything:", error);
      alert(`检测失败: ${error}`);
    }
  }, []);

  const handleStartEverything = useCallback(async () => {
    try {
      await tauriApi.startEverything();
      // 等待一下让 Everything 启动并初始化
      await new Promise(resolve => setTimeout(resolve, 2000));
      // 重新检查状态
      await handleCheckAgain();
    } catch (error) {
      console.error("启动 Everything 失败:", error);
      alert(`启动失败: ${error}`);
    }
  }, [handleCheckAgain]);

  const handleDownloadEverything = useCallback(async () => {
    try {
      console.log("[Everything下载] 开始下载...");
      setIsDownloadingEverything(true);
      setEverythingDownloadProgress(0);

      console.log("[Everything下载] 调用 tauriApi.downloadEverything()...");
      const installerPath = await tauriApi.downloadEverything();
      console.log("[Everything下载] 下载完成，安装程序路径:", installerPath);
      setEverythingDownloadProgress(100);

      // 下载完成后，临时取消窗口置顶，确保安装程序显示在启动器之上
      const window = getCurrentWindow();
      await window.setAlwaysOnTop(false);

      // 自动打开安装程序
      console.log("[Everything下载] 启动安装程序...");
      await tauriApi.launchFile(installerPath);

      // 下载逻辑结束，重置下载状态（不再弹出遮挡安装向导的提示框）
      setIsDownloadingEverything(false);
      setEverythingDownloadProgress(0);
      console.log("[Everything下载] 完成");
    } catch (error) {
      console.error("[Everything下载] 下载失败:", error);
      setIsDownloadingEverything(false);
      setEverythingDownloadProgress(0);
      const errorMessage = error instanceof Error ? error.message : String(error);
      alert(`下载失败: ${errorMessage}`);
    }
  }, []);

  const handleLaunch = async (result: SearchResult) => {
    try {
      // Record open history for all types (but delay updating state to avoid reordering during animation)
      try {
        void tauriApi.recordOpenHistory(result.path);
        // Don't update local state immediately to prevent list reordering during animation
      } catch (error) {
        console.error("Failed to record open history:", error);
      }
      
      // 对于应用类型，同时更新 file_history 表（用于使用频率统计）
      // 注意：只对实际文件路径（.exe, .lnk）更新，UWP 应用路径（shell:AppsFolder, ms-settings:）跳过
      if (result.type === "app" && result.path) {
        const pathLower = result.path.toLowerCase();
        const isRealFilePath = pathLower.endsWith('.exe') || pathLower.endsWith('.lnk');
        if (isRealFilePath) {
          try {
            // 异步更新，不阻塞应用启动
            console.log(`[应用打开] 准备更新 file_history: ${result.path}`);
            void tauriApi.addFileToHistory(result.path)
              .then(() => {
                console.log(`[应用打开] ✓ 成功更新 file_history: ${result.path}`);
                // 刷新文件历史缓存，确保下次搜索时能获取到最新的使用频率数据
                void refreshFileHistoryCache();
              })
              .catch((error) => {
                // 如果路径不存在或其他错误，记录警告（不影响应用启动）
                console.warn(`[应用打开] ✗ 更新 file_history 失败: ${result.path}`, error);
              });
          } catch (error) {
            console.warn(`[应用打开] ✗ 更新 file_history 异常: ${result.path}`, error);
          }
        } else {
          console.log(`[应用打开] 跳过 file_history 更新（UWP 应用路径）: ${result.path}`);
        }
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
          
          // 注意：file_history 的更新已经在 handleLaunch 开头处理了，这里不需要重复刷新
          
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
          // 刷新文件历史缓存，确保下次搜索时能获取到最新的使用频率数据
          void refreshFileHistoryCache();
          
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
        try {
          await tauriApi.launchFile(result.file.path);
        } catch (fileError: any) {
          const errorMsg = fileError?.message || fileError?.toString() || "";
          // 检测是否是文件不存在的错误，自动删除历史记录
          if (errorMsg.includes("Path not found") || errorMsg.includes("not found")) {
            try {
              // 自动删除无效的历史记录
              await tauriApi.deleteFileHistory(result.file.path);
              // 刷新文件历史缓存
              await refreshFileHistoryCache();
              // 重新搜索以更新结果列表
              if (query.trim()) {
                await searchFileHistory(query);
              } else {
                await searchFileHistory("");
              }
              // 显示提示信息
              setErrorMessage(`文件不存在：${result.file.path}\n\n已自动从历史记录中删除该文件。`);
            } catch (deleteError: any) {
              console.error("Failed to delete file history:", deleteError);
              // 如果删除失败，仍然显示原始错误
              setErrorMessage(`文件不存在：${result.file.path}\n\n错误：${errorMsg}`);
            }
            return; // 不继续执行后续的 hideLauncherAndResetState
          } else {
            // 其他错误，正常显示
            throw fileError;
          }
        }
      } else if (result.type === "everything" && result.everything) {
        // Launch Everything result and add to file history
        try {
          await tauriApi.launchFile(result.everything.path);
          await tauriApi.addFileToHistory(result.everything.path);
          // 更新前端缓存
          await refreshFileHistoryCache();
        } catch (fileError: any) {
          const errorMsg = fileError?.message || fileError?.toString() || "";
          // 检测是否是文件不存在的错误
          if (errorMsg.includes("Path not found") || errorMsg.includes("not found")) {
            setErrorMessage(`文件不存在：${result.everything.path}`);
            return; // 不继续执行后续的 hideLauncherAndResetState
          } else {
            // 其他错误，正常显示
            throw fileError;
          }
        }
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

  const handleContextMenu = useCallback((e: React.MouseEvent, result: SearchResult) => {
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
  }, []);

  const handleRevealInFolder = useCallback(async () => {
    if (!contextMenu) return;
    
    try {
      const target = contextMenu.result;
      const path = target.path;
      console.log("Revealing in folder:", path);
      // 为应用、文件和 Everything 结果都提供"打开所在文件夹"
      if (
        target.type === "file" ||
        target.type === "everything" ||
        target.type === "app"
      ) {
        // 对于文件类型，先检查文件是否存在
        if (target.type === "file" || target.type === "everything") {
          const pathItem = await tauriApi.checkPathExists(path);
          if (!pathItem) {
            // 文件不存在，自动删除历史记录
            // 先关闭右键菜单
            setContextMenu(null);
            
            try {
              await tauriApi.deleteFileHistory(path);
              // 刷新文件历史缓存
              await refreshFileHistoryCache();
              // 重新搜索以更新结果列表
              if (query.trim()) {
                await searchFileHistory(query);
              } else {
                await searchFileHistory("");
              }
              // 显示提示信息
              setErrorMessage(`文件不存在，已自动从历史记录中删除该文件。`);
            } catch (deleteError: any) {
              console.error("Failed to delete file history:", deleteError);
              setErrorMessage(`文件不存在，但删除历史记录失败：${deleteError}`);
            }
            return;
          }
        }
        
        // Use custom reveal_in_folder command to handle shell: protocol paths
        await tauriApi.revealInFolder(path);
        console.log("Reveal in folder called successfully");
      }
      setContextMenu(null);
    } catch (error) {
      console.error("Failed to reveal in folder:", error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      // 检查是否是父目录不存在的错误
      if (errorMsg.includes("Parent directory does not exist")) {
        alert(`无法打开文件夹：父目录不存在\n\n${errorMsg}`);
      } else {
        alert(`打开文件夹失败: ${errorMsg}`);
      }
      setContextMenu(null);
    }
  }, [contextMenu, query, refreshFileHistoryCache, setErrorMessage]);

  const processPastedPath = useCallback(async (trimmedPath: string) => {
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
          // 更新前端缓存
          await refreshFileHistoryCache();
          // 使用前端缓存搜索
          const searchResults = searchFileHistoryFrontend(trimmedPath, allFileHistoryCacheRef.current);
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
  }, []);

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const clipboardTypes = Array.from(e.clipboardData.types);
    
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
  }, [processPastedPath]);

  const handleSaveImageToDownloads = useCallback(async (imagePath: string) => {
    try {
      const savedPath = await tauriApi.copyFileToDownloads(imagePath);
      setSuccessMessage(`图片已保存到下载目录: ${savedPath}`);
      setPastedImagePath(null); // 清除状态
      setPastedImageDataUrl(null); // 清除预览
      // 只添加到历史记录，不更新搜索结果，避免自动打开
      try {
        await tauriApi.addFileToHistory(savedPath);
        // 更新前端缓存
        await refreshFileHistoryCache();
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
  }, []);


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
              // 排除输入框、应用中心按钮和 footer 区域的按钮
              // 注意：wrapper 区域会 stopPropagation，所以这里主要处理 wrapper 上方的区域
              const target = e.target as HTMLElement;
              const isInput = target.tagName === 'INPUT' || target.closest('input');
              const isAppCenterButton = target.closest('[title="应用中心"]');
              const isFooterButton = target.closest('button') && target.closest('[class*="border-t"]');
              const isButton = target.tagName === 'BUTTON' || target.closest('button');
              if (!isInput && !isAppCenterButton && !isFooterButton && !isButton) {
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
                          {(() => {
                            // 获取最近使用时间（优先使用 file.last_used，否则使用 openHistory）
                            const lastUsed = result.file?.last_used || openHistory[result.path] || 0;
                            if (!lastUsed || lastUsed === 0) return null;
                            
                            return <span className="ml-2">· {formatLastUsedTime(lastUsed)}</span>;
                          })()}
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
                            ? `${everythingResults.length.toLocaleString()}/${everythingTotalCount.toLocaleString()}`
                            : everythingResults.length > 0
                            ? `${everythingResults.length.toLocaleString()}/?`
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
          <div 
            className="px-6 py-2 border-t border-gray-100 text-xs text-gray-400 flex justify-between items-center bg-gray-50/50 flex-shrink-0 gap-2 min-w-0"
            onMouseDown={(e) => {
              // 阻止 footer 区域的点击事件被 header 的拖动处理器捕获
              const target = e.target as HTMLElement;
              const isButton = target.tagName === 'BUTTON' || target.closest('button');
              if (isButton) {
                // 如果是按钮，阻止事件冒泡到 header，让按钮自己的 onClick 处理
                e.stopPropagation();
              }
            }}
          >
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
                    {(() => {
                      console.log("[Everything下载] 按钮渲染检查:", {
                        isEverythingAvailable,
                        everythingError,
                        isDownloadingEverything,
                        shouldShowDownload: !everythingError || !everythingError.startsWith("SERVICE_NOT_RUNNING"),
                      });
                      return null;
                    })()}
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
                        ref={downloadButtonRef}
                        onPointerDown={(e) => {
                          console.log("[Everything下载] onPointerDown 触发", {
                            pointerType: e.pointerType,
                            button: e.button,
                            disabled: isDownloadingEverything,
                          });
                        }}
                        onClick={(e) => {
                          console.log("[Everything下载] onClick 触发", {
                            disabled: isDownloadingEverything,
                            target: e.target,
                            currentTarget: e.currentTarget,
                          });
                          if (!isDownloadingEverything) {
                            console.log("[Everything下载] 通过 onClick 触发下载");
                            e.preventDefault();
                            e.stopPropagation();
                            handleDownloadEverything().catch((error) => {
                              console.error("[Everything下载] handleDownloadEverything 抛出错误:", error);
                            });
                          } else {
                            console.log("[Everything下载] 按钮已禁用，忽略点击");
                          }
                        }}
                        disabled={isDownloadingEverything}
                        className={`px-2 py-1 text-xs rounded transition-colors whitespace-nowrap ${
                          isDownloadingEverything
                            ? 'bg-gray-400 text-white cursor-not-allowed'
                            : 'bg-blue-500 text-white hover:bg-blue-600'
                        }`}
                        style={{ pointerEvents: 'auto', zIndex: 1000, position: 'relative' }}
                        title="下载并安装 Everything"
                        data-testid="download-everything-button"
                      >
                        {isDownloadingEverything ? `下载中 ${everythingDownloadProgress}%` : '下载'}
                      </button>
                    )}
                    <button
                      onMouseDown={(e) => {
                        console.log("[Everything刷新] onMouseDown 触发", {
                          button: e.button,
                        });
                      }}
                      onClick={(e) => {
                        console.log("[Everything刷新] onClick 触发");
                        e.preventDefault();
                        e.stopPropagation();
                        console.log("[Everything刷新] 调用 handleCheckAgain");
                        handleCheckAgain().catch((error) => {
                          console.error("[Everything刷新] handleCheckAgain 抛出错误:", error);
                        });
                      }}
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
