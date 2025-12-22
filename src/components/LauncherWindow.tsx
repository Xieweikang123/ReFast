import { useState, useEffect, useRef, useMemo, useCallback, startTransition, useDeferredValue } from "react";
import { flushSync } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { tauriApi } from "../api/tauri";
import type { AppInfo, FileHistoryItem, EverythingResult, MemoItem, PluginContext, UpdateCheckResult, SearchEngineConfig } from "../types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/window";
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
  formatLastUsedTime,
} from "../utils/launcherUtils";
import { getThemeConfig, getLayoutConfig, type ResultStyle } from "../utils/themeConfig";
import { handleEscapeKey, closePluginModalAndHide, closeMemoModalAndHide } from "../utils/launcherHandlers";
import { clearAllResults, loadResultsIncrementally } from "../utils/resultUtils";
import { getMainContainer as getMainContainerUtil } from "../utils/windowUtils";
import { searchMemos, searchSystemFolders, searchApplications, searchFileHistory } from "../utils/searchUtils";
import type { SearchResult } from "../utils/resultUtils";
import { askOllama } from "../utils/ollamaUtils";
import { computeCombinedResults } from "../utils/combineResultsUtils";
import { handleLaunch as handleLaunchUtil } from "../utils/launchUtils";
import {
  startEverythingSearchSession,
  closeEverythingSession,
  checkEverythingStatus,
  startEverythingService,
  downloadEverythingInstaller,
} from "../utils/everythingUtils";
import { useLauncherInitialization } from "../hooks/useLauncherInitialization";
import { useWindowSizeAdjustment } from "../hooks/useWindowSizeAdjustment";
import { useSystemFoldersInitialization } from "../hooks/useSystemFoldersInitialization";
import { useAppIconsListener } from "../hooks/useAppIconsListener";
import {
  processPastedPath as processPastedPathUtil,
  handlePaste as handlePasteUtil,
  saveImageToDownloads,
} from "../utils/pasteUtils";
import {
  handleContextMenuWithResult,
  revealInFolder as revealInFolderUtil,
  deleteHistory as deleteHistoryUtil,
  editRemark as editRemarkUtil,
  saveRemark as saveRemarkUtil,
} from "../utils/contextMenuUtils";
import { handleKeyDown as handleKeyDownUtil } from "../utils/keyboardUtils";


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

  // 使用自定义 hook 处理窗口大小调整
  useWindowSizeAdjustment({
    shouldPreserveScrollRef,
    listRef,
    resizeRafId,
    resizeStartX,
    resizeStartWidth,
    isMemoModalOpen,
    isPluginListModalOpen,
    isResizing,
    windowWidth,
    debouncedCombinedResults,
    results,
    getMainContainer,
    setWindowWidth,
    setIsResizing,
  });

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

  // 使用自定义 hook 处理所有初始化逻辑
  useLauncherInitialization({
    setOllamaSettings,
    setResultStyle,
    setCloseOnBlur,
    setSearchEngines,
    setIsEverythingAvailable,
    setEverythingError,
    setEverythingPath,
    setEverythingVersion,
    setMemos,
    setOpenHistory,
    setUrlRemarks,
    setApps,
    setEverythingDownloadProgress,
    pendingJsonContentRef,
    allAppsCacheRef,
    allAppsCacheLoadedRef,
    allFileHistoryCacheRef,
    allFileHistoryCacheLoadedRef,
    closeOnBlurRef,
    filterWindowsApps,
    query,
    setQuery,
    setSelectedIndex,
    isDownloadingEverything,
  });

  // 系统文件夹列表（缓存，避免每次搜索都调用后端）
  const systemFoldersListRef = useRef<Array<{ name: string; path: string; display_name: string; is_folder: boolean; icon?: string; name_pinyin?: string; name_pinyin_initials?: string }>>([]);
  const systemFoldersListLoadedRef = useRef(false);

  // 使用自定义 hook 初始化系统文件夹列表
  useSystemFoldersInitialization({
    systemFoldersListRef,
    systemFoldersListLoadedRef,
  });

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

  // 使用自定义 hook 监听图标更新事件
  useAppIconsListener({
    setFilteredApps,
    setApps,
    allAppsCacheRef,
  });

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
      await closeEverythingSession({
        sessionId: id,
        pendingSessionIdRef,
        tauriApi,
      });
    },
    [tauriApi]
  );

  // 启动 Everything 搜索会话（完全复刻 EverythingSearchWindow 的模式）
  const startSearchSession = useCallback(
    async (searchQuery: string) => {
      await startEverythingSearchSession({
        searchQuery,
        isEverythingAvailable,
        setEverythingResults,
        setEverythingTotalCount,
        setEverythingCurrentCount,
        setIsSearchingEverything,
        setIsEverythingAvailable,
        setEverythingError,
        pendingSessionIdRef,
        currentSearchQueryRef,
        creatingSessionQueryRef,
        displayedSearchQueryRef,
        LAUNCHER_PAGE_SIZE,
        LAUNCHER_MAX_RESULTS,
        closeSessionSafe,
        tauriApi,
      });
    },
    [
      isEverythingAvailable,
      closeSessionSafe,
      setEverythingResults,
      setEverythingTotalCount,
      setEverythingCurrentCount,
      setIsSearchingEverything,
      setIsEverythingAvailable,
      setEverythingError,
      tauriApi,
    ]
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
    await checkEverythingStatus({
      setIsEverythingAvailable,
      setEverythingError,
      setEverythingPath,
      tauriApi,
    });
  }, [setIsEverythingAvailable, setEverythingError, setEverythingPath, tauriApi]);

  const handleStartEverything = useCallback(async () => {
    await startEverythingService({
      checkEverythingStatus: handleCheckAgain,
      tauriApi,
    });
  }, [handleCheckAgain, tauriApi]);

  const handleDownloadEverything = useCallback(async () => {
    await downloadEverythingInstaller({
      setIsDownloadingEverything,
      setEverythingDownloadProgress,
      tauriApi,
    });
  }, [setIsDownloadingEverything, setEverythingDownloadProgress, tauriApi]);

  const handleLaunch = useCallback(
    async (result: SearchResult) => {
      await handleLaunchUtil({
        result,
          query,
        setOpenHistory,
        setFilteredFiles,
        setApps,
        setFilteredApps,
        setLaunchingAppPath,
        setErrorMessage,
        setSuccessMessage,
          setIsMemoListMode,
          setSelectedMemo,
          setMemoEditTitle,
          setMemoEditContent,
          setIsEditingMemo,
        setIsMemoModalOpen,
        setQuery,
        setSelectedIndex,
        setContextMenu,
          setIsPluginListModalOpen,
        allFileHistoryCacheRef,
        allFileHistoryCacheLoadedRef,
        pendingJsonContentRef,
        hideLauncherAndResetState,
        refreshFileHistoryCache,
        searchFileHistoryWrapper,
        errorMessage,
          tauriApi,
      });
    },
    [
      query,
      refreshFileHistoryCache,
      searchFileHistoryWrapper,
      hideLauncherAndResetState,
      setOpenHistory,
      setErrorMessage,
      errorMessage,
      setQuery,
      setSelectedIndex,
      setContextMenu,
      allFileHistoryCacheRef,
      allFileHistoryCacheLoadedRef,
      pendingJsonContentRef,
      tauriApi,
    ]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, result: SearchResult) => {
      handleContextMenuWithResult({
        e,
        result,
        setContextMenu,
      });
    },
    [setContextMenu]
  );

  const handleRevealInFolder = useCallback(async () => {
    await revealInFolderUtil({
      contextMenu,
      query,
      setContextMenu,
      setErrorMessage,
      refreshFileHistoryCache,
      searchFileHistoryWrapper,
      tauriApi,
    });
  }, [
    contextMenu,
    query,
    setContextMenu,
    setErrorMessage,
    refreshFileHistoryCache,
    searchFileHistoryWrapper,
    tauriApi,
  ]);

  const handleDeleteHistory = useCallback(
    async (key: string) => {
      await deleteHistoryUtil({
        key,
        setOpenHistory,
        setUrlRemarks,
        tauriApi,
      });
    },
    [setOpenHistory, setUrlRemarks, tauriApi]
  );

  const handleEditRemark = useCallback(
    async (url: string) => {
      await editRemarkUtil({
        url,
        setEditingRemarkUrl,
        setRemarkText,
        setIsRemarkModalOpen,
        tauriApi,
      });
    },
    [setEditingRemarkUrl, setRemarkText, setIsRemarkModalOpen, tauriApi]
  );

  const handleSaveRemark = useCallback(async () => {
    await saveRemarkUtil({
      editingRemarkUrl,
      remarkText,
      setOpenHistory,
      setUrlRemarks,
      setIsRemarkModalOpen,
      setEditingRemarkUrl,
      setRemarkText,
      tauriApi,
    });
  }, [
    editingRemarkUrl,
    remarkText,
    setOpenHistory,
    setUrlRemarks,
    setIsRemarkModalOpen,
    setEditingRemarkUrl,
    setRemarkText,
    tauriApi,
  ]);

  const processPastedPath = useCallback(
    async (trimmedPath: string) => {
      await processPastedPathUtil({
        trimmedPath,
        setQuery,
        setFilteredFiles,
        allFileHistoryCacheRef,
        refreshFileHistoryCache,
        tauriApi,
      });
    },
    [
      setQuery,
      setFilteredFiles,
      allFileHistoryCacheRef,
      refreshFileHistoryCache,
      tauriApi,
    ]
  );

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      await handlePasteUtil({
        e,
        setQuery,
        setPastedImagePath,
        setPastedImageDataUrl,
        setErrorMessage,
        setFilteredFiles,
        allFileHistoryCacheRef,
        refreshFileHistoryCache,
        processPastedPath,
        tauriApi,
      });
    },
    [
      setQuery,
      setPastedImagePath,
      setPastedImageDataUrl,
      setErrorMessage,
      setFilteredFiles,
      allFileHistoryCacheRef,
      refreshFileHistoryCache,
      processPastedPath,
      tauriApi,
    ]
  );

  const handleSaveImageToDownloads = useCallback(
    async (imagePath: string) => {
      await saveImageToDownloads({
        imagePath,
        setSuccessMessage,
        setErrorMessage,
        setPastedImagePath,
        setPastedImageDataUrl,
        refreshFileHistoryCache,
        tauriApi,
      });
    },
    [
      setSuccessMessage,
      setErrorMessage,
      setPastedImagePath,
      setPastedImageDataUrl,
      refreshFileHistoryCache,
      tauriApi,
    ]
  );


  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent) => {
      await handleKeyDownUtil({
        e,
        inputRef,
        isHorizontalNavigationRef,
        justJumpedToVerticalRef,
        horizontalResultsRef,
        currentLoadResultsRef,
        query,
        contextMenu,
        errorMessage,
        isPluginListModalOpen,
        isMemoModalOpen,
        isRemarkModalOpen,
        pastedImageDataUrl,
        selectedHorizontalIndex,
        selectedVerticalIndex,
        horizontalResults,
        verticalResults,
        setContextMenu,
        setErrorMessage,
        setIsPluginListModalOpen,
        setIsMemoModalOpen,
        setIsRemarkModalOpen,
        setEditingRemarkUrl,
        setRemarkText,
        setPastedImageDataUrl,
        setPastedImagePath,
        setSelectedHorizontalIndex,
        setSelectedVerticalIndex,
        setResults,
        setHorizontalResults,
        setVerticalResults,
        hideLauncherAndResetState,
        resetMemoState,
        handleLaunch,
      });
    },
    [
      query,
      contextMenu,
      errorMessage,
      isPluginListModalOpen,
      isMemoModalOpen,
      isRemarkModalOpen,
      pastedImageDataUrl,
      selectedHorizontalIndex,
      selectedVerticalIndex,
      horizontalResults,
      verticalResults,
      setContextMenu,
      setErrorMessage,
      setIsPluginListModalOpen,
      setIsMemoModalOpen,
      setIsRemarkModalOpen,
      setEditingRemarkUrl,
      setRemarkText,
      setPastedImageDataUrl,
      setPastedImagePath,
      setSelectedHorizontalIndex,
      setSelectedVerticalIndex,
      setResults,
      setHorizontalResults,
      setVerticalResults,
      hideLauncherAndResetState,
      resetMemoState,
      handleLaunch,
    ]
  );

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
