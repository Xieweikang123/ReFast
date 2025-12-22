import { useState, useEffect, useRef, useMemo, useCallback, startTransition, useDeferredValue } from "react";
import { flushSync } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { tauriApi } from "../api/tauri";
import { trackEvent } from "../api/events";
import type { AppInfo, FileHistoryItem, EverythingResult, MemoItem, PluginContext, UpdateCheckResult, SearchEngineConfig } from "../types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
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
  normalizePathForHistory,
  formatLastUsedTime,
} from "../utils/launcherUtils";
import { getThemeConfig, getLayoutConfig, type ResultStyle } from "../utils/themeConfig";
import { handleEscapeKey, closePluginModalAndHide, closeMemoModalAndHide } from "../utils/launcherHandlers";
import { clearAllResults, resetSelectedIndices, selectFirstHorizontal, selectFirstVertical, loadResultsIncrementally } from "../utils/resultUtils";
import { adjustWindowSize, getMainContainer as getMainContainerUtil } from "../utils/windowUtils";
import { searchMemos, searchSystemFolders, searchApplications, searchFileHistory, searchFileHistoryFrontend } from "../utils/searchUtils";
import type { SearchResult } from "../utils/resultUtils";
import { askOllama } from "../utils/ollamaUtils";
import { computeCombinedResults } from "../utils/combineResultsUtils";


interface LauncherWindowProps {
  updateInfo?: UpdateCheckResult | null;
}

export function LauncherWindow({ updateInfo }: LauncherWindowProps) {
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
  // 待发送到 JSON 查看器的内容队列
  const pendingJsonContentRef = useRef<string | null>(null);
  const [isPluginListModalOpen, setIsPluginListModalOpen] = useState(false);
  const [openHistory, setOpenHistory] = useState<Record<string, number>>({});
  const [isRemarkModalOpen, setIsRemarkModalOpen] = useState(false);
  const [editingRemarkUrl, setEditingRemarkUrl] = useState<string | null>(null);
  const [searchEngines, setSearchEngines] = useState<SearchEngineConfig[]>([]);
  const [remarkText, setRemarkText] = useState<string>("");
  const [urlRemarks, setUrlRemarks] = useState<Record<string, string>>({});
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
  // 记录备注弹窗是否打开，用于全局 ESC 处理时优先关闭备注弹窗，而不是隐藏整个窗口
  const isRemarkModalOpenRef = useRef(false);
  // 记录右键菜单是否打开，用于全局 ESC 处理时优先关闭右键菜单，而不是隐藏整个窗口
  const contextMenuRef = useRef<{ x: number; y: number; result: SearchResult } | null>(null);
  const shouldPreserveScrollRef = useRef(false); // 标记是否需要保持滚动位置
  const incrementalLoadRef = useRef<number | null>(null); // 用于取消增量加载
  const incrementalTimeoutRef = useRef<number | null>(null); // 用于取消增量加载的 setTimeout
  const lastSearchQueryRef = useRef<string>(""); // 用于去重，避免相同查询重复搜索
  const debounceTimeoutRef = useRef<number | null>(null); // 用于跟踪防抖定时器
  const combinedResultsUpdateTimeoutRef = useRef<number | null>(null); // 用于防抖延迟更新 combinedResults
  const hasResultsRef = useRef(false); // 用于跟踪是否有结果，避免读取状态导致不必要的重新渲染
  
  // 辅助函数：使用 startTransition 包装状态更新，避免阻塞输入框
  const updateSearchResults = useCallback(<T,>(setter: (value: T) => void, value: T) => {
    startTransition(() => {
      setter(value);
    });
  }, []);
  const currentLoadResultsRef = useRef<SearchResult[]>([]); // 跟踪当前正在加载的结果，用于验证是否仍有效
  const horizontalResultsRef = useRef<SearchResult[]>([]); // 跟踪当前的横向结果，用于防止被覆盖
  const closeOnBlurRef = useRef(true);
  const isHorizontalNavigationRef = useRef(false); // 标记是否是横向导航切换
  const isAutoSelectingFirstHorizontalRef = useRef(false); // 标记是否正在自动选择第一个横向结果（用于防止scrollIntoView）
  const justJumpedToVerticalRef = useRef(false); // 标记是否刚刚从横向跳转到纵向（用于防止results useEffect重置selectedIndex）
  
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
    isRemarkModalOpenRef.current = isRemarkModalOpen;
  }, [isRemarkModalOpen]);

  useEffect(() => {
    contextMenuRef.current = contextMenu;
  }, [contextMenu]);

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
      case "translation":
        return (
          <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
          </svg>
        );
      case "hex_converter":
        return (
          <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
          </svg>
        );
      case "clipboard":
        return (
          <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
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
        // 加载搜索引擎配置
        if (settings.search_engines) {
          setSearchEngines(settings.search_engines);
        }
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

  // 监听 JSON 查看器窗口准备好事件，发送待处理的内容
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;

    const setupListener = async () => {
      try {
        unlistenFn = await listen("json-formatter:ready", async () => {
          // 窗口已准备好，发送待处理的内容
          if (pendingJsonContentRef.current) {
            const content = pendingJsonContentRef.current;
            pendingJsonContentRef.current = null; // 清空待处理内容
            
            try {
              const { emit } = await import("@tauri-apps/api/event");
              await emit("json-formatter:set-content", content);
            } catch (error) {
              console.error("Failed to send JSON content to formatter window:", error);
            }
          }
        });
      } catch (error) {
        console.error("Failed to setup JSON formatter ready listener:", error);
      }
    };

    setupListener();

    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
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
        // 加载所有 URL 的备注信息（备注存储在 name 字段中）
        const remarks: Record<string, string> = {};
        for (const [key] of Object.entries(history)) {
          if (key.startsWith('http://') || key.startsWith('https://')) {
            try {
              const item = await tauriApi.getOpenHistoryItem(key);
              if (item?.name) {
                remarks[key] = item.name;
              }
            } catch (error) {
              // 忽略单个项加载失败
            }
          }
        }
        setUrlRemarks(remarks);
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
          // 同时更新缓存，用于前端搜索
          allAppsCacheRef.current = filteredApps;
          allAppsCacheLoadedRef.current = true;
          // 不设置 filteredApps，等待用户输入查询时再设置
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
        
        // 前端防抖：检查是否在 500ms 内重复触发同一个插件
        // 增加防抖时间，防止重复打开窗口
        const now = Date.now();
        if (lastTriggeredRef.current) {
          const { pluginId: lastId, time: lastTime } = lastTriggeredRef.current;
          if (lastId === pluginId && now - lastTime < 500) {
            console.log(`[PluginHotkeys] ⏭️  Ignored duplicate trigger for plugin: ${pluginId} (within 500ms)`);
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
      // 如果右键菜单已打开，优先关闭右键菜单
      if ((e.key === "Escape" || e.keyCode === 27) && contextMenuRef.current) {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu(null);
        return;
      }
      
      // 如果备注弹窗已打开，优先关闭备注弹窗，不关闭启动器
      if ((e.key === "Escape" || e.keyCode === 27) && isRemarkModalOpenRef.current) {
        e.preventDefault();
        e.stopPropagation();
        setIsRemarkModalOpen(false);
        setEditingRemarkUrl(null);
        setRemarkText("");
        return;
      }
      
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
  const askOllamaWrapper = useCallback(async (prompt: string) => {
    await askOllama(prompt, ollamaSettings, {
      setAiAnswer,
      setShowAiAnswer,
      setIsAiLoading,
    });
  }, [ollamaSettings]);

  // 将 askOllama 暴露到 window 以避免未使用告警并便于调试
  useEffect(() => {
    (window as any).__askOllama = askOllamaWrapper;
  }, [askOllamaWrapper]);

  // Search applications, file history, and Everything when query changes (with debounce)
  useEffect(() => {
    const trimmedQuery = query.trim();
    
    // 优化：如果 trimmedQuery 没有真正变化（例如 "a " → "a"），直接返回，避免不必要的操作
    // 这样可以避免退格时因为空格变化导致的卡顿
    if (trimmedQuery === lastSearchQueryRef.current) {
      // 如果查询为空且之前也为空，直接返回
      if (trimmedQuery === "") {
        return;
      }
      // 如果查询相同且有结果，直接返回，不重置防抖定时器
      if (hasResultsRef.current) {
        return;
      }
      // 如果查询相同但没有结果，继续执行搜索逻辑（可能是结果被清空了）
    }
    
    // 清除之前的防抖定时器（只有在查询真正变化时才清除）
    if (debounceTimeoutRef.current !== null) {
      clearTimeout(debounceTimeoutRef.current);
      debounceTimeoutRef.current = null;
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
      hasResultsRef.current = false;
      return;
    }
    
    // If user is typing new content while in AI answer mode, exit AI answer mode
    if (showAiAnswer) {
      setShowAiAnswer(false);
      setAiAnswer(null);
      setIsAiLoading(false);
    }
    
    // 优化：不在输入时立即清空结果，而是在防抖定时器触发时清空
    // 这样可以避免每次输入都触发大量状态更新导致的卡顿
    // 输入框的响应会更流畅
    
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

    
    const timeoutId = setTimeout(() => {
      
      // 再次检查查询是否仍然有效（可能在防抖期间已被清空或改变）
      const currentQuery = query.trim();
      if (currentQuery === "" || currentQuery !== trimmedQuery) {

        return;
      }
      
      // 在防抖定时器触发时清空结果，而不是在输入时清空
      // 使用 startTransition 包装清空操作，避免阻塞后续的输入
      if (trimmedQuery !== lastSearchQueryRef.current) {
        startTransition(() => {
          setFilteredApps([]);
          setFilteredFiles([]);
          setFilteredMemos([]);
          setFilteredPlugins([]);
          setEverythingResults([]);
          setEverythingTotalCount(null);
          setEverythingCurrentCount(0);
          setDirectPathResult(null);
        });
        hasResultsRef.current = false;
      }
      
      // Extract URLs from query（移到防抖内部，避免每次输入都执行）
      // 使用 startTransition 包装，避免阻塞后续的输入
      startTransition(() => {
        const urls = extractUrls(query);
        setDetectedUrls(urls);
        
        // Extract email addresses from query（移到防抖内部）
        const emails = extractEmails(query);
        setDetectedEmails(emails);
        
        // Check if query is valid JSON（移到防抖内部）
        if (isValidJson(query)) {
          setDetectedJson(query.trim());
        } else {
          setDetectedJson(null);
        }
      });
      
      const isPathQuery = isLikelyAbsolutePath(trimmedQuery);
      
      // 检查是否已有相同查询的活跃会话（快速检查，避免重复搜索）
      const hasActiveSession = pendingSessionIdRef.current && currentSearchQueryRef.current === trimmedQuery;
      // 使用 ref 而不是直接读取状态，避免触发不必要的重新渲染
      const hasResults = hasResultsRef.current;
      
      // 如果已有相同查询的活跃会话且有结果，跳过重复搜索
      if (hasActiveSession && hasResults) {

        return;
      }
      
      // 如果查询不同，关闭旧会话（不阻塞，异步执行）
      if (pendingSessionIdRef.current && currentSearchQueryRef.current !== trimmedQuery) {

        const oldSessionId = pendingSessionIdRef.current;
        // 不阻塞等待，立即开始新搜索
        closeSessionSafe(oldSessionId).catch(() => {

        });
        pendingSessionIdRef.current = null;
        currentSearchQueryRef.current = "";
        displayedSearchQueryRef.current = "";
      }
      
      // 如果会话存在但结果为空，说明结果被清空了，需要重新搜索
      if (hasActiveSession && !hasResults) {

        // 重置会话状态，强制重新搜索
        const oldSessionId = pendingSessionIdRef.current;
        if (oldSessionId) {
          closeSessionSafe(oldSessionId).catch(() => {

          });
        }
        pendingSessionIdRef.current = null;
        currentSearchQueryRef.current = "";
        displayedSearchQueryRef.current = "";
      }
      
      // 标记当前查询为已搜索
      lastSearchQueryRef.current = trimmedQuery;

      
      // 处理绝对路径查询
      if (isPathQuery) {
        handleDirectPathLookup(trimmedQuery);
        // 绝对路径查询不需要 Everything 结果
        setEverythingResults([]);
        setEverythingTotalCount(null);
        setEverythingCurrentCount(0);
        setIsSearchingEverything(false);
        hasResultsRef.current = false;
        // 关闭当前会话
        const oldSessionId = pendingSessionIdRef.current;
        if (oldSessionId) {
          closeSessionSafe(oldSessionId).catch(() => {

          });
        }
        pendingSessionIdRef.current = null;
        currentSearchQueryRef.current = "";
        displayedSearchQueryRef.current = "";
      } else {
        // 使用 startTransition 包装，避免阻塞后续的输入
        startTransition(() => {
          setDirectPathResult(null);
        });
        
        // Everything 搜索立即执行，不延迟
        if (isEverythingAvailable) {

          startSearchSession(trimmedQuery).catch(() => {

          });
        }
      }
      
      // ========== 性能优化：并行执行所有搜索 ==========
      // 使用 setTimeout(0) 将搜索操作推迟到下一个事件循环，避免阻塞防抖定时器
      // 这样可以让输入框更快响应，即使搜索函数正在执行
      setTimeout(() => {
        // 系统文件夹和文件历史搜索立即执行
        Promise.all([
          searchSystemFoldersWrapper(trimmedQuery),
          searchFileHistoryWrapper(trimmedQuery),
        ]).catch((error) => {
          console.error("[搜索错误] 并行搜索失败:", error);
        });
        
        // 应用搜索延迟1秒执行，避免阻塞其他搜索
        // setTimeout(() => {
        //   searchApplicationsWrapper(trimmedQuery).catch((error) => {
        //     console.error("[搜索错误] 应用搜索失败:", error);
        //   });
        // }, 51000);
        
        console.log(`[搜索流程] 准备调用 searchApplications: query="${trimmedQuery}"`);
        searchApplicationsWrapper(trimmedQuery).catch((error) => {
          console.error("[搜索错误] searchApplications 调用失败:", error);
        });
        
        // 备忘录和插件搜索是纯前端过滤，立即执行（不会阻塞）
        searchMemosWrapper(trimmedQuery);
        handleSearchPlugins(trimmedQuery);
      }, 0);
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

  // 同步更新 hasResultsRef，用于优化查询去重检查
  useEffect(() => {
    hasResultsRef.current = filteredApps.length > 0 || filteredFiles.length > 0 || filteredMemos.length > 0 || 
                             filteredPlugins.length > 0 || everythingResults.length > 0;
  }, [filteredApps, filteredFiles, filteredMemos, filteredPlugins, everythingResults]);

  const searchMemosWrapper = useCallback(async (q: string) => {
    await searchMemos(q, {
      memos,
      currentQuery: query,
      updateSearchResults,
      setFilteredMemos,
    });
  }, [memos, query, updateSearchResults]);

  const handleSearchPlugins = useCallback((q: string) => {
    // Don't search if query is empty
    if (!q || q.trim() === "") {
      updateSearchResults(setFilteredPlugins, []);
      return;
    }
    
    const filtered = searchPlugins(q);
    
    // Only update if query hasn't changed
    if (query.trim() === q.trim()) {
      updateSearchResults(setFilteredPlugins, filtered.map(p => ({ id: p.id, name: p.name, description: p.description })));
    } else {
      updateSearchResults(setFilteredPlugins, []);
    }
  }, [query, updateSearchResults]);


  // 处理绝对路径直达：存在则生成一个临时文件结果，减少 Everything/系统目录压力
  const handleDirectPathLookup = useCallback(async (rawPath: string) => {
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
  }, [query]);


  // Combine apps, files, Everything results, and URLs into results when they change
  // 使用 useState + useEffect 替代 useMemo，在 useEffect 中使用 startTransition 异步计算
  // 这样可以避免 useMemo 的同步计算阻塞输入响应
  const [combinedResultsRaw, setCombinedResultsRaw] = useState<SearchResult[]>([]);
  
  useEffect(() => {
    // 使用 requestIdleCallback 或 setTimeout 延迟计算，避免阻塞输入响应
    // 这样可以让输入框保持响应，不会因为结果计算而卡顿
    const scheduleCompute = () => {
      // 使用 startTransition 标记状态更新为非紧急更新
      startTransition(() => {
        const results = computeCombinedResults({
          query,
          aiAnswer,
          filteredApps,
          filteredFiles,
          filteredMemos,
          systemFolders,
          everythingResults,
          filteredPlugins,
          detectedUrls,
          detectedEmails,
          detectedJson,
          directPathResult,
          openHistory,
          urlRemarks,
          searchEngines,
          apps,
          extractedFileIconsRef,
        });
        setCombinedResultsRaw(results);
      });
    };
    
    // 使用 requestIdleCallback 或 setTimeout 延迟计算，避免阻塞输入响应
    if (window.requestIdleCallback) {
      window.requestIdleCallback(scheduleCompute, { timeout: 100 });
    } else {
      setTimeout(scheduleCompute, 0);
    }
  }, [filteredApps, filteredFiles, filteredMemos, filteredPlugins, everythingResults, detectedUrls, detectedEmails, detectedJson, openHistory, urlRemarks, query, aiAnswer, searchEngines, systemFolders, directPathResult, apps, extractedFileIconsRef]);

  // 使用 useDeferredValue 延迟 combinedResults 的更新，让输入框保持响应
  // 当用户快速输入时，React 会延迟更新 combinedResults，优先处理输入事件
  // 这样可以避免 combinedResults 的耗时计算（66-76ms）阻塞输入响应
  const combinedResults = useDeferredValue(combinedResultsRaw);
  
  // 防抖延迟更新 debouncedCombinedResults，避免多个搜索结果异步返回时频繁重新排序
  const [debouncedCombinedResults, setDebouncedCombinedResults] = useState<SearchResult[]>([]);
  
  useEffect(() => {
    // 清除之前的定时器
    if (combinedResultsUpdateTimeoutRef.current !== null) {
      clearTimeout(combinedResultsUpdateTimeoutRef.current);
      combinedResultsUpdateTimeoutRef.current = null;
    }
    
    // 优化：如果有应用搜索结果，立即更新（0ms延迟），让应用列表快速显示
    // 如果没有应用搜索结果，使用5ms延迟等待其他搜索结果
    const delay = filteredApps.length > 0 ? 0 : 5;
    
    combinedResultsUpdateTimeoutRef.current = setTimeout(() => {
      // 使用 startTransition 标记结果更新为非紧急更新
      // 这样可以让输入框保持响应，不会因为结果列表更新而卡顿
      startTransition(() => {
        setDebouncedCombinedResults(combinedResults);
        // 更新 debouncedResultsQueryRef 为当前查询，用于验证结果是否与当前查询匹配
        debouncedResultsQueryRef.current = queryRef.current;
      });
    }, delay) as unknown as number;
    
    return () => {
      if (combinedResultsUpdateTimeoutRef.current !== null) {
        clearTimeout(combinedResultsUpdateTimeoutRef.current);
        combinedResultsUpdateTimeoutRef.current = null;
      }
    };
  }, [combinedResults, filteredApps.length]);

  // 使用 ref 来跟踪当前的 query，避免闭包问题
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);


  // 使用 ref 跟踪最后一次加载结果时的查询，用于验证结果是否仍然有效
  const lastLoadQueryRef = useRef<string>("");
  // 使用 ref 跟踪 debouncedCombinedResults 对应的查询，用于验证结果是否与当前查询匹配
  const debouncedResultsQueryRef = useRef<string>("");
  
  // 分批加载结果的函数
  const loadResultsIncrementallyWrapper = useCallback((allResults: SearchResult[]) => {
    loadResultsIncrementally({
      allResults,
      currentQuery: queryRef.current,
      openHistory,
      setResults,
      setHorizontalResults,
      setVerticalResults,
      setSelectedHorizontalIndex,
      setSelectedVerticalIndex,
      queryRef,
      lastLoadQueryRef,
      incrementalLoadRef,
      incrementalTimeoutRef,
      currentLoadResultsRef,
      horizontalResultsRef,
    });
  }, [openHistory]);

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
    // 这样可以确保在 debouncedCombinedResults 更新之前，不会显示旧查询的结果
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
      // 重要：查询变化时，重置 lastLoadQueryRef 为空字符串
      // 这样 loadResultsIncrementally 第一次加载时会通过检查（因为 lastLoadQueryRef === ""）
      // 之后成功加载后，lastLoadQueryRef 会被更新为当前查询
      lastLoadQueryRef.current = "";
      // 重置 debouncedResultsQueryRef，因为 debouncedCombinedResults 现在对应的是旧查询
      debouncedResultsQueryRef.current = "";
      lastQueryInEffectRef.current = query;
    }
    // 使用分批加载来更新结果，避免一次性渲染大量DOM导致卡顿
    // 使用防抖后的结果，避免多个搜索结果异步返回时频繁重新排序
    // 重要：只有当 debouncedCombinedResults 对应的查询与当前查询匹配时才更新
    // 这样可以避免快速输入时使用过时的结果导致卡顿
    if (debouncedCombinedResults.length > 0 || query.trim() === "") {
      // 检查 debouncedCombinedResults 是否与当前查询匹配
      // 如果不匹配，说明这些结果是过时的，不应该加载
      if (debouncedResultsQueryRef.current.trim() === query.trim() || query.trim() === "") {
        loadResultsIncrementallyWrapper(debouncedCombinedResults);
      }
    }
    
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
  }, [debouncedCombinedResults, query]);

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
  }, [debouncedCombinedResults, isMemoModalOpen]);

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

  // 应用列表缓存（前端搜索使用）
  const allAppsCacheRef = useRef<AppInfo[]>([]);
  const allAppsCacheLoadedRef = useRef<boolean>(false);




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

  // 搜索系统文件夹（前端搜索，避免每次调用后端）- 异步分批处理，避免阻塞UI
  const searchSystemFoldersWrapper = useCallback(async (searchQuery: string) => {
    await searchSystemFolders(searchQuery, {
      currentQuery: query,
      updateSearchResults,
      setSystemFolders,
      systemFoldersListRef,
      systemFoldersListLoadedRef,
    });
  }, [query, updateSearchResults]);


  // 主搜索函数：优先使用前端搜索，如果缓存未加载则回退到后端搜索
  const searchApplicationsWrapper = useCallback(async (searchQuery: string) => {
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
  }, [query, updateSearchResults, apps, filterWindowsApps]);

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

          // 同时更新 apps 状态和缓存中的图标
          setApps((prevApps) => {
            const updatedApps = prevApps.map((app) => {
              const iconUpdate = iconUpdates.find(([path]) => path === app.path);
              if (iconUpdate) {
                return { ...app, icon: iconUpdate[1] };
              }
              return app;
            });
            // 同步更新缓存
            allAppsCacheRef.current = updatedApps;
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


  const searchFileHistoryWrapper = useCallback(async (searchQuery: string) => {
    await searchFileHistory(searchQuery, {
      currentQuery: query,
      updateSearchResults,
      setFilteredFiles,
      allFileHistoryCacheRef,
      allFileHistoryCacheLoadedRef,
      extractedFileIconsRef,
      apps,
    });
  }, [query, updateSearchResults, apps]);


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
        startTransition(() => {
          setEverythingResults([]);
          setEverythingTotalCount(null);
          setEverythingCurrentCount(0);
          setIsSearchingEverything(false);
        });
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
        startTransition(() => {
          setEverythingResults([]);
          setEverythingTotalCount(null);
          setEverythingCurrentCount(0);
          setIsSearchingEverything(false);
        });
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

            // 更新结果（使用 startTransition 避免阻塞输入框）
            startTransition(() => {
              setEverythingResults(res.items);
              setEverythingCurrentCount(res.items.length);
              setIsSearchingEverything(false);
            });
            displayedSearchQueryRef.current = trimmed;
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
            
            startTransition(() => {
              setEverythingResults([]);
              setEverythingTotalCount(null);
              setEverythingCurrentCount(0);
              setIsSearchingEverything(false);
            });
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
        
        startTransition(() => {
          setEverythingResults([]);
          setEverythingTotalCount(null);
          setEverythingCurrentCount(0);
          setIsSearchingEverything(false);
        });
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

      setIsDownloadingEverything(false);
      setEverythingDownloadProgress(0);
      const errorMessage = error instanceof Error ? error.message : String(error);
      alert(`下载失败: ${errorMessage}`);
    }
  }, []);

  const handleLaunch = useCallback(async (result: SearchResult) => {
    try {
      // 统一更新使用历史记录（所有类型统一处理）
      const pathToUpdate = result.path;
      const timestampToUpdate = Date.now() / 1000;
      
      // 判断是否需要更新历史记录
      const shouldUpdateHistory = (): boolean => {
        if (!pathToUpdate) return false;
        
        const pathLower = pathToUpdate.toLowerCase();
        
        // 跳过不需要更新的类型
        if (result.type === "ai" || result.type === "email" || 
            result.type === "json_formatter" || result.type === "history" || 
            result.type === "settings" || result.type === "memo" || 
            result.type === "plugin") {
          return false;
        }
        
        // 对于应用类型，只更新实际文件路径（.exe, .lnk），跳过 UWP 应用和 Recent 文件夹
        if (result.type === "app") {
          const isRealFilePath = pathLower.endsWith('.exe') || pathLower.endsWith('.lnk');
          const isRecentFolder = pathLower.includes('\\recent\\') || pathLower.includes('/recent/');
          return isRealFilePath && !isRecentFolder;
        }
        
        // 其他类型（file、everything、url）都更新
        return true;
      };
      
      // 如果需要更新，统一处理
      if (shouldUpdateHistory()) {
        // 更新 openHistory 状态（用于排序和显示）
        setOpenHistory(prev => ({
          ...prev,
          [pathToUpdate]: timestampToUpdate,
        }));
        
        // 更新前端文件历史缓存（乐观更新）
        const normalizePathForMatch = (path: string) => {
          return path.trim().replace(/[\\/]+$/, '');
        };
        const normalizedPath = normalizePathForMatch(pathToUpdate);
        
        const existingItem = allFileHistoryCacheRef.current.find(item => {
          const itemNormalized = normalizePathForMatch(item.path);
          const path1 = normalizePathForHistory(itemNormalized);
          const path2 = normalizePathForHistory(normalizedPath);
          return path1 === path2;
        });
        
        if (existingItem) {
          // 更新现有项的时间戳（使用次数由后端更新，避免重复计数）
          existingItem.last_used = timestampToUpdate;
          // 注意：不在这里手动增加 use_count，由后端 addFileToHistory 统一处理
          
          // 立即更新 filteredFiles 状态的时间戳（使用次数会在后端更新后通过 refreshFileHistoryCache 同步）
          setFilteredFiles(prevFiles => {
            return prevFiles.map(file => {
              const fileNormalized = normalizePathForMatch(file.path);
              const filePath1 = normalizePathForHistory(fileNormalized);
              const filePath2 = normalizePathForHistory(normalizedPath);
              if (filePath1 === filePath2) {
                return {
                  ...file,
                  last_used: timestampToUpdate,
                  // use_count 不在这里更新，等待后端更新后通过 refreshFileHistoryCache 同步
                };
              }
              return file;
            });
          });
        } else {
          // 添加新项到前端缓存（use_count 由后端决定，这里先设为0，等待后端更新）
          let name: string;
          if (result.type === "url" && result.url) {
            // URL类型：提取域名作为名称
            try {
              const urlObj = new URL(result.url);
              name = urlObj.hostname || result.url;
            } catch {
              name = result.url;
            }
          } else {
            // 文件类型：提取文件名
            name = normalizedPath.split(/[\\/]/).pop() || normalizedPath;
          }
          
          allFileHistoryCacheRef.current.push({
            path: normalizedPath,
            name,
            last_used: timestampToUpdate,
            use_count: 0, // 先设为0，等待后端 addFileToHistory 更新后通过 refreshFileHistoryCache 同步
            is_folder: result.type === "url" ? false : undefined,
          });
        }
        allFileHistoryCacheLoadedRef.current = true;
        
        // 异步更新后端数据库，不阻塞应用启动
        console.log(`[统一更新] 准备更新 open_history: ${pathToUpdate}, 类型: ${result.type}`);
        void tauriApi.addFileToHistory(pathToUpdate)
          .then(() => {
            console.log(`[统一更新] ✓ 成功更新 open_history: ${pathToUpdate}`);
            // 刷新文件历史缓存以确保与数据库同步（包括使用次数）
            void refreshFileHistoryCache().then(() => {
              // 如果当前有查询，重新搜索以更新结果列表中的使用次数
              if (query.trim()) {
                void searchFileHistoryWrapper(query);
              }
            });
          })
          .catch((error) => {
            console.warn(`[统一更新] ✗ 更新 open_history 失败: ${pathToUpdate}`, error);
            // 如果后端更新失败，回滚前端缓存（重新从数据库加载）
            void refreshFileHistoryCache();
          });
      }

      // 对所有结果统一提前处理 http/https 链接，避免走文件/应用启动流程
      const pathLower = result.path?.toLowerCase() || "";
      if (/^https?:\/\//.test(pathLower)) {
        await tauriApi.openUrl(result.path);
        await hideLauncherAndResetState();
        return;
      }
      
      // 注意：历史记录的更新已在开头统一处理，各类型不再单独更新

      if (result.type === "ai" && result.aiAnswer) {
        // AI 回答点击时，可以复制到剪贴板或什么都不做
        // 这里暂时不做任何操作，只是显示结果
        return;
      } else if (result.type === "url" && result.url) {
        await tauriApi.openUrl(result.url);
        // 注意：历史记录的更新已在开头统一处理
        await hideLauncherAndResetState();
        return;
      } else if (result.type === "search") {
        // 处理搜索类型：打开浏览器进行搜索
        await tauriApi.openUrl(result.path);
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
        // 保存待处理的内容，等待窗口准备好事件
        pendingJsonContentRef.current = result.jsonContent;
        
        // 打开窗口（如果窗口已存在，会立即收到 ready 事件；如果是新窗口，会在组件挂载后收到 ready 事件）
        await tauriApi.showJsonFormatterWindow();
        
        // 关闭启动器
        await hideLauncherAndResetState();
        return;
      } else if (result.type === "history") {
        // 打开历史访问窗口
        await tauriApi.showShortcutsConfig();
        // 不关闭启动器，让用户查看历史访问
        return;
      } else if (result.type === "settings") {
        // 打开应用中心并导航到设置页面
        try {
          // 设置标志，让应用中心窗口加载时自动跳转到设置页面
          localStorage.setItem("appcenter:last-category", "settings");
          // 先隐藏启动器
          await tauriApi.hideLauncher();
          // 打开应用中心窗口
          await tauriApi.showPluginListWindow();
        } catch (error) {
          console.error("Failed to open app center:", error);
          alert("打开应用中心失败，请重试（详情见控制台日志）");
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
          
          // 注意：open_history 的更新已经在 handleLaunch 开头处理了，这里不需要重复更新
          
          // 清除启动状态
          setLaunchingAppPath(null);
        } catch (launchError: any) {
          // 如果启动失败，清除启动状态
          setLaunchingAppPath(null);
          // 注意：open_history 的更新已经在 handleLaunch 开头处理了，这里不需要重复更新
          const errorMsg = launchError?.message || launchError?.toString() || "";
          // 检测是否是文件不存在的错误，自动删除索引
          if (
            errorMsg.includes("快捷方式文件不存在") ||
            errorMsg.includes("快捷方式目标不存在") ||
            errorMsg.includes("应用程序未找到")
          ) {
            try {
              const pathToRemove = result.app.path;
              
              console.log(`[删除应用] ========== 开始删除流程 ==========`);
              console.log(`[删除应用] 要删除的路径: ${pathToRemove}`);
              
              // 并行执行删除操作（应用索引 + 打开历史）
              await Promise.all([
                tauriApi.removeAppFromIndex(pathToRemove),
                tauriApi.deleteFileHistory(pathToRemove).catch(() => {
                  // open_history 中可能不存在该记录，忽略错误
                  console.log(`[清理] open_history 中没有该路径记录: ${pathToRemove}`);
                }),
              ]);
              
              console.log(`[删除应用] 后端删除完成`);
              
              // 规范化路径用于比较（Windows 路径不区分大小写，统一反斜杠）
              const normalizedPathToRemove = pathToRemove.toLowerCase().replace(/\//g, '\\');
              console.log(`[删除应用] 规范化后的路径: ${normalizedPathToRemove}`);
              
              // 立即从本地状态和显示结果中移除已删除的应用（使用规范化比较）
              setApps((prevApps) => {
                console.log(`[删除应用] setApps 被调用，当前 apps 数量: ${prevApps.length}`);
                const filtered = prevApps.filter((app) => {
                  const normalizedAppPath = app.path.toLowerCase().replace(/\//g, '\\');
                  const shouldKeep = normalizedAppPath !== normalizedPathToRemove;
                  if (!shouldKeep) {
                    console.log(`[删除应用] 从 apps 中找到并删除: ${app.path}`);
                  }
                  return shouldKeep;
                });
                console.log(`[删除应用] setApps 过滤后数量: ${filtered.length}`);
                return filtered;
              });
              
              setFilteredApps((prevFiltered) => {
                console.log(`[删除应用] setFilteredApps 被调用，当前 filteredApps 数量: ${prevFiltered.length}`);
                console.log(`[删除应用] 当前 filteredApps 内容:`, prevFiltered.map(a => `${a.name} (${a.path})`));
                
                const filtered = prevFiltered.filter((app) => {
                  const normalizedAppPath = app.path.toLowerCase().replace(/\//g, '\\');
                  const shouldKeep = normalizedAppPath !== normalizedPathToRemove;
                  
                  console.log(`[删除应用] 检查项: ${app.name}`);
                  console.log(`[删除应用]   - 原始路径: ${app.path}`);
                  console.log(`[删除应用]   - 规范化路径: ${normalizedAppPath}`);
                  console.log(`[删除应用]   - 是否保留: ${shouldKeep}`);
                  
                  if (!shouldKeep) {
                    console.log(`[删除应用] ✅ 从 filteredApps 中找到并删除: ${app.path}`);
                  }
                  return shouldKeep;
                });
                
                console.log(`[删除应用] setFilteredApps 过滤后数量: ${filtered.length}`);
                console.log(`[删除应用] 过滤后 filteredApps 内容:`, filtered.map(a => `${a.name} (${a.path})`));
                return filtered;
              });
              
              // ⭐ 关键修复：同时从 filteredFiles 中删除（文件历史中的 .lnk 文件）
              setFilteredFiles((prevFiltered) => {
                console.log(`[删除应用] setFilteredFiles 被调用，当前 filteredFiles 数量: ${prevFiltered.length}`);
                
                const filtered = prevFiltered.filter((file) => {
                  const normalizedFilePath = file.path.toLowerCase().replace(/\//g, '\\');
                  const shouldKeep = normalizedFilePath !== normalizedPathToRemove;
                  
                  if (!shouldKeep) {
                    console.log(`[删除应用] ✅ 从 filteredFiles 中找到并删除: ${file.path}`);
                  }
                  return shouldKeep;
                });
                
                console.log(`[删除应用] setFilteredFiles 过滤后数量: ${filtered.length}`);
                return filtered;
              });
              
              // 同时从文件历史缓存中移除（如果存在）
              const beforeCount = allFileHistoryCacheRef.current.length;
              allFileHistoryCacheRef.current = allFileHistoryCacheRef.current.filter((item) => {
                const normalizedItemPath = item.path.toLowerCase().replace(/\//g, '\\');
                return normalizedItemPath !== normalizedPathToRemove;
              });
              const afterCount = allFileHistoryCacheRef.current.length;
              console.log(`[删除应用] 文件历史缓存: ${beforeCount} -> ${afterCount}`);
              
              // 显示提示信息（立即显示，让用户看到立即的反馈）
              setErrorMessage(`${errorMsg}\n\n已自动删除该无效索引。`);
              console.log(`[删除应用] ========== 删除流程完成，弹窗已显示 ==========`);
              
              // 注意：不需要后台刷新搜索，因为：
              // 1. 我们已经手动从 filteredApps 中删除了该项（上面的 setFilteredApps）
              // 2. 后端也已经删除了（通过 Promise.all 等待完成）
              // 3. 下次用户主动搜索时会自动从后端获取最新数据
              // 如果这里立即调用 searchApplications，可能会在 React 渲染之前覆盖我们的手动更新
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
          // 注意：历史记录的更新已在开头统一处理，launchFile 不再更新历史记录
          await tauriApi.launchFile(result.file.path);
          
          // 刷新文件历史缓存以同步后端更新后的数据（包括使用次数）
          void refreshFileHistoryCache()
            .then(() => {
              // 如果当前有查询，重新搜索以更新结果列表
              if (query.trim()) {
                void searchFileHistoryWrapper(query);
              }
            })
            .catch((error) => {
              console.warn(`[文件打开] ✗ 刷新 open_history 缓存失败: ${result.file?.path || '未知路径'}`, error);
            });
        } catch (fileError: any) {
          const errorMsg = fileError?.message || fileError?.toString() || "";
          // 检测是否是文件不存在的错误，自动删除历史记录
          if (errorMsg.includes("Path not found") || errorMsg.includes("not found")) {
            const filePath = result.file?.path;
            if (filePath) {
              try {
                // 自动删除无效的历史记录
                await tauriApi.deleteFileHistory(filePath);
                // 刷新文件历史缓存
                await refreshFileHistoryCache();
                // 重新搜索以更新结果列表
                if (query.trim()) {
                  await searchFileHistoryWrapper(query);
                } else {
                  await searchFileHistoryWrapper("");
                }
                // 显示提示信息
                setErrorMessage(`文件不存在：${filePath}\n\n已自动从历史记录中删除该文件。`);
              } catch (deleteError: any) {
                console.error("Failed to delete file history:", deleteError);
                // 如果删除失败，仍然显示原始错误
                setErrorMessage(`文件不存在：${filePath}\n\n错误：${errorMsg}`);
              }
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
          const everythingPath = result.everything.path;

          // 如果 Everything 返回的是以 http/https 开头的链接，作为 URL 处理，走浏览器打开
          if (everythingPath && /^https?:\/\//i.test(everythingPath)) {
            await tauriApi.openUrl(everythingPath);
            // 打开链接后直接隐藏启动器，不再走后续文件历史逻辑
            await hideLauncherAndResetState();
            return;
          }

          // 注意：历史记录的更新已在开头统一处理，launchFile 不再更新历史记录
          await tauriApi.launchFile(everythingPath);
          
          // 刷新文件历史缓存以确保与数据库同步
          void refreshFileHistoryCache()
            .then(() => {
              // 如果当前有查询，重新搜索以更新结果列表
              if (query.trim()) {
                void searchFileHistoryWrapper(query);
              }
            })
            .catch((error) => {
              console.warn(`[Everything 文件打开] ✗ 刷新 open_history 缓存失败: ${everythingPath}`, error);
            });
        } catch (fileError: any) {
          const errorMsg = fileError?.message || fileError?.toString() || "";
          // 检测是否是文件不存在的错误
          if (errorMsg.includes("Path not found") || errorMsg.includes("not found")) {
            const everythingPath = result.everything?.path || "未知路径";
            setErrorMessage(`文件不存在：${everythingPath}`);
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
      
      // 注意：openHistory 的更新已经在 handleLaunch 开头处理了，这里不需要重复更新
      
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
  }, [query, refreshFileHistoryCache, searchFileHistory, hideLauncherAndResetState, setOpenHistory, setErrorMessage, errorMessage, setQuery, setSelectedIndex, setContextMenu, executePlugin, filteredFiles, allFileHistoryCacheRef, tauriApi]);

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
                await searchFileHistoryWrapper(query);
              } else {
                await searchFileHistoryWrapper("");
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

  const handleDeleteHistory = useCallback(async (key: string) => {
    try {
      await tauriApi.deleteOpenHistory(key);
      // 重新加载 open history
      const history = await tauriApi.getOpenHistory();
      setOpenHistory(history);
      // 删除备注
      setUrlRemarks(prev => {
        const newRemarks = { ...prev };
        delete newRemarks[key];
        return newRemarks;
      });
      // combinedResults 会自动使用新的 openHistory，所以结果列表会自动更新
    } catch (error) {
      console.error("Failed to delete open history:", error);
      throw error;
    }
  }, [setOpenHistory]);

  const handleEditRemark = useCallback(async (url: string) => {
    try {
      // 获取当前的备注（存储在 name 字段中）
      const item = await tauriApi.getOpenHistoryItem(url);
      setEditingRemarkUrl(url);
      setRemarkText(item?.name || "");
      setIsRemarkModalOpen(true);
    } catch (error) {
      console.error("Failed to get open history item:", error);
      alert(`获取备注失败: ${error}`);
    }
  }, []);

  const handleSaveRemark = useCallback(async () => {
    if (!editingRemarkUrl) return;
    try {
      const remark = remarkText.trim() || null;
      const updatedItem = await tauriApi.updateOpenHistoryRemark(editingRemarkUrl, remark);
      // 更新本地备注状态（备注存储在 name 字段中）
      setUrlRemarks(prev => {
        const newRemarks = { ...prev };
        if (updatedItem.name) {
          newRemarks[editingRemarkUrl] = updatedItem.name;
        } else {
          delete newRemarks[editingRemarkUrl];
        }
        return newRemarks;
      });
      // 刷新 openHistory 以更新时间戳
      const history = await tauriApi.getOpenHistory();
      setOpenHistory(history);
      setIsRemarkModalOpen(false);
      setEditingRemarkUrl(null);
      setRemarkText("");
    } catch (error) {
      console.error("Failed to update remark:", error);
      alert(`保存备注失败: ${error}`);
    }
  }, [editingRemarkUrl, remarkText]);

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
          const searchResults = await searchFileHistoryFrontend(trimmedPath, allFileHistoryCacheRef.current);
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
      // 如果右键菜单已打开，优先关闭右键菜单
      if (contextMenu) {
        setContextMenu(null);
        return;
      }
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
      // 如果备注弹窗已打开，只关闭备注弹窗，不关闭启动器
      if (isRemarkModalOpen) {
        setIsRemarkModalOpen(false);
        setEditingRemarkUrl(null);
        setRemarkText("");
        return;
      }
      await hideLauncherAndResetState({ resetMemo: true });
      return;
    }

    // 处理退格键删除粘贴的图片
    if (e.key === "Backspace") {
      // 如果输入框为空且有粘贴的图片，则删除图片预览
      if (query === "" && pastedImageDataUrl) {
        e.preventDefault();
        setPastedImageDataUrl(null);
        setPastedImagePath(null);
        // 清除搜索结果
        clearAllResults({
          setResults,
          setHorizontalResults,
          setVerticalResults,
          setSelectedHorizontalIndex,
          setSelectedVerticalIndex,
          horizontalResultsRef,
          currentLoadResultsRef
        });
        return;
      }
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
                  onCompositionUpdate={(e) => {
                    // 输入法组合输入更新中，立即同步输入框的实际值到状态
                    // 使用 flushSync 确保立即更新，避免状态延迟导致的字符丢失
                    // 这是关键：必须立即同步，否则 React 会用旧状态覆盖输入框
                    const currentValue = e.currentTarget.value;
                    flushSync(() => {
                      setQuery(currentValue);
                    });
                  }}
                  onCompositionEnd={(e) => {
                    // 输入法组合输入结束，更新状态
                    // 确保最终状态与输入框值一致
                    const finalValue = e.currentTarget.value;
                    flushSync(() => {
                      setQuery(finalValue);
                    });
                  }}
                  onChange={(e) => {
                    // 检查是否是输入法组合输入事件
                    // 只使用原生事件的 isComposing 属性来判断，更可靠
                    const nativeEvent = e.nativeEvent as InputEvent;
                    
                    // 如果正在进行输入法组合输入，忽略 onChange 事件
                    // 避免在组合输入过程中重复更新状态，导致字符重复
                    // 组合输入会在 onCompositionUpdate 和 onCompositionEnd 时更新
                    if (nativeEvent.isComposing === true) {
                      return;
                    }
                    // 使用 startTransition 标记 setQuery 为非紧急更新
                    // 这样 React 会优先处理输入事件，延迟处理状态更新和相关的计算
                    // 这样可以避免 combinedResults 的耗时计算（100-130ms）阻塞输入响应
                    startTransition(() => {
                      setQuery(e.target.value);
                    });
                  }}
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
                                title={result.type === "app" ? result.path : undefined}
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
                  title={result.type === "app" ? result.path : undefined}
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
                      {result.type === "file" && result.file && (() => {
                        // 获取最近使用时间（优先使用 openHistory 最新数据，否则使用 file.last_used）
                        // openHistory 存储的是秒级时间戳，需要转换为毫秒；file.last_used 也是秒级时间戳
                        const lastUsed = (openHistory[result.path] || result.file?.last_used || 0) * 1000;
                        const useCount = result.file.use_count || 0;
                        
                        // 只有在有使用记录（使用次数 > 0 或最后使用时间 > 0）时才显示
                        if (useCount === 0 && lastUsed === 0) {
                          return null;
                        }
                        
                        return (
                          <div
                            className={`text-xs mt-0.5 ${theme.usageText(isSelected)}`}
                          >
                            {useCount > 0 && `使用 ${useCount} 次`}
                            {useCount > 0 && lastUsed > 0 && <span className="mx-1">·</span>}
                            {lastUsed > 0 && <span>{formatLastUsedTime(lastUsed)}</span>}
                          </div>
                        );
                      })()}
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
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          <span
                            className={`text-xs px-2.5 py-1 rounded-md font-medium transition-all ${theme.tag("url", isSelected)}`}
                            title="URL 历史记录"
                          >
                            URL 历史
                          </span>
                          {result.url && urlRemarks[result.url] && (
                            <span
                              className={`text-xs px-2 py-1 rounded-md ${theme.metaText(isSelected)} bg-gray-100`}
                              title={`备注: ${urlRemarks[result.url]}`}
                            >
                              📝 {urlRemarks[result.url]}
                            </span>
                          )}
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
          {!showAiAnswer && results.length === 0 && query && (
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

          {!showAiAnswer && results.length === 0 && !query && (
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
              const isUpdateNotice = target.closest('[data-update-notice]');
              if (isButton || isUpdateNotice) {
                // 如果是按钮或更新提示，阻止事件冒泡到 header，让其自己的 onClick 处理
                e.stopPropagation();
              }
            }}
          >
            <div className="flex items-center gap-3 min-w-0 flex-1">
              {!showAiAnswer && results.length > 0 && <span className="whitespace-nowrap">{results.length} 个结果</span>}
              {showAiAnswer && <span className="whitespace-nowrap">AI 回答模式</span>}
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <div 
                  className="flex items-center gap-1.5 cursor-help whitespace-nowrap" 
                  title={everythingPath ? `Everything 路径: ${everythingPath}` : 'Everything 未安装或未在 PATH 中'}
                >
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isEverythingAvailable ? 'bg-emerald-500' : 'bg-gray-300'}`}></div>
                  <span className={`text-xs ${isEverythingAvailable ? 'text-emerald-600' : 'text-gray-500'}`}>
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
                        ref={downloadButtonRef}
                        onPointerDown={() => {}}
                        onClick={(e) => {

                          if (!isDownloadingEverything) {

                            e.preventDefault();
                            e.stopPropagation();
                            handleDownloadEverything().catch(() => {

                            });
                          } else {

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
                {/* 更新提示 - 放在按钮后面 */}
                {updateInfo?.has_update && (
                  <div 
                    data-update-notice
                    className="flex items-center gap-1.5 cursor-pointer whitespace-nowrap hover:opacity-80 transition-opacity" 
                    title={`发现新版本 ${updateInfo.latest_version}，点击查看详情`}
                    onClick={async (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      try {
                        console.log("点击更新提示，准备打开应用中心窗口");
                        // 设置标志，让应用中心窗口加载时自动跳转到关于页面
                        localStorage.setItem("appcenter:open-to-about", "true");
                        // 先隐藏启动器
                        await tauriApi.hideLauncher();
                        console.log("启动器已隐藏");
                        // 打开独立的应用中心窗口
                        await tauriApi.showPluginListWindow();
                        console.log("应用中心窗口已打开");
                      } catch (error) {
                        console.error("Failed to open app center window:", error);
                      }
                    }}
                  >
                    <div className="w-2 h-2 rounded-full flex-shrink-0 bg-orange-500 animate-pulse"></div>
                    <span className="text-xs text-orange-600 font-medium">
                      发现新版本 {updateInfo.latest_version}
                    </span>
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
        onDeleteHistory={handleDeleteHistory}
        onEditRemark={handleEditRemark}
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

      {/* Remark Edit Modal */}
      {isRemarkModalOpen && editingRemarkUrl && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={() => setIsRemarkModalOpen(false)}>
          <div className="bg-white rounded-lg shadow-xl p-4 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold mb-3">修改备注</h2>
            <div className="mb-3">
              <div className="text-xs text-gray-600 mb-1">URL:</div>
              <div className="text-xs text-gray-800 break-all mb-3">{editingRemarkUrl}</div>
              <label className="block text-xs font-medium text-gray-700 mb-1">备注:</label>
              <textarea
                value={remarkText}
                onChange={(e) => setRemarkText(e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none text-sm"
                rows={3}
                placeholder="输入备注信息..."
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsRemarkModalOpen(false);
                    setEditingRemarkUrl(null);
                    setRemarkText("");
                  } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    handleSaveRemark();
                  }
                }}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setIsRemarkModalOpen(false);
                  setEditingRemarkUrl(null);
                  setRemarkText("");
                }}
                className="px-3 py-1.5 text-xs text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSaveRemark}
                className="px-3 py-1.5 text-xs text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

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
