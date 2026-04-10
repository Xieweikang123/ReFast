import { useState, useEffect, useRef, useMemo, useCallback, startTransition } from "react";
import { tauriApi } from "../api/tauri";
import type { AppInfo, FileHistoryItem, EverythingResult, MemoItem, PluginContext, UpdateCheckResult, SearchEngineConfig } from "../types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/window";
import { plugins, executePlugin } from "../plugins";
import { MemoModal } from "./MemoModal";
import { RemarkEditModal } from "./RemarkEditModal";
import { PluginListModal } from "./PluginListModal";
import { ContextMenu } from "./ContextMenu";
import { ErrorDialog } from "./ErrorDialog";
import { SearchInputHeader } from "./SearchInputHeader";
import { SearchResultArea } from "./SearchResultArea";
import { LauncherStatusBar } from "./LauncherStatusBar";
import { getLayoutConfig, type ResultStyle } from "../utils/themeConfig";
import { handleEscapeKey, closePluginModalAndHide, closeMemoModalAndHide } from "../utils/launcherHandlers";
import { clearAllResults, loadResultsIncrementally, findBestFlatResultIndexFromOpenHistory } from "../utils/resultUtils";
import { getMainContainer as getMainContainerUtil } from "../utils/windowUtils";
import type { SearchResult } from "../utils/resultUtils";
import { askOllama } from "../utils/ollamaUtils";
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
import { useSearchWrappers } from "../hooks/useSearchWrappers";
import { useCombinedResults } from "../hooks/useCombinedResults";
import { useSearch } from "../hooks/useSearch";
import { useScrollbarStyle } from "../hooks/useScrollbarStyle";
import {
  processPastedPath as processPastedPathUtil,
  handlePaste as handlePasteUtil,
  saveImageToDownloads,
} from "../utils/pasteUtils";
import {
  handleContextMenuWithResult,
  revealInFolder as revealInFolderUtil,
  removeAppFromIndexMenu,
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
  /** 从应用索引删除前的确认（避免用 window.confirm，防止与右键菜单事件顺序冲突） */
  const [appIndexRemoveConfirm, setAppIndexRemoveConfirm] = useState<{
    path: string;
    displayName: string;
  } | null>(null);
  const [appIndexRemoveLoading, setAppIndexRemoveLoading] = useState(false);
  const appIndexRemoveRunningRef = useRef(false);
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
  /** 打开应用中心内「应用索引列表」时预填的同名搜索词 */
  const [openAppIndexWithSearch, setOpenAppIndexWithSearch] = useState<string | null>(null);
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

  // 动态注入滚动条样式
  useScrollbarStyle(resultStyle);

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
      case "markdown_editor":
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

  // 同步更新 hasResultsRef，用于优化查询去重检查
  useEffect(() => {
    hasResultsRef.current = filteredApps.length > 0 || filteredFiles.length > 0 || filteredMemos.length > 0 || 
                             filteredPlugins.length > 0 || everythingResults.length > 0;
  }, [filteredApps, filteredFiles, filteredMemos, filteredPlugins, everythingResults]);


  // 使用自定义 Hook 合并搜索结果
  const { combinedResults: debouncedCombinedResults, queryRef, debouncedResultsQueryRef } = useCombinedResults({
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
  
  // 跟踪 horizontalResults 的稳定性
  const [isHorizontalResultsStable, setIsHorizontalResultsStable] = useState(true);
  const horizontalResultsStabilityTimeoutRef = useRef<number | null>(null);
  const previousHorizontalResultsLengthRef = useRef<number>(0);
  
  useEffect(() => {
    // 当 horizontalResults 长度变化时，标记为不稳定
    if (horizontalResults.length !== previousHorizontalResultsLengthRef.current) {
      previousHorizontalResultsLengthRef.current = horizontalResults.length;
      setIsHorizontalResultsStable(false);
      
      // 清除之前的 timeout
      if (horizontalResultsStabilityTimeoutRef.current !== null) {
        clearTimeout(horizontalResultsStabilityTimeoutRef.current);
      }
      
      // 设置新的 timeout，300ms 后如果长度没有变化，认为稳定
      horizontalResultsStabilityTimeoutRef.current = window.setTimeout(() => {
        setIsHorizontalResultsStable(true);
        horizontalResultsStabilityTimeoutRef.current = null;
      }, 300);
    }
    
    return () => {
      if (horizontalResultsStabilityTimeoutRef.current !== null) {
        clearTimeout(horizontalResultsStabilityTimeoutRef.current);
        horizontalResultsStabilityTimeoutRef.current = null;
      }
    };
  }, [horizontalResults.length]);

  // 使用 ref 跟踪最后一次加载结果时的查询，用于验证结果是否仍然有效
  const lastLoadQueryRef = useRef<string>("");
  
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

  // 为 Everything 搜索结果中的可执行文件提取图标
  useEffect(() => {
    if (!everythingResults || everythingResults.length === 0) {
      return;
    }

    // 过滤出可执行文件（.exe 或 .lnk）
    const executableFiles = everythingResults.filter((result) => {
      const pathLower = result.path.toLowerCase();
      return (pathLower.endsWith(".exe") || pathLower.endsWith(".lnk")) && 
             !pathLower.includes("windowsapps");
    });

    // 为每个可执行文件提取图标（如果还没有图标）
    executableFiles.slice(0, 10).forEach((file) => {
      // 检查是否已有图标
      const existingIcon = extractedFileIconsRef.current.get(file.path);
      if (existingIcon && existingIcon !== "__ICON_EXTRACTION_FAILED__") {
        return; // 已有图标，跳过
      }

      // 检查应用列表中是否已有该路径的应用及其有效图标
      const normalizedPath = file.path.toLowerCase().replace(/\\/g, "/");
      const matchedApp = apps.find((app) => {
        const appPath = app.path.toLowerCase().replace(/\\/g, "/");
        return appPath === normalizedPath && app.icon && app.icon !== "__ICON_EXTRACTION_FAILED__";
      });

      if (matchedApp) {
        // 应用列表中已有图标，保存到缓存
        extractedFileIconsRef.current.set(file.path, matchedApp.icon!);
        return;
      }

      // 触发图标提取（异步，不阻塞）
      tauriApi.extractIconFromPath(file.path)
        .then((icon) => {
          if (icon) {
            extractedFileIconsRef.current.set(file.path, icon);
            // extractedFileIconsRef 是 useCombinedResults 的依赖项，更新后会自动触发重新计算
          } else {
            // 标记为提取失败，避免重复尝试
            extractedFileIconsRef.current.set(file.path, "__ICON_EXTRACTION_FAILED__");
          }
        })
        .catch(() => {
          // 标记为提取失败，避免重复尝试
          extractedFileIconsRef.current.set(file.path, "__ICON_EXTRACTION_FAILED__");
        });
    });
  }, [everythingResults, apps, extractedFileIconsRef]);

  // Watch results changes and set selectedIndex（与横向/纵向选中一致：优先选中 openHistory 中最近打开过的项）
  useEffect(() => {
    
    // If we just jumped to vertical, don't reset selectedIndex
    if (justJumpedToVerticalRef.current) {
      return;
    }
    
    if (results.length === 0) {
      setSelectedIndex(0);
      return;
    }

    const bestFlat = findBestFlatResultIndexFromOpenHistory(results, openHistory);
    if (bestFlat !== null) {
      isAutoSelectingFirstHorizontalRef.current = true;
      setSelectedIndex(bestFlat);
      setTimeout(() => {
        isAutoSelectingFirstHorizontalRef.current = false;
      }, 100);
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
  }, [results, openHistory]);

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

  // 使用自定义 hook 管理搜索相关的 wrapper 函数
  const {
    searchMemosWrapper,
    searchSystemFoldersWrapper,
    searchApplicationsWrapper,
    searchFileHistoryWrapper,
    handleSearchPlugins,
    handleDirectPathLookup,
    refreshFileHistoryCache,
  } = useSearchWrappers({
    query,
    memos,
    apps,
    allFileHistoryCacheRef,
    allFileHistoryCacheLoadedRef,
    allAppsCacheRef,
    allAppsCacheLoadedRef,
    systemFoldersListRef,
    systemFoldersListLoadedRef,
    extractedFileIconsRef,
    updateSearchResults,
    filterWindowsApps,
    setFilteredMemos,
    setFilteredFiles,
    setFilteredApps,
    setFilteredPlugins,
    setSystemFolders,
    setApps,
    setDirectPathResult,
  });

  // 使用自定义 hook 监听图标更新事件
  useAppIconsListener({
    setFilteredApps,
    setApps,
    allAppsCacheRef,
  });



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

  // 使用自定义 Hook 处理搜索逻辑（必须在所有依赖变量定义之后）
  useSearch({
    query,
    isEverythingAvailable,
    setFilteredApps,
    setFilteredFiles,
    setFilteredMemos,
    setFilteredPlugins,
    setEverythingResults,
    setEverythingTotalCount,
    setEverythingCurrentCount,
    setDirectPathResult,
    setDetectedUrls,
    setDetectedEmails,
    setDetectedJson,
    setAiAnswer,
    setShowAiAnswer,
    setIsAiLoading,
    setResults,
    setSelectedIndex,
    setIsSearchingEverything,
    showAiAnswer,
    lastSearchQueryRef,
    debounceTimeoutRef,
    hasResultsRef,
    pendingSessionIdRef,
    currentSearchQueryRef,
    displayedSearchQueryRef,
    searchSystemFoldersWrapper,
    searchFileHistoryWrapper,
    searchApplicationsWrapper,
    searchMemosWrapper,
    handleSearchPlugins,
    handleDirectPathLookup,
    startSearchSession,
    closeSessionSafe,
  });

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

  const handleRequestRemoveFromAppIndex = useCallback(
    (info: { path: string; displayName: string }) => {
      setAppIndexRemoveConfirm(info);
    },
    []
  );

  const handleOpenAppIndexSearchConsumed = useCallback(() => {
    setOpenAppIndexWithSearch(null);
  }, []);

  const handleRequestOpenAppIndexSameName = useCallback(
    (info: { searchQuery: string }) => {
      const q = info.searchQuery.trim();
      if (!q) return;
      setIsPluginListModalOpen(true);
      setOpenAppIndexWithSearch(q);
    },
    []
  );

  const handleConfirmRemoveAppIndex = useCallback(async () => {
    if (!appIndexRemoveConfirm || appIndexRemoveRunningRef.current) return;
    appIndexRemoveRunningRef.current = true;
    setAppIndexRemoveLoading(true);
    const appPath = appIndexRemoveConfirm.path;
    try {
      await removeAppFromIndexMenu({
        appPath,
        allAppsCacheRef,
        setApps,
        setFilteredApps,
        query,
        searchApplicationsWrapper,
      });
      setAppIndexRemoveConfirm(null);
    } catch {
      // 失败时 removeAppFromIndexMenu 已 alert
    } finally {
      appIndexRemoveRunningRef.current = false;
      setAppIndexRemoveLoading(false);
    }
  }, [
    appIndexRemoveConfirm,
    allAppsCacheRef,
    setApps,
    setFilteredApps,
    query,
    searchApplicationsWrapper,
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
        processPastedPath,
        tauriApi,
      });
    },
    [
      setQuery,
      setPastedImagePath,
      setPastedImageDataUrl,
      setErrorMessage,
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

  const handlePluginClick = useCallback(async (pluginId: string) => {
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
  }, [
    query,
    setQuery,
    setSelectedIndex,
    setIsMemoModalOpen,
    setIsMemoListMode,
    setSelectedMemo,
    setMemoEditTitle,
    setMemoEditContent,
    setMemos,
    hideLauncherAndResetState,
  ]);

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
          <SearchInputHeader
            layout={layout}
            inputRef={inputRef}
            query={query}
            setQuery={setQuery}
            handleKeyDown={handleKeyDown}
            handlePaste={handlePaste}
            pastedImageDataUrl={pastedImageDataUrl}
            isHoveringAiIcon={isHoveringAiIcon}
            setIsHoveringAiIcon={setIsHoveringAiIcon}
            onPluginListClick={async () => {
              await tauriApi.showPluginListWindow();
              await hideLauncherAndResetState();
            }}
            onStartWindowDragging={startWindowDragging}
            contextMenu={contextMenu}
            setContextMenu={setContextMenu}
          />

          {/* Results List or AI Answer */}
          <SearchResultArea
            showAiAnswer={showAiAnswer}
            isAiLoading={isAiLoading}
            aiAnswer={aiAnswer}
            setAiAnswer={setAiAnswer}
            setShowAiAnswer={setShowAiAnswer}
            results={results}
            query={query}
            isSearchingEverything={isSearchingEverything}
            isEverythingAvailable={isEverythingAvailable}
            everythingTotalCount={everythingTotalCount}
            everythingCurrentCount={everythingCurrentCount}
            everythingVersion={everythingVersion}
            everythingResults={everythingResults}
            listRef={listRef}
            horizontalResults={horizontalResults}
            verticalResults={verticalResults}
            selectedHorizontalIndex={selectedHorizontalIndex}
            selectedVerticalIndex={selectedVerticalIndex}
            resultStyle={resultStyle}
            apps={apps}
            filteredApps={filteredApps}
            launchingAppPath={launchingAppPath}
            pastedImagePath={pastedImagePath}
            openHistory={openHistory}
            urlRemarks={urlRemarks}
            getPluginIcon={getPluginIcon}
            handleLaunch={handleLaunch}
            handleContextMenu={handleContextMenu}
            handleSaveImageToDownloads={handleSaveImageToDownloads}
            horizontalScrollContainerRef={horizontalScrollContainerRef}
            isHorizontalResultsStable={isHorizontalResultsStable}
          />

          {/* Footer */}
          <LauncherStatusBar
            resultsCount={results.length}
            showAiAnswer={showAiAnswer}
            isEverythingAvailable={isEverythingAvailable}
            everythingError={everythingError}
            everythingPath={everythingPath}
            everythingVersion={everythingVersion}
            isDownloadingEverything={isDownloadingEverything}
            everythingDownloadProgress={everythingDownloadProgress}
            updateInfo={updateInfo}
            onStartEverything={handleStartEverything}
            onDownloadEverything={handleDownloadEverything}
            onCheckAgain={handleCheckAgain}
            downloadButtonRef={downloadButtonRef}
          />
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
        onRequestRemoveFromAppIndex={handleRequestRemoveFromAppIndex}
        onRequestOpenAppIndexSameName={handleRequestOpenAppIndexSameName}
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
      <RemarkEditModal
        isOpen={isRemarkModalOpen}
        editingRemarkUrl={editingRemarkUrl}
        remarkText={remarkText}
        setRemarkText={setRemarkText}
        onClose={() => {
          setIsRemarkModalOpen(false);
          setEditingRemarkUrl(null);
          setRemarkText("");
        }}
        onSave={handleSaveRemark}
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
      <PluginListModal
        isOpen={isPluginListModalOpen}
        onClose={async () => {
          setOpenAppIndexWithSearch(null);
          closePluginModalAndHide(setIsPluginListModalOpen, hideLauncherAndResetState);
        }}
        onPluginClick={handlePluginClick}
        openAppIndexWithSearch={openAppIndexWithSearch}
        onOpenAppIndexSearchConsumed={handleOpenAppIndexSearchConsumed}
      />

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

      {/* 从应用索引删除确认 */}
      <ErrorDialog
        isOpen={!!appIndexRemoveConfirm}
        type="warning"
        title="从应用索引删除"
        overlayClassName="fixed inset-0 bg-black/50 backdrop-blur-[2px] flex items-center justify-center z-[100]"
        message={
          appIndexRemoveConfirm
            ? `将从应用索引中移除「${appIndexRemoveConfirm.displayName}」。\n\n不会删除磁盘上的文件。若该项来自开始菜单等，重新扫描应用后可能会再次出现。\n\n完整路径：\n${appIndexRemoveConfirm.path}`
            : ""
        }
        messageClassName="break-all"
        onClose={() => {
          if (appIndexRemoveLoading) return;
          setAppIndexRemoveConfirm(null);
        }}
        actions={[
          {
            label: "取消",
            variant: "secondary",
            onClick: () => {
              if (appIndexRemoveLoading) return;
              setAppIndexRemoveConfirm(null);
            },
          },
          {
            label: appIndexRemoveLoading ? "删除中…" : "从索引删除",
            variant: "danger",
            onClick: () => {
              void handleConfirmRemoveAppIndex();
            },
          },
        ]}
      />
    </div>
  );
}
