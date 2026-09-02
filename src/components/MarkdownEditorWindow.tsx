import { useState, useEffect, useRef, useMemo, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useWindowClose } from "../hooks/useWindowClose";
import { tauriApi } from "../api/tauri";
import { getRecentFiles, addRecentFile, removeRecentFile, type RecentFile } from "../utils/markdownEditorHistory";

type MarkdownViewMode = "preview" | "split";

const MARKDOWN_VIEW_MODE_KEY = "markdown-editor:view-mode";

function readSavedViewMode(): MarkdownViewMode {
  try {
    const saved = localStorage.getItem(MARKDOWN_VIEW_MODE_KEY);
    if (saved === "preview" || saved === "split") return saved;
  } catch {
    // 忽略无 localStorage 的环境
  }
  return "split";
}

interface Heading {
  level: number;
  text: string;
  id: string;
}

// 从 React 子节点中提取纯文本
function extractText(children: any): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) {
    return children.map(extractText).join("");
  }
  if (children?.props?.children) {
    return extractText(children.props.children);
  }
  return "";
}

export function MarkdownEditorWindow() {
  const [markdownContent, setMarkdownContent] = useState("");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<MarkdownViewMode>(readSavedViewMode);
  const [isWatching, setIsWatching] = useState(false);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [showRecentFiles, setShowRecentFiles] = useState(false);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const [tocWidth, setTocWidth] = useState(220);
  const [isDarkMode, setIsDarkMode] = useState(true); // 默认深色模式
  const isEditingRef = useRef(false); // 标记是否正在编辑，避免外部变化触发时覆盖用户输入
  const isScrollingRef = useRef(false); // 标记是否正在进行程序化滚动
  const scrollAnimRef = useRef<{ current: number } | null>(null); // 跟踪当前滚动动画
  const scrollTimerRef = useRef<number | null>(null); // 跟踪滚动完成定时器
  const recentFilesRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const openFileByPathRef = useRef<
    (newFilePath: string, fileName?: string) => Promise<boolean>
  >(async () => false);

  // 深色模式样式配置
  const theme = useMemo(() => ({
    bg: isDarkMode ? "#1e1e1e" : "#ffffff",
    bgSecondary: isDarkMode ? "#252526" : "#f9fafb",
    bgTertiary: isDarkMode ? "#2d2d30" : "#f3f4f6",
    border: isDarkMode ? "#3e3e42" : "#e5e7eb",
    text: isDarkMode ? "#cccccc" : "#111827",
    textSecondary: isDarkMode ? "#858585" : "#6b7280",
    textMuted: isDarkMode ? "#6b6b6b" : "#9ca3af",
    hover: isDarkMode ? "#2a2d2e" : "#f3f4f6",
    codeBg: isDarkMode ? "#252526" : "#f3f4f6",
    codeText: isDarkMode ? "#d4d4d4" : "#dc2626",
    link: isDarkMode ? "#4a9eff" : "#3b82f6",
    buttonPrimary: isDarkMode ? "#0e639c" : "#3b82f6",
    buttonPrimaryHover: isDarkMode ? "#1177bb" : "#2563eb",
    buttonSecondary: isDarkMode ? "#3e3e42" : "#6b7280",
    buttonSecondaryHover: isDarkMode ? "#505050" : "#4b5563",
    errorBg: isDarkMode ? "#5a1d1d" : "#fee2e2",
    errorText: isDarkMode ? "#f48771" : "#991b1b",
    activeHeading: isDarkMode ? "#094771" : "#eff6ff",
    activeHeadingText: isDarkMode ? "#4a9eff" : "#3b82f6",
    tocLevel1: isDarkMode ? "#4a9eff" : "#1d4ed8",
  }), [isDarkMode]);


  // ESC 键关闭窗口
  const handleClose = useWindowClose();
  useEscapeKey(handleClose);

  // 加载最近打开的文件列表
  useEffect(() => {
    const loadRecentFiles = async () => {
      const files = await getRecentFiles();
      setRecentFiles(files);
    };
    loadRecentFiles();
  }, []);

  // 打开文件的通用函数
  const openFileByPath = useCallback(async (newFilePath: string, fileName?: string) => {
    try {
      setIsLoading(true);
      setError(null);

      // 先停止之前文件的监听（使用 state 中的 filePath，不是新的 filePath）
      const oldFilePath = filePath;
      if (oldFilePath && oldFilePath !== newFilePath) {
        try {
          const window = getCurrentWindow();
          await tauriApi.unwatchMarkdownFile(window.label, oldFilePath);
        } catch (e) {
          console.warn("停止文件监听失败:", e);
        }
      }

      // 读取文件内容（这是关键操作，失败才显示错误）
      let content: string;
      try {
        content = await invoke<string>("read_text_file", { path: newFilePath });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "读取文件失败";
        setError(`无法读取文件: ${errorMessage}`);
        console.error("读取文件失败:", err);
        setIsLoading(false);
        setIsWatching(false);
        return false;
      }

      // 文件读取成功，更新状态
      setMarkdownContent(content);
      setFilePath(newFilePath);
      
      // 保存到最近打开的文件记录（非关键操作，失败不影响）
      // 传递文件内容以提取标题
      try {
        await addRecentFile(newFilePath, content);
        const files = await getRecentFiles();
        setRecentFiles(files);
      } catch (e) {
        console.warn("保存最近文件记录失败:", e);
      }
      
      // 更新窗口标题（非关键操作，失败不影响）
      try {
        const window = getCurrentWindow();
        const displayName = fileName || newFilePath.split(/[/\\]/).pop() || "未命名";
        await window.setTitle(`Markdown 编辑器 - ${displayName}`);
      } catch (e) {
        console.warn("更新窗口标题失败:", e);
      }
      
      // 开始监听文件变化（非关键操作，失败不影响，添加超时保护）
      try {
        const window = getCurrentWindow();
        // 添加超时保护，避免卡住
        const watchPromise = tauriApi.watchMarkdownFile(window.label, newFilePath);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error("文件监听超时")), 5000)
        );
        
        await Promise.race([watchPromise, timeoutPromise]);
        setIsWatching(true);
        console.log("开始监听文件变化:", newFilePath);
      } catch (e) {
        console.warn("启动文件监听失败:", e);
        setIsWatching(false);
        // 即使监听失败，也不影响文件打开，继续执行
      }

      setIsLoading(false);
      return true;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "打开文件失败";
      setError(`无法打开文件: ${errorMessage}`);
      console.error("打开文件失败:", err);
      setIsLoading(false);
      setIsWatching(false);
      return false;
    }
  }, [filePath]);

  openFileByPathRef.current = openFileByPath;

  // 组件加载时：优先打开外部传入的文件，否则自动打开上次文件
  useEffect(() => {
    const init = async () => {
      try {
        const pendingPath = await tauriApi.takeMarkdownEditorFilePath();
        if (pendingPath?.trim()) {
          await openFileByPathRef.current(pendingPath.trim());
          return;
        }
      } catch (error) {
        console.error("Failed to take markdown editor file path:", error);
      }

      try {
        const files = await getRecentFiles();
        if (files.length > 0) {
          const lastFile = files[0]; // 第一个是最新的
          console.log("自动加载上次打开的文件:", lastFile.path);
          const success = await openFileByPathRef.current(
            lastFile.path,
            lastFile.title || lastFile.name
          );

          // 如果文件不存在，从列表中移除
          if (!success) {
            try {
              await removeRecentFile(lastFile.path);
              const updatedFiles = await getRecentFiles();
              setRecentFiles(updatedFiles);
            } catch (e) {
              console.warn("移除无效文件记录失败:", e);
            }
          }
        }
      } catch (error) {
        console.error("自动加载上次文件失败:", error);
        // 静默失败，不影响用户体验
      }
    };

    // 延迟一小段时间，确保组件完全加载
    const timer = setTimeout(() => {
      init();
    }, 100);

    return () => clearTimeout(timer);
  }, []);

  // 从启动器等处打开指定文件（编辑器已打开时通过事件送达，避免仅靠 focus 拉取 pending）
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setup = async () => {
      try {
        unlisten = await listen<{ path: string }>("markdown-editor:open-file", async (event) => {
          const path = event.payload?.path?.trim();
          if (!path) return;
          await openFileByPathRef.current(path);
        });
      } catch (error) {
        console.error("Failed to setup markdown editor open-file listener:", error);
      }
    };

    setup();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // 点击外部关闭最近文件菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (recentFilesRef.current && !recentFilesRef.current.contains(event.target as Node)) {
        setShowRecentFiles(false);
      }
    };

    if (showRecentFiles) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }
  }, [showRecentFiles]);

  // 生成标题 ID（简单的 slug）
  const generateSlug = (text: string): string => {
    let slug = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .trim();
    
    // 确保不以数字开头（CSS 选择器不允许）
    if (/^\d/.test(slug)) {
      slug = `h-${slug}`;
    }
    
    // 确保不以连字符结尾
    slug = slug.replace(/-+$/, "");
    
    // 如果为空，使用默认值
    if (!slug) {
      slug = "heading";
    }
    
    return slug;
  };

  // 提取 Markdown 中的所有标题
  const headings = useMemo<Heading[]>(() => {
    if (!markdownContent) return [];
    
    const headingRegex = /^(#{1,6})\s+(.+)$/gm;
    const headingsList: Heading[] = [];
    const idMap = new Map<string, number>();
    let match;

    while ((match = headingRegex.exec(markdownContent)) !== null) {
      const level = match[1].length;
      // 剥离行内 markdown 标记（反引号、加粗、斜体、链接），只保留纯文本
      const text = match[2]
        .trim()
        .replace(/`([^`]*)`/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/^#+\s*/, "")
        .trim();
      let baseId = generateSlug(text);
      
      // 如果 ID 已存在，添加数字后缀
      if (idMap.has(baseId)) {
        const count = idMap.get(baseId)! + 1;
        idMap.set(baseId, count);
        baseId = `${baseId}-${count}`;
      } else {
        idMap.set(baseId, 0);
      }
      
      headingsList.push({ level, text, id: baseId });
    }

    return headingsList;
  }, [markdownContent]);

  // 监听滚动，高亮当前标题
  useEffect(() => {
    if (!previewRef.current || headings.length === 0) return;

    const previewElement = previewRef.current;
    const handleScroll = () => {
      // 如果正在进行程序化滚动，忽略滚动监听器的更新
      if (isScrollingRef.current) return;
      
      const scrollTop = previewElement.scrollTop;
      const headingsElements = previewElement.querySelectorAll("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]");
      const containerRect = previewElement.getBoundingClientRect();
      
      let currentHeadingId: string | null = null;
      
      // 触底时直接高亮最后一个标题，避免最后几个标题因未滚到阈值内而无法选中
      const atBottom = scrollTop + previewElement.clientHeight >= previewElement.scrollHeight - 2;
      if (atBottom && headingsElements.length > 0) {
        currentHeadingId = (headingsElements[headingsElements.length - 1] as HTMLElement).id;
      } else {
        for (let i = headingsElements.length - 1; i >= 0; i--) {
          const element = headingsElements[i] as HTMLElement;
          // 用 getBoundingClientRect 相对容器计算，offsetTop 相对 offsetParent 不可靠
          const elementTopInContainer = element.getBoundingClientRect().top - containerRect.top;
          if (elementTopInContainer <= 100) {
            currentHeadingId = element.id;
            break;
          }
        }
      }
      
      setActiveHeadingId(currentHeadingId);
    };

    previewElement.addEventListener("scroll", handleScroll);
    handleScroll(); // 初始检查

    return () => {
      previewElement.removeEventListener("scroll", handleScroll);
    };
  }, [markdownContent, viewMode, headings]);

  // 自定义平滑滚动函数，使用固定的动画时长（400ms），无论距离多远
  const smoothScrollTo = (container: HTMLElement, targetTop: number, duration: number = 400) => {
    const startTop = container.scrollTop;
    const distance = targetTop - startTop;
    const startTime = performance.now();
    const rafId = { current: 0 };
    
    const animateScroll = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      
      // 使用 easeOutCubic 缓动函数，让滚动更自然
      const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
      const easedProgress = easeOutCubic(progress);
      
      container.scrollTop = startTop + distance * easedProgress;
      
      if (progress < 1) {
        rafId.current = requestAnimationFrame(animateScroll);
      }
    };
    
    rafId.current = requestAnimationFrame(animateScroll);
    return rafId;
  };

  // 滚动到指定标题
  const scrollToHeading = (id: string) => {
    if (!previewRef.current) return;
    
    // 首先尝试使用 getElementById（更安全，不依赖 CSS 选择器）
    let element = document.getElementById(id) as HTMLElement;
    
    // 如果找不到，尝试在预览容器内查找
    if (!element && previewRef.current) {
      // 使用 getElementById 在整个文档中查找
      element = previewRef.current.querySelector(`[id="${id}"]`) as HTMLElement;
    }
    
    // 如果还是找不到，尝试通过文本内容查找
    if (!element) {
      const heading = headings.find(h => h.id === id);
      if (heading) {
        const allHeadings = previewRef.current.querySelectorAll('h1, h2, h3, h4, h5, h6');
        for (const h of Array.from(allHeadings)) {
          if (h.textContent?.trim() === heading.text) {
            element = h as HTMLElement;
            // 如果元素没有 ID，设置它
            if (!element.id) {
              element.id = id;
            }
            break;
          }
        }
      }
    }
    
    if (element && previewRef.current) {
      // 取消上一次未完成的滚动动画与定时器，避免快速连续点击时竞态
      if (scrollAnimRef.current) {
        cancelAnimationFrame(scrollAnimRef.current.current);
      }
      if (scrollTimerRef.current) {
        clearTimeout(scrollTimerRef.current);
      }
      
      // 立即设置高亮
      setActiveHeadingId(id);
      
      // 标记开始程序化滚动，防止滚动监听器在滚动过程中覆盖高亮
      isScrollingRef.current = true;
      
      // 计算目标滚动位置（使用 getBoundingClientRect 确保准确性）
      const container = previewRef.current;
      const elementRect = element.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      
      // 获取容器的 padding（用于准确计算）
      const containerStyle = window.getComputedStyle(container);
      const containerPaddingTop = parseFloat(containerStyle.paddingTop) || 0;
      
      // 计算元素相对于容器内容区域的位置
      // elementRect.top 是元素相对于视口的位置
      // containerRect.top 是容器相对于视口的位置（包括 padding）
      // container.scrollTop 是容器当前的滚动位置
      // 元素在容器内容中的位置 = 当前滚动位置 + (元素视口位置 - 容器视口位置 - padding)
      const elementTopInContainer = container.scrollTop + (elementRect.top - containerRect.top - containerPaddingTop);
      const scrollMarginTop = 80; // 与 CSS 中的 scrollMarginTop 保持一致
      const targetScrollTop = elementTopInContainer - scrollMarginTop;
      
      // 确保目标位置不为负数
      const finalTargetScrollTop = Math.max(0, targetScrollTop);
      
      // 使用自定义滚动函数，固定 400ms 动画时长
      scrollAnimRef.current = smoothScrollTo(container, finalTargetScrollTop, 400);
      
      // 等待滚动完成后再允许滚动监听器更新高亮
      scrollTimerRef.current = window.setTimeout(() => {
        isScrollingRef.current = false;
        // 滚动完成后，确保高亮正确（滚动监听器会基于实际位置更新）
        // 但为了确保点击的标题被高亮，我们再次设置它
        setActiveHeadingId(id);
        scrollAnimRef.current = null;
      }, 450); // 稍微长一点，确保动画完成
    } else {
      console.warn(`找不到标题元素: ${id}`);
    }
  };

  // 监听文件变化事件
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupListener = async () => {
      try {
        unlisten = await listen<string>("markdown-file-changed", (event) => {
          // 如果用户正在编辑，不自动更新（避免覆盖用户输入）
          if (!isEditingRef.current && filePath) {
            console.log("检测到文件变化，自动更新内容");
            setMarkdownContent(event.payload);
          }
        });
      } catch (error) {
        console.error("设置文件监听失败:", error);
      }
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [filePath]);

  // 打开文件
  const handleOpenFile = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const selected = await open({
        filters: [
          {
            name: "Markdown",
            extensions: ["md", "markdown", "txt"],
          },
        ],
        multiple: false,
        title: "打开 Markdown 文件",
      });

      // 用户取消选择文件，不显示错误
      if (!selected || typeof selected !== "string") {
        setIsLoading(false);
        return;
      }

      // 使用通用函数打开文件
      await openFileByPath(selected);
    } catch (err) {
      // 只有在文件对话框真正出错时才显示错误（用户取消不算错误）
      // 检查错误信息，如果是用户取消相关的错误，不显示
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (!errorMessage.includes("canceled") && !errorMessage.includes("取消")) {
        setError(`无法打开文件: ${errorMessage}`);
        console.error("打开文件失败:", err);
      } else {
        // 用户取消操作，不显示错误
        console.log("用户取消了文件选择");
      }
    } finally {
      setIsLoading(false);
    }
  };

  // 在文件管理器中打开当前文件所在文件夹
  const handleRevealInFolder = async () => {
    if (!filePath) return;
    try {
      await tauriApi.revealInFolder(filePath);
    } catch (err) {
      console.error("打开所在文件夹失败:", err);
      setError(`无法打开所在文件夹: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 清空内容
  const handleClear = async () => {
    // 停止文件监听
    if (filePath) {
      try {
        const window = getCurrentWindow();
        await tauriApi.unwatchMarkdownFile(window.label, filePath);
      } catch (e) {
        console.warn("停止文件监听失败:", e);
      }
    }
    
    setMarkdownContent("");
    setFilePath(null);
    setError(null);
    setIsWatching(false);
    const window = getCurrentWindow();
    window.setTitle("Markdown 编辑器");
  };

  // 快速打开最近文件
  const handleOpenRecentFile = async (recentFile: RecentFile) => {
    setShowRecentFiles(false);
    
    const success = await openFileByPath(recentFile.path, recentFile.title || recentFile.name);
    
    // 如果文件不存在，从最近列表中移除
    if (!success) {
      try {
        await removeRecentFile(recentFile.path);
        const files = await getRecentFiles();
        setRecentFiles(files);
      } catch (e) {
        console.warn("移除无效文件记录失败:", e);
      }
    }
  };

  // 组件卸载时清理监听
  useEffect(() => {
    return () => {
      if (scrollAnimRef.current) {
        cancelAnimationFrame(scrollAnimRef.current.current);
      }
      if (scrollTimerRef.current) {
        clearTimeout(scrollTimerRef.current);
      }
      if (filePath) {
        const window = getCurrentWindow();
        tauriApi.unwatchMarkdownFile(window.label, filePath).catch(console.error);
      }
    };
  }, [filePath]);

  useEffect(() => {
    try {
      localStorage.setItem(MARKDOWN_VIEW_MODE_KEY, viewMode);
    } catch {
      // 忽略写入失败
    }
  }, [viewMode]);

  const toggleViewMode = () => {
    setViewMode((prev) => (prev === "preview" ? "split" : "preview"));
  };

  // 拖动调整目录宽度
  const startResizeToc = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = tocWidth;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(420, Math.max(160, startWidth + (ev.clientX - startX)));
      setTocWidth(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const fileDisplayName = filePath
    ? filePath.split(/[/\\]/).pop() ?? filePath
    : null;

  const paneScrollClass =
    viewMode === "split"
      ? "markdown-editor-scrollbar markdown-editor-split-scrollbar"
      : "markdown-editor-scrollbar";

  return (
    <>
      {/* 自定义滚动条样式 */}
      <style>
        {`
          /* 滚动条整体样式 */
          .markdown-editor-scrollbar::-webkit-scrollbar {
            width: 10px;
            height: 10px;
          }
          
          .markdown-editor-scrollbar::-webkit-scrollbar-track {
            background: ${isDarkMode ? '#1e1e1e' : '#f1f1f1'};
            border-radius: 5px;
          }
          
          .markdown-editor-scrollbar::-webkit-scrollbar-thumb {
            background: ${isDarkMode ? '#424242' : '#c1c1c1'};
            border-radius: 5px;
            border: 2px solid ${isDarkMode ? '#1e1e1e' : '#f1f1f1'};
          }
          
          .markdown-editor-scrollbar::-webkit-scrollbar-thumb:hover {
            background: ${isDarkMode ? '#4e4e4e' : '#a8a8a8'};
          }
          
          .markdown-editor-scrollbar::-webkit-scrollbar-thumb:active {
            background: ${isDarkMode ? '#606060' : '#909090'};
          }
          
          /* 水平滚动条 */
          .markdown-editor-scrollbar::-webkit-scrollbar:horizontal {
            height: 10px;
          }
          
          /* Firefox 滚动条样式 */
          .markdown-editor-scrollbar {
            scrollbar-width: thin;
            scrollbar-color: ${isDarkMode ? '#424242 #1e1e1e' : '#c1c1c1 #f1f1f1'};
          }
          
          /* 代码块内的滚动条 */
          .markdown-editor-scrollbar code::-webkit-scrollbar,
          .markdown-editor-scrollbar pre::-webkit-scrollbar {
            height: 8px;
          }
          
          .markdown-editor-scrollbar code::-webkit-scrollbar-track,
          .markdown-editor-scrollbar pre::-webkit-scrollbar-track {
            background: ${isDarkMode ? '#252526' : '#f3f4f6'};
            border-radius: 4px;
          }
          
          .markdown-editor-scrollbar code::-webkit-scrollbar-thumb,
          .markdown-editor-scrollbar pre::-webkit-scrollbar-thumb {
            background: ${isDarkMode ? '#3e3e42' : '#d1d5db'};
            border-radius: 4px;
          }
          
          .markdown-editor-scrollbar code::-webkit-scrollbar-thumb:hover,
          .markdown-editor-scrollbar pre::-webkit-scrollbar-thumb:hover {
            background: ${isDarkMode ? '#4e4e4e' : '#9ca3af'};
          }
          
          .markdown-editor-scrollbar code,
          .markdown-editor-scrollbar pre {
            scrollbar-width: thin;
            scrollbar-color: ${isDarkMode ? '#3e3e42 #252526' : '#d1d5db #f3f4f6'};
          }

          /* 分屏模式：更细、overlay 风格滚动条，减少双栏视觉干扰 */
          .markdown-editor-split-scrollbar {
            scrollbar-gutter: stable;
          }

          /* 目录项 hover 高亮（非激活项） */
          .markdown-editor-toc-item:hover {
            background-color: ${isDarkMode ? '#2a2d2e' : '#f3f4f6'} !important;
          }

          /* 代码块语法高亮（highlight.js 深色/浅色主题） */
          .markdown-editor-scrollbar pre code.hljs {
            display: block;
            overflow-x: auto;
            padding: 0;
            background: transparent;
          }
          .markdown-editor-scrollbar pre code.hljs .hljs-comment,
          .markdown-editor-scrollbar pre code.hljs .hljs-quote {
            color: ${isDarkMode ? '#6a9955' : '#6a737d'};
            font-style: italic;
          }
          .markdown-editor-scrollbar pre code.hljs .hljs-keyword,
          .markdown-editor-scrollbar pre code.hljs .hljs-selector-tag,
          .markdown-editor-scrollbar pre code.hljs .hljs-literal,
          .markdown-editor-scrollbar pre code.hljs .hljs-section,
          .markdown-editor-scrollbar pre code.hljs .hljs-link {
            color: ${isDarkMode ? '#569cd6' : '#d73a49'};
          }
          .markdown-editor-scrollbar pre code.hljs .hljs-string,
          .markdown-editor-scrollbar pre code.hljs .hljs-title,
          .markdown-editor-scrollbar pre code.hljs .hljs-name,
          .markdown-editor-scrollbar pre code.hljs .hljs-type,
          .markdown-editor-scrollbar pre code.hljs .hljs-attribute,
          .markdown-editor-scrollbar pre code.hljs .hljs-symbol,
          .markdown-editor-scrollbar pre code.hljs .hljs-bullet,
          .markdown-editor-scrollbar pre code.hljs .hljs-addition,
          .markdown-editor-scrollbar pre code.hljs .hljs-variable,
          .markdown-editor-scrollbar pre code.hljs .hljs-template-tag,
          .markdown-editor-scrollbar pre code.hljs .hljs-template-variable {
            color: ${isDarkMode ? '#ce9178' : '#032f62'};
          }
          .markdown-editor-scrollbar pre code.hljs .hljs-number,
          .markdown-editor-scrollbar pre code.hljs .hljs-meta,
          .markdown-editor-scrollbar pre code.hljs .hljs-built_in,
          .markdown-editor-scrollbar pre code.hljs .hljs-builtin-name,
          .markdown-editor-scrollbar pre code.hljs .hljs-params {
            color: ${isDarkMode ? '#b5cea8' : '#005cc5'};
          }
          .markdown-editor-scrollbar pre code.hljs .hljs-title.function_,
          .markdown-editor-scrollbar pre code.hljs .hljs-function .hljs-title {
            color: ${isDarkMode ? '#dcdcaa' : '#6f42c1'};
          }
          .markdown-editor-scrollbar pre code.hljs .hljs-selector-class,
          .markdown-editor-scrollbar pre code.hljs .hljs-selector-id,
          .markdown-editor-scrollbar pre code.hljs .hljs-selector-attr,
          .markdown-editor-scrollbar pre code.hljs .hljs-selector-pseudo {
            color: ${isDarkMode ? '#d7ba7d' : '#e36209'};
          }
          .markdown-editor-scrollbar pre code.hljs .hljs-deletion {
            color: ${isDarkMode ? '#f48771' : '#b31d28'};
          }
          .markdown-editor-scrollbar pre code.hljs .hljs-emphasis {
            font-style: italic;
          }
          .markdown-editor-scrollbar pre code.hljs .hljs-strong {
            font-weight: bold;
          }

          /* 表格行 hover 高亮 */
          .markdown-editor-scrollbar table tr:hover {
            background-color: ${isDarkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.04)'};
          }

          /* 代码块 hover 时显示复制按钮 */
          .markdown-editor-code-block:hover .markdown-editor-copy-btn {
            opacity: 1 !important;
          }

          /* 预览列表：更精致的标记 */
          .markdown-editor-scrollbar ul {
            list-style: none;
            padding-left: 1.2em;
          }
          .markdown-editor-scrollbar ul > li {
            position: relative;
          }
          .markdown-editor-scrollbar ul > li::before {
            content: "";
            position: absolute;
            left: -1.1em;
            top: 0.72em;
            width: 5px;
            height: 5px;
            border-radius: 50%;
            background-color: ${isDarkMode ? '#858585' : '#9ca3af'};
          }
          .markdown-editor-scrollbar ul > li:has(> input[type="checkbox"])::before {
            display: none;
          }

          /* 任务清单复选框：原生交互样式 */
          .markdown-editor-scrollbar li input[type="checkbox"] {
            appearance: none;
            -webkit-appearance: none;
            width: 15px;
            height: 15px;
            margin: 0 8px 0 0;
            vertical-align: -2px;
            border: 1.5px solid ${isDarkMode ? '#858585' : '#9ca3af'};
            border-radius: 4px;
            background-color: transparent;
            cursor: pointer;
            position: relative;
            transition: background-color 0.15s, border-color 0.15s;
          }
          .markdown-editor-scrollbar li input[type="checkbox"]:hover {
            border-color: ${theme.link};
          }
          .markdown-editor-scrollbar li input[type="checkbox"]:checked {
            background-color: ${theme.link};
            border-color: ${theme.link};
          }
          .markdown-editor-scrollbar li input[type="checkbox"]:checked::after {
            content: "";
            position: absolute;
            left: 4px;
            top: 1px;
            width: 4px;
            height: 8px;
            border: solid #fff;
            border-width: 0 2px 2px 0;
            transform: rotate(45deg);
          }
          .markdown-editor-scrollbar li:has(> input[type="checkbox"]:checked) {
            color: ${theme.textMuted};
            text-decoration: line-through;
          }

          .markdown-editor-split-scrollbar::-webkit-scrollbar {
            width: 8px;
            height: 8px;
          }

          .markdown-editor-split-scrollbar::-webkit-scrollbar-track {
            background: transparent;
          }

          .markdown-editor-split-scrollbar::-webkit-scrollbar-thumb {
            background: ${isDarkMode ? 'rgba(133, 133, 133, 0.45)' : 'rgba(0, 0, 0, 0.22)'};
            border-radius: 999px;
            border: 2px solid transparent;
            background-clip: padding-box;
          }

          .markdown-editor-split-scrollbar::-webkit-scrollbar-thumb:hover {
            background: ${isDarkMode ? 'rgba(180, 180, 180, 0.65)' : 'rgba(0, 0, 0, 0.38)'};
            border: 2px solid transparent;
            background-clip: padding-box;
          }

          .markdown-editor-split-scrollbar::-webkit-scrollbar-thumb:active {
            background: ${isDarkMode ? 'rgba(200, 200, 200, 0.75)' : 'rgba(0, 0, 0, 0.48)'};
            border: 2px solid transparent;
            background-clip: padding-box;
          }

          .markdown-editor-split-scrollbar::-webkit-scrollbar-corner {
            background: transparent;
          }

          .markdown-editor-split-scrollbar {
            scrollbar-width: thin;
            scrollbar-color: ${isDarkMode ? 'rgba(133, 133, 133, 0.55) transparent' : 'rgba(0, 0, 0, 0.28) transparent'};
          }

          /* 分屏编辑区 textarea 滚动条 */
          textarea.markdown-editor-split-scrollbar {
            overflow: auto;
          }

          textarea.markdown-editor-split-scrollbar::-webkit-scrollbar {
            width: 8px;
          }

          textarea.markdown-editor-split-scrollbar::-webkit-scrollbar-track {
            background: transparent;
          }

          textarea.markdown-editor-split-scrollbar::-webkit-scrollbar-thumb {
            background: ${isDarkMode ? 'rgba(133, 133, 133, 0.45)' : 'rgba(0, 0, 0, 0.22)'};
            border-radius: 999px;
            border: 2px solid transparent;
            background-clip: padding-box;
          }

          textarea.markdown-editor-split-scrollbar::-webkit-scrollbar-thumb:hover {
            background: ${isDarkMode ? 'rgba(180, 180, 180, 0.65)' : 'rgba(0, 0, 0, 0.38)'};
          }
        `}
      </style>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          width: "100%",
          backgroundColor: theme.bg,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          color: theme.text,
        }}
      >
      {/* 顶栏：标题 + 操作合并为一行 */}
      <div
        style={{
          padding: "10px 16px",
          backgroundColor: theme.bgTertiary,
          borderBottom: `1px solid ${theme.border}`,
          display: "flex",
          alignItems: "center",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0, flex: "1 1 200px" }}>
          <span
            style={{
              fontSize: "15px",
              fontWeight: 600,
              color: theme.text,
              whiteSpace: "nowrap",
              letterSpacing: "0.2px",
            }}
          >
            Markdown 编辑器
          </span>
          {fileDisplayName && (
            <span
              style={{
                fontSize: "12px",
                color: theme.textSecondary,
                padding: "3px 10px",
                borderRadius: "999px",
                backgroundColor: theme.bgSecondary,
                border: `1px solid ${theme.border}`,
                maxWidth: "280px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={filePath ?? undefined}
            >
              {fileDisplayName}
            </span>
          )}
          {isWatching && (
            <span
              style={{
                fontSize: "11px",
                color: "#34d399",
                padding: "3px 9px",
                borderRadius: "999px",
                backgroundColor: isDarkMode ? "rgba(16, 185, 129, 0.12)" : "#ecfdf5",
                display: "flex",
                alignItems: "center",
                gap: "5px",
                whiteSpace: "nowrap",
              }}
              title="正在监听文件变化"
            >
              <span
                style={{
                  display: "inline-block",
                  width: "6px",
                  height: "6px",
                  borderRadius: "50%",
                  backgroundColor: "#34d399",
                  boxShadow: "0 0 0 2px rgba(52, 211, 153, 0.25)",
                }}
              />
              监听中
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <div style={{ position: "relative", display: "inline-flex" }} ref={recentFilesRef}>
            <div
              style={{
                display: "inline-flex",
                borderRadius: "6px",
                overflow: "hidden",
                border: `1px solid ${theme.buttonPrimary}`,
                boxShadow: isDarkMode ? "0 1px 2px rgba(0,0,0,0.3)" : "0 1px 2px rgba(0,0,0,0.08)",
              }}
            >
              <button
                onClick={handleOpenFile}
                disabled={isLoading}
                style={{
                  padding: "6px 14px",
                  backgroundColor: isLoading ? theme.textMuted : theme.buttonPrimary,
                  color: "white",
                  border: "none",
                  cursor: isLoading ? "not-allowed" : "pointer",
                  fontSize: "13px",
                  fontWeight: 500,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  transition: "background-color 0.15s",
                }}
                onMouseOver={(e) => {
                  if (!isLoading) {
                    e.currentTarget.style.backgroundColor = theme.buttonPrimaryHover;
                  }
                }}
                onMouseOut={(e) => {
                  if (!isLoading) {
                    e.currentTarget.style.backgroundColor = theme.buttonPrimary;
                  }
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                {isLoading ? "打开中..." : "打开文件"}
              </button>
              {recentFiles.length > 0 && (
                <button
                  onClick={() => setShowRecentFiles(!showRecentFiles)}
                  disabled={isLoading}
                  style={{
                    padding: "6px 10px",
                    backgroundColor: showRecentFiles
                      ? theme.buttonPrimaryHover
                      : theme.buttonPrimary,
                    color: "white",
                    border: "none",
                    borderLeft: `1px solid ${isDarkMode ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.25)"}`,
                    cursor: isLoading ? "not-allowed" : "pointer",
                    fontSize: "12px",
                    fontWeight: 500,
                    display: "inline-flex",
                    alignItems: "center",
                    transition: "background-color 0.15s",
                  }}
                  onMouseOver={(e) => {
                    if (!isLoading) {
                      e.currentTarget.style.backgroundColor = theme.buttonPrimaryHover;
                    }
                  }}
                  onMouseOut={(e) => {
                    if (!isLoading) {
                      e.currentTarget.style.backgroundColor = showRecentFiles
                        ? theme.buttonPrimaryHover
                        : theme.buttonPrimary;
                    }
                  }}
                  title="最近打开"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
              )}
            </div>
            {showRecentFiles && recentFiles.length > 0 && (
              <div
                className="markdown-editor-scrollbar"
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  marginTop: "6px",
                  backgroundColor: theme.bg,
                  border: `1px solid ${theme.border}`,
                  borderRadius: "8px",
                  boxShadow: isDarkMode
                    ? "0 8px 24px rgba(0, 0, 0, 0.45)"
                    : "0 8px 24px rgba(0, 0, 0, 0.12)",
                  minWidth: "280px",
                  maxWidth: "420px",
                  maxHeight: "320px",
                  overflowY: "auto",
                  zIndex: 1000,
                }}
              >
                <div
                  style={{
                    padding: "10px 14px",
                    fontSize: "12px",
                    fontWeight: 600,
                    color: theme.textSecondary,
                    borderBottom: `1px solid ${theme.border}`,
                    backgroundColor: theme.bgSecondary,
                  }}
                >
                  最近打开的文件
                </div>
                {recentFiles.map((file) => (
                  <div
                    key={file.path}
                    onClick={() => handleOpenRecentFile(file)}
                    style={{
                      padding: "10px 14px",
                      cursor: "pointer",
                      borderBottom: `1px solid ${theme.border}`,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      backgroundColor: theme.bg,
                    }}
                    onMouseOver={(e) => {
                      e.currentTarget.style.backgroundColor = theme.hover;
                    }}
                    onMouseOut={(e) => {
                      e.currentTarget.style.backgroundColor = theme.bg;
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: "13px",
                          fontWeight: 500,
                          color: theme.text,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={file.title || file.name}
                      >
                        {file.title || file.name}
                      </div>
                      <div
                        style={{
                          fontSize: "11px",
                          color: theme.textMuted,
                          marginTop: "2px",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={file.path}
                      >
                        {file.title
                          ? file.name
                          : file.path.length > 50
                            ? `...${file.path.slice(-47)}`
                            : file.path}
                      </div>
                    </div>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          await removeRecentFile(file.path);
                          const files = await getRecentFiles();
                          setRecentFiles(files);
                        } catch (err) {
                          console.error("删除最近文件记录失败:", err);
                        }
                      }}
                      style={{
                        padding: "4px 8px",
                        marginLeft: "8px",
                        backgroundColor: "transparent",
                        color: theme.textMuted,
                        border: "none",
                        borderRadius: "4px",
                        cursor: "pointer",
                        fontSize: "12px",
                        fontWeight: 500,
                      }}
                      onMouseOver={(e) => {
                        e.currentTarget.style.backgroundColor = isDarkMode ? "#5a1d1d" : "#fee2e2";
                        e.currentTarget.style.color = isDarkMode ? "#f48771" : "#dc2626";
                      }}
                      onMouseOut={(e) => {
                        e.currentTarget.style.backgroundColor = "transparent";
                        e.currentTarget.style.color = theme.textMuted;
                      }}
                      title="从列表中移除"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={handleRevealInFolder}
            disabled={!filePath}
            style={{
              padding: "6px 12px",
              backgroundColor: "transparent",
              color: filePath ? theme.textSecondary : theme.textMuted,
              border: `1px solid ${theme.border}`,
              borderRadius: "6px",
              cursor: filePath ? "pointer" : "not-allowed",
              fontSize: "13px",
              fontWeight: 500,
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              transition: "background-color 0.15s, color 0.15s, border-color 0.15s",
            }}
            onMouseOver={(e) => {
              if (filePath) {
                e.currentTarget.style.backgroundColor = theme.hover;
                e.currentTarget.style.color = theme.text;
                e.currentTarget.style.borderColor = theme.textSecondary;
              }
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
              e.currentTarget.style.color = filePath ? theme.textSecondary : theme.textMuted;
              e.currentTarget.style.borderColor = theme.border;
            }}
            title={filePath ? "在文件管理器中打开所在文件夹" : "请先打开文件"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <path d="M12 11v6" />
              <path d="M9 14l3 3 3-3" />
            </svg>
            打开所在文件夹
          </button>

          <button
            onClick={handleClear}
            style={{
              padding: "6px 12px",
              backgroundColor: "transparent",
              color: theme.textSecondary,
              border: `1px solid ${theme.border}`,
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "13px",
              fontWeight: 500,
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              transition: "background-color 0.15s, color 0.15s, border-color 0.15s",
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.backgroundColor = isDarkMode ? "rgba(244, 63, 94, 0.12)" : "rgba(220, 38, 38, 0.08)";
              e.currentTarget.style.color = isDarkMode ? "#f48771" : "#dc2626";
              e.currentTarget.style.borderColor = isDarkMode ? "rgba(244, 63, 94, 0.4)" : "rgba(220, 38, 38, 0.4)";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
              e.currentTarget.style.color = theme.textSecondary;
              e.currentTarget.style.borderColor = theme.border;
            }}
            title="清空当前内容"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 6h18" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            清空
          </button>

          <button
            onClick={toggleViewMode}
            style={{
              padding: "6px 12px",
              backgroundColor: theme.buttonPrimary,
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "13px",
              fontWeight: 500,
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              transition: "background-color 0.15s",
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.backgroundColor = theme.buttonPrimaryHover;
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.backgroundColor = theme.buttonPrimary;
            }}
            title={viewMode === "preview" ? "当前为预览，点击进入编辑" : "当前为编辑，点击进入预览"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            {viewMode === "preview" ? "编辑" : "预览"}
          </button>

          <button
            onClick={() => setIsDarkMode(!isDarkMode)}
            style={{
              padding: "6px 10px",
              backgroundColor: theme.bg,
              color: theme.textSecondary,
              border: `1px solid ${theme.border}`,
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "14px",
              lineHeight: 1,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "background-color 0.15s, color 0.15s",
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.backgroundColor = theme.hover;
              e.currentTarget.style.color = theme.text;
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.backgroundColor = theme.bg;
              e.currentTarget.style.color = theme.textSecondary;
            }}
            title={isDarkMode ? "切换到浅色模式" : "切换到深色模式"}
          >
            {isDarkMode ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
          <button
            onClick={handleClose}
            style={{
              padding: "6px 12px",
              backgroundColor: theme.bg,
              color: theme.textSecondary,
              border: `1px solid ${theme.border}`,
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "13px",
              fontWeight: 500,
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              transition: "background-color 0.15s, color 0.15s",
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.backgroundColor = theme.hover;
              e.currentTarget.style.color = theme.text;
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.backgroundColor = theme.bg;
              e.currentTarget.style.color = theme.textSecondary;
            }}
            title="关闭 (Esc)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
            关闭
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div
          style={{
            padding: "12px 20px",
            backgroundColor: theme.errorBg,
            borderBottom: `1px solid ${theme.border}`,
            color: theme.errorText,
            fontSize: "14px",
          }}
        >
          <strong>错误:</strong> {error}
        </div>
      )}

      {/* 主内容区 */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          gap: viewMode === "split" ? "1px" : "0",
          overflow: "hidden",
        }}
      >
        {/* 编辑区域 */}
        {viewMode === "split" && (
          <div
            style={{
              flex: 1,
              width: "auto",
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              backgroundColor: theme.bg,
              borderRight: `1px solid ${theme.border}`,
            }}
          >
            <textarea
              className={paneScrollClass}
              value={markdownContent}
              onChange={(e) => {
                isEditingRef.current = true;
                setMarkdownContent(e.target.value);
                // 延迟重置编辑标记，避免快速输入时频繁触发
                setTimeout(() => {
                  isEditingRef.current = false;
                }, 1000);
              }}
              onBlur={() => {
                // 失去焦点时重置编辑标记
                setTimeout(() => {
                  isEditingRef.current = false;
                }, 500);
              }}
              placeholder='在此输入或粘贴 Markdown 内容，或点击上方"打开文件"按钮打开本地文件...'
              style={{
                flex: 1,
                minHeight: 0,
                padding: "16px",
                border: "none",
                outline: "none",
                resize: "none",
                fontFamily: "'Courier New', monospace",
                fontSize: "14px",
                lineHeight: "1.6",
                backgroundColor: theme.bg,
                color: theme.text,
              }}
              spellCheck={false}
            />
          </div>
        )}

        {/* 预览区域（纯预览 / 编辑模式右侧） */}
        <div
          style={{
            flex: 1,
            width: viewMode === "split" ? "auto" : "100%",
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            backgroundColor: theme.bg,
            overflow: "hidden",
          }}
        >
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: "flex",
                overflow: "hidden",
              }}
            >
              {/* 侧边导航栏 */}
              {headings.length > 0 && (
                <div
                  className={paneScrollClass}
                  style={{
                    width: `${tocWidth}px`,
                    flexShrink: 0,
                    backgroundColor: theme.bgSecondary,
                    borderRight: `1px solid ${theme.border}`,
                    overflowY: "auto",
                    padding: "10px 8px",
                    fontSize: "12px",
                  }}
                >
                  <div
                    style={{
                      fontSize: "11px",
                      fontWeight: 600,
                      color: theme.textSecondary,
                      marginBottom: "10px",
                      padding: "0 8px",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <span>目录</span>
                    <span style={{ fontSize: "10px", color: theme.textMuted }}>
                      {headings.length} 项
                    </span>
                  </div>
                  {headings.map((heading, idx) => {
                    const isActive = activeHeadingId === heading.id;
                    const isLevel1 = heading.level === 1;
                    const isLastInGroup =
                      idx === headings.length - 1 ||
                      headings[idx + 1].level === 1;
                    return (
                      <div
                        key={heading.id}
                        onClick={() => scrollToHeading(heading.id)}
                        className="markdown-editor-toc-item"
                        style={{
                          position: "relative",
                          padding: "4px 8px",
                          paddingLeft: `${(heading.level - 1) * 14 + 8}px`,
                          cursor: "pointer",
                          borderRadius: "4px",
                          marginBottom: isLevel1 ? "8px" : isLastInGroup ? "8px" : "1px",
                          color: isActive
                            ? theme.activeHeadingText
                            : isLevel1
                              ? theme.text
                              : heading.level === 2
                                ? theme.textSecondary
                                : theme.textMuted,
                          backgroundColor: isActive
                            ? isDarkMode ? "rgba(74, 158, 255, 0.12)" : "rgba(59, 130, 246, 0.08)"
                            : "transparent",
                          fontWeight: isActive ? 600 : isLevel1 ? 500 : 400,
                          fontSize: isLevel1 ? "13px" : "12px",
                          lineHeight: 1.5,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          transition: "background-color 0.12s, color 0.12s",
                        }}
                        title={heading.text}
                      >
                        {isActive && (
                          <span
                            style={{
                              position: "absolute",
                              left: 0,
                              top: "50%",
                              transform: "translateY(-50%)",
                              width: "3px",
                              height: "16px",
                              borderRadius: "2px",
                              backgroundColor: theme.link,
                            }}
                          />
                        )}
                        {heading.level > 1 && (
                          <span
                            style={{
                              position: "absolute",
                              left: `${(heading.level - 1) * 14 + 2}px`,
                              top: 0,
                              bottom: 0,
                              width: "1px",
                              backgroundColor: theme.border,
                            }}
                          />
                        )}
                        {heading.text}
                      </div>
                    );
                  })}
                </div>
              )}
              {/* 目录宽度拖拽手柄 */}
              {headings.length > 0 && (
                <div
                  onMouseDown={startResizeToc}
                  style={{
                    width: "5px",
                    flexShrink: 0,
                    cursor: "col-resize",
                    backgroundColor: "transparent",
                    transition: "background-color 0.15s",
                  }}
                  onMouseOver={(e) => {
                    e.currentTarget.style.backgroundColor = theme.link;
                  }}
                  onMouseOut={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                  }}
                  title="拖动调整目录宽度"
                />
              )}
              {/* 预览内容 */}
              <div
                ref={previewRef}
                className={paneScrollClass}
                style={{
                  flex: 1,
                  padding: "24px 28px",
                  overflow: "auto",
                  backgroundColor: theme.bg,
                }}
              >
              {markdownContent ? (
                <div
                  style={{
                    maxWidth: "900px",
                    margin: "0 auto",
                    width: "100%",
                    color: theme.text,
                  }}
                >
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeRaw, rehypeHighlight]}
                    components={{
                      // 自定义样式 - 为标题添加 ID 以便导航
                      h1: ({ node, children, ...props }: any) => {
                        const text = extractText(children);
                        const heading = headings.find(h => h.text === text.trim());
                        const id = heading?.id || generateSlug(text);
                        return (
                          <h1
                            id={id}
                            style={{
                              fontSize: "1.75em",
                              fontWeight: 700,
                              marginTop: "0",
                              marginBottom: "0.75em",
                              lineHeight: 1.3,
                              scrollMarginTop: "80px",
                            }}
                            {...props}
                          >
                            {children}
                          </h1>
                        );
                      },
                      h2: ({ node, children, ...props }: any) => {
                        const text = extractText(children);
                        const heading = headings.find(h => h.text === text.trim());
                        const id = heading?.id || generateSlug(text);
                        return (
                          <h2
                            id={id}
                            style={{
                              fontSize: "1.5em",
                              fontWeight: 700,
                              marginTop: "0.83em",
                              marginBottom: "0.83em",
                              scrollMarginTop: "80px",
                            }}
                            {...props}
                          >
                            {children}
                          </h2>
                        );
                      },
                      h3: ({ node, children, ...props }: any) => {
                        const text = extractText(children);
                        const heading = headings.find(h => h.text === text.trim());
                        const id = heading?.id || generateSlug(text);
                        return (
                          <h3
                            id={id}
                            style={{
                              fontSize: "1.17em",
                              fontWeight: 700,
                              marginTop: "1em",
                              marginBottom: "1em",
                              scrollMarginTop: "80px",
                            }}
                            {...props}
                          >
                            {children}
                          </h3>
                        );
                      },
                      h4: ({ node, children, ...props }: any) => {
                        const text = extractText(children);
                        const heading = headings.find(h => h.text === text.trim());
                        const id = heading?.id || generateSlug(text);
                        return (
                          <h4
                            id={id}
                            style={{
                              fontSize: "1em",
                              fontWeight: 700,
                              marginTop: "1em",
                              marginBottom: "1em",
                              scrollMarginTop: "80px",
                            }}
                            {...props}
                          >
                            {children}
                          </h4>
                        );
                      },
                      h5: ({ node, children, ...props }: any) => {
                        const text = extractText(children);
                        const heading = headings.find(h => h.text === text.trim());
                        const id = heading?.id || generateSlug(text);
                        return (
                          <h5
                            id={id}
                            style={{
                              fontSize: "0.9em",
                              fontWeight: 700,
                              marginTop: "1em",
                              marginBottom: "1em",
                              scrollMarginTop: "80px",
                            }}
                            {...props}
                          >
                            {children}
                          </h5>
                        );
                      },
                      h6: ({ node, children, ...props }: any) => {
                        const text = extractText(children);
                        const heading = headings.find(h => h.text === text.trim());
                        const id = heading?.id || generateSlug(text);
                        return (
                          <h6
                            id={id}
                            style={{
                              fontSize: "0.85em",
                              fontWeight: 700,
                              marginTop: "1em",
                              marginBottom: "1em",
                              scrollMarginTop: "80px",
                            }}
                            {...props}
                          >
                            {children}
                          </h6>
                        );
                      },
                      p: ({ node, ...props }) => (
                        <p style={{ marginTop: "0", marginBottom: "0.75em", lineHeight: "1.6" }} {...props} />
                      ),
                      code: ({ node, className, ...props }: any) => {
                        const isBlock = className?.includes("language-") || node?.position?.start?.line !== node?.position?.end?.line;
                        if (!isBlock) {
                          return (
                            <code
                              style={{
                                backgroundColor: theme.codeBg,
                                padding: "2px 6px",
                                borderRadius: "4px",
                                fontFamily: "'Courier New', monospace",
                                fontSize: "0.9em",
                                color: theme.codeText,
                              }}
                              {...props}
                            />
                          );
                        }
                        return (
                          <code
                            style={{
                              fontFamily: "'Courier New', monospace",
                              fontSize: "0.9em",
                              color: theme.codeText,
                            }}
                            {...props}
                          />
                        );
                      },
                      pre: ({ node, children, ...props }: any) => {
                        const codeText = extractText(children);
                        return (
                          <div
                            className="markdown-editor-code-block"
                            style={{
                              position: "relative",
                              marginTop: "1em",
                              marginBottom: "1em",
                            }}
                          >
                            <button
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(codeText);
                                } catch (e) {
                                  console.error("复制代码失败:", e);
                                }
                              }}
                              className="markdown-editor-copy-btn"
                              title="复制代码"
                              style={{
                                position: "absolute",
                                top: "8px",
                                right: "8px",
                                padding: "4px 8px",
                                backgroundColor: isDarkMode ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
                                color: theme.textSecondary,
                                border: `1px solid ${theme.border}`,
                                borderRadius: "4px",
                                cursor: "pointer",
                                fontSize: "11px",
                                fontWeight: 500,
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px",
                                opacity: 0,
                                transition: "opacity 0.15s, background-color 0.15s, color 0.15s",
                                zIndex: 2,
                              }}
                              onMouseOver={(e) => {
                                e.currentTarget.style.backgroundColor = theme.hover;
                                e.currentTarget.style.color = theme.text;
                              }}
                              onMouseOut={(e) => {
                                e.currentTarget.style.backgroundColor = isDarkMode ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)";
                                e.currentTarget.style.color = theme.textSecondary;
                              }}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                              </svg>
                              复制
                            </button>
                            <pre
                              style={{
                                backgroundColor: theme.codeBg,
                                padding: "12px",
                                borderRadius: "6px",
                                overflow: "auto",
                                marginTop: 0,
                                marginBottom: 0,
                                color: theme.codeText,
                              }}
                              {...props}
                            >
                              {children}
                            </pre>
                          </div>
                        );
                      },
                      blockquote: ({ node, ...props }) => (
                        <blockquote
                          style={{
                            borderLeft: `4px solid ${theme.border}`,
                            paddingLeft: "16px",
                            marginLeft: 0,
                            marginTop: "1em",
                            marginBottom: "1em",
                            color: theme.textSecondary,
                          }}
                          {...props}
                        />
                      ),
                      ul: ({ node, ...props }) => (
                        <ul style={{ marginTop: "1em", marginBottom: "1em", paddingLeft: "2em" }} {...props} />
                      ),
                      ol: ({ node, ...props }) => (
                        <ol style={{ marginTop: "1em", marginBottom: "1em", paddingLeft: "2em" }} {...props} />
                      ),
                      li: ({ node, ...props }) => (
                        <li style={{ marginTop: "0.5em", marginBottom: "0.5em" }} {...props} />
                      ),
                      input: ({ node, ...props }: any) => (
                        <input
                          type="checkbox"
                          {...props}
                          disabled={false}
                          onChange={(e) => {
                            // 任务清单勾选状态（仅本地交互，不写回文件）
                            const li = e.currentTarget.closest("li");
                            if (li) {
                              li.style.color = e.currentTarget.checked
                                ? theme.textMuted
                                : theme.text;
                              li.style.textDecoration = e.currentTarget.checked
                                ? "line-through"
                                : "none";
                            }
                          }}
                        />
                      ),
                      a: ({ node, ...props }: any) => (
                        <a
                          style={{ color: theme.link, textDecoration: "underline" }}
                          target="_blank"
                          rel="noopener noreferrer"
                          {...props}
                        />
                      ),
                      table: ({ node, ...props }) => (
                        <div style={{ overflowX: "auto", marginTop: "1em", marginBottom: "1em" }}>
                          <table
                            style={{
                              borderCollapse: "collapse",
                              width: "100%",
                              fontSize: "14px",
                            }}
                            {...props}
                          />
                        </div>
                      ),
                      tr: ({ node, ...props }) => (
                        <tr
                          style={{ transition: "background-color 0.12s" }}
                          {...props}
                        />
                      ),
                      th: ({ node, ...props }) => (
                        <th
                          style={{
                            border: `1px solid ${theme.border}`,
                            padding: "8px 12px",
                            backgroundColor: theme.bgSecondary,
                            fontWeight: 600,
                            textAlign: "left",
                            color: theme.text,
                            position: "sticky",
                            top: 0,
                            zIndex: 1,
                          }}
                          {...props}
                        />
                      ),
                      td: ({ node, ...props }) => (
                        <td
                          style={{
                            border: `1px solid ${theme.border}`,
                            padding: "8px 12px",
                            color: theme.text,
                          }}
                          {...props}
                        />
                      ),
                      img: ({ node, ...props }: any) => (
                        <img
                          style={{
                            maxWidth: "100%",
                            height: "auto",
                            borderRadius: "6px",
                            marginTop: "1em",
                            marginBottom: "1em",
                            display: "block",
                          }}
                          {...props}
                        />
                      ),
                      hr: ({ node, ...props }) => (
                        <hr
                          style={{
                            border: "none",
                            borderTop: `1px solid ${theme.border}`,
                            marginTop: "2em",
                            marginBottom: "2em",
                          }}
                          {...props}
                        />
                      ),
                    }}
                  >
                    {markdownContent}
                  </ReactMarkdown>
                </div>
              ) : (
                <div
                  style={{
                    color: theme.textMuted,
                    textAlign: "center",
                    padding: "40px",
                    fontSize: "14px",
                  }}
                >
                  {filePath ? "文件内容为空" : "预览内容将显示在这里..."}
                </div>
              )}
              </div>
            </div>
          </div>
      </div>
    </div>
    </>
  );
}

