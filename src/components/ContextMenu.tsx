import { useRef, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import type { FileOpenHandler, FileOpenRules } from "../types";
import type { SearchResult } from "../utils/resultUtils";
import { clampContextMenuPosition } from "../utils/contextMenuUtils";
import {
  getFileExtension,
  getFileOpenRuleOptions,
  isConfigurableFileExtension,
  resolveFileOpenHandler,
} from "../utils/fileOpenUtils";

function getAppIndexSearchQueryFromResult(result: SearchResult): string {
  const raw =
    result.app?.name ||
    result.displayName ||
    result.path.split(/[/\\]/).pop() ||
    "";
  return raw.replace(/\.(exe|lnk)$/i, "").trim();
}

function getResultFilePath(result: SearchResult): string {
  return result.file?.path ?? result.everything?.path ?? result.path;
}

const iconClass = "h-4 w-4";

function IconExternalLink() {
  return (
    <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5M10.5 13.5L21 3m0 0h-5.25M21 3v5.25" />
    </svg>
  );
}

function IconFolder() {
  return (
    <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
    </svg>
  );
}

function IconPencil() {
  return (
    <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
    </svg>
  );
}

function IconCog() {
  return (
    <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function IconCopy() {
  return (
    <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 8V6a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2h-2M8 8H6a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-2M8 8h8v8" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  );
}

const BROWSER_ITEMS = [
  { id: "edge", label: "Edge", badge: "E", badgeClass: "bg-[#0078D4]" },
  { id: "chrome", label: "Chrome", badge: "C", badgeClass: "bg-[#EA4335]" },
  { id: "firefox", label: "Firefox", badge: "F", badgeClass: "bg-[#FF7139]" },
] as const;

function MenuDivider() {
  return <div className="mx-2.5 my-1.5 h-px bg-gray-100" />;
}

function MenuItem({
  children,
  icon,
  onSelect,
  danger = false,
  muted = false,
  accent = false,
  trailing,
  title,
}: {
  children: ReactNode;
  icon?: ReactNode;
  onSelect: () => void | Promise<void>;
  danger?: boolean;
  muted?: boolean;
  accent?: boolean;
  trailing?: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await onSelect();
      }}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px] leading-snug transition-colors ${
        danger
          ? "text-red-600 hover:bg-red-50"
          : muted
            ? "text-gray-500 hover:bg-gray-100 hover:text-gray-700"
            : accent
              ? "font-medium text-gray-800 hover:bg-blue-50"
              : "text-gray-700 hover:bg-gray-100"
      }`}
    >
      {icon && (
        <span
          aria-hidden="true"
          className={`flex h-5 w-5 shrink-0 items-center justify-center ${
            danger ? "text-red-500" : accent ? "text-blue-500" : "text-gray-400"
          }`}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </button>
  );
}

interface ContextMenuProps {
  menu: { x: number; y: number; result: SearchResult } | null;
  onClose: () => void;
  /** 菜单布局完成后回调，用于临时撑高启动器窗口 */
  onMenuLayout?: (info: { bottom: number }) => void;
  onRevealInFolder: () => Promise<void>;
  /** 文件左键打开方式规则 */
  fileOpenRules?: FileOpenRules;
  /** 设置某扩展名的左键打开方式 */
  onSetFileOpenHandler?: (ext: string, handler: FileOpenHandler) => Promise<void>;
  /** 应用类型：请求从索引删除（由父级展示确认框后再执行） */
  onRequestRemoveFromAppIndex?: (info: {
    path: string;
    displayName: string;
  }) => void;
  /** 应用类型：打开应用中心 → 应用索引列表，并按名称筛选 */
  onRequestOpenAppIndexSameName?: (info: { searchQuery: string }) => void;
  onEditMemo: () => void;
  onDeleteMemo: (memoId: string) => Promise<void>;
  onOpenUrl: (url: string) => Promise<void>;
  /** 使用指定浏览器打开 URL（仅 URL 类型显示对应子菜单） */
  onOpenUrlWithBrowser?: (url: string, browser: string) => Promise<void>;
  /** 打开应用中心浏览器路由设置页 */
  onOpenBrowserRules?: () => void;
  onDeleteHistory?: (key: string) => Promise<void>;
  onEditRemark?: (url: string) => Promise<void>;
  onCopyJson: (json: string) => Promise<void>;
  onCopyAiAnswer: (answer: string) => Promise<void>;
  query: string;
  selectedMemoId: string | null;
  onRefreshMemos: () => Promise<void>;
  onCloseMemoModal: () => void;
}

export function ContextMenu({
  menu,
  onClose,
  onMenuLayout,
  onRevealInFolder,
  fileOpenRules = {},
  onSetFileOpenHandler,
  onRequestRemoveFromAppIndex,
  onRequestOpenAppIndexSameName,
  onEditMemo,
  onDeleteMemo,
  onOpenUrl,
  onOpenUrlWithBrowser,
  onOpenBrowserRules,
  onDeleteHistory,
  onEditRemark,
  onCopyJson,
  onCopyAiAnswer,
  query: _query,
  selectedMemoId,
  onRefreshMemos,
  onCloseMemoModal,
}: ContextMenuProps) {
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  const onMenuLayoutRef = useRef(onMenuLayout);

  onMenuLayoutRef.current = onMenuLayout;

  useEffect(() => {
    const handleResize = () => {
      setViewportHeight(window.innerHeight);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useLayoutEffect(() => {
    if (!menu || !contextMenuRef.current) {
      setPosition(null);
      return;
    }

    const rect = contextMenuRef.current.getBoundingClientRect();
    const clamped = clampContextMenuPosition(menu.x, menu.y, {
      width: rect.width,
      height: rect.height,
    });
    setPosition(clamped);
    onMenuLayoutRef.current?.({ bottom: clamped.y + rect.height });
  }, [menu, viewportHeight]);

  // Close context menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    if (menu) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
        document.removeEventListener("keydown", handleEscape);
      };
    }
  }, [menu, onClose]);

  if (!menu) return null;

  // 检查是否有菜单项需要显示
  const hasFileMenu =
    menu.result.type === "file" ||
    menu.result.type === "everything" ||
    menu.result.type === "app";
  
  // 检查是否是 UWP 应用（shell:AppsFolder 路径），UWP 应用没有传统意义上的所在文件夹
  const isUwpApp = menu.result.path.toLowerCase().startsWith("shell:appsfolder");
  const canRevealInFolder = hasFileMenu && !isUwpApp;

  const resultFilePath = getResultFilePath(menu.result);
  const configurableExt = getFileExtension(resultFilePath);
  const canSetFileOpenHandler =
    (menu.result.type === "file" || menu.result.type === "everything") &&
    isConfigurableFileExtension(configurableExt) &&
    Boolean(onSetFileOpenHandler);
  const currentFileOpenHandler = canSetFileOpenHandler
    ? resolveFileOpenHandler(resultFilePath, fileOpenRules)
    : "default";
  const fileOpenRuleOptions = canSetFileOpenHandler
    ? getFileOpenRuleOptions(configurableExt)
    : [];

  const canRemoveFromAppIndex =
    menu.result.type === "app" && Boolean(onRequestRemoveFromAppIndex);

  const canOpenAppIndexSameName =
    menu.result.type === "app" && Boolean(onRequestOpenAppIndexSameName);
  
  const hasMemoMenu = menu.result.type === "memo" && menu.result.memo;
  const hasUrlMenu = menu.result.type === "url" && menu.result.url;
  const hasJsonMenu = menu.result.type === "json_formatter" && menu.result.jsonContent;
  const hasAiMenu = menu.result.type === "ai" && menu.result.aiAnswer;

  // 如果没有菜单项，不显示菜单
  if (
    !canRevealInFolder &&
    !canSetFileOpenHandler &&
    !canOpenAppIndexSameName &&
    !canRemoveFromAppIndex &&
    !hasMemoMenu &&
    !hasUrlMenu &&
    !hasJsonMenu &&
    !hasAiMenu
  ) {
    return null;
  }

  const handleDeleteMemoClick = async () => {
    if (!menu.result.memo) return;
    if (!confirm("确定要删除这条备忘录吗？")) {
      onClose();
      return;
    }
    try {
      await onDeleteMemo(menu.result.memo.id);
      await onRefreshMemos();
      onClose();
      // 如果删除的是当前显示的备忘录，关闭弹窗
      if (selectedMemoId === menu.result.memo.id) {
        onCloseMemoModal();
      }
    } catch (error) {
      console.error("Failed to delete memo:", error);
      alert(`删除备忘录失败: ${error}`);
      onClose();
    }
  };

  return (
    <div
      ref={contextMenuRef}
      className="fixed z-50 min-w-[212px] select-none overflow-hidden rounded-xl border border-gray-200/90 bg-white py-1.5 px-1 text-gray-800 shadow-[0_12px_32px_rgba(15,23,42,0.14),0_2px_8px_rgba(15,23,42,0.06)]"
      style={{
        left: `${(position ?? menu).x}px`,
        top: `${(position ?? menu).y}px`,
      }}
    >
      {canRevealInFolder && (
        <MenuItem icon={<IconFolder />} accent onSelect={() => onRevealInFolder()}>
          打开所在文件夹
        </MenuItem>
      )}
      {canSetFileOpenHandler && (
        <>
          {(canRevealInFolder || canOpenAppIndexSameName) && <MenuDivider />}
          <div className="mx-0.5 my-0.5 rounded-lg bg-gray-50/90 py-1">
            <div className="px-2.5 pb-1 pt-0.5 text-[11px] font-medium tracking-wide text-gray-400">
              左键打开方式（.{configurableExt}）
            </div>
            {fileOpenRuleOptions.map((option) => {
              const selected = currentFileOpenHandler === option.handler;
              return (
                <MenuItem
                  key={option.handler}
                  onSelect={async () => {
                    try {
                      await onSetFileOpenHandler!(configurableExt, option.handler);
                      onClose();
                    } catch (error) {
                      console.error("Failed to set file open handler:", error);
                      alert(`设置左键打开方式失败: ${error}`);
                      onClose();
                    }
                  }}
                  trailing={
                    <span
                      aria-hidden="true"
                      className={`flex h-4 w-4 shrink-0 items-center justify-center ${selected ? "text-blue-600" : "text-transparent"}`}
                    >
                      <IconCheck />
                    </span>
                  }
                >
                  {option.label}
                </MenuItem>
              );
            })}
          </div>
        </>
      )}
      {canOpenAppIndexSameName && (
        <MenuItem
          icon={<IconSearch />}
          title="打开应用中心中的应用索引列表，并搜索与当前项同名的条目"
          onSelect={() => {
            const q = getAppIndexSearchQueryFromResult(menu.result);
            if (q) {
              onRequestOpenAppIndexSameName!({ searchQuery: q });
            }
            onClose();
          }}
        >
          查看同名索引…
        </MenuItem>
      )}
      {canRemoveFromAppIndex && (
        <MenuItem
          icon={<IconTrash />}
          danger
          onSelect={() => {
            const displayName =
              menu.result.displayName ||
              menu.result.path.split(/[/\\]/).pop() ||
              "该应用";
            onRequestRemoveFromAppIndex!({
              path: menu.result.path,
              displayName,
            });
            onClose();
          }}
        >
          从应用索引删除
        </MenuItem>
      )}
      {hasMemoMenu && (
        <>
          <MenuItem
            icon={<IconPencil />}
            onSelect={() => {
              onEditMemo();
              onClose();
            }}
          >
            编辑备忘录
          </MenuItem>
          <MenuItem icon={<IconTrash />} danger onSelect={handleDeleteMemoClick}>
            删除备忘录
          </MenuItem>
        </>
      )}
      {hasUrlMenu && (
        <>
          <MenuItem
            icon={<IconExternalLink />}
            accent
            onSelect={async () => {
              try {
                await onOpenUrl(menu.result.url!);
                onClose();
              } catch (error) {
                console.error("Failed to open URL:", error);
                alert(`打开链接失败: ${error}`);
                onClose();
              }
            }}
          >
            打开链接
          </MenuItem>
          {onOpenUrlWithBrowser && (
            <div className="mx-0.5 my-1 rounded-lg bg-gray-50/90 py-1">
              <div className="px-2.5 pb-1 pt-0.5 text-[11px] font-medium tracking-wide text-gray-400">
                用指定浏览器打开
              </div>
              {BROWSER_ITEMS.map((browser) => (
                <MenuItem
                  key={browser.id}
                  icon={
                    <span className={`flex h-[18px] w-[18px] items-center justify-center rounded-full text-[10px] font-semibold leading-none text-white ${browser.badgeClass}`}>
                      {browser.badge}
                    </span>
                  }
                  onSelect={async () => {
                    try {
                      await onOpenUrlWithBrowser(menu.result.url!, browser.id);
                      onClose();
                    } catch (error) {
                      console.error(`Failed to open URL with ${browser.label}:`, error);
                      alert(`打开失败: ${error}`);
                      onClose();
                    }
                  }}
                >
                  {browser.label}
                </MenuItem>
              ))}
            </div>
          )}
          {onEditRemark && (
            <MenuItem
              icon={<IconPencil />}
              onSelect={async () => {
                try {
                  await onEditRemark(menu.result.url!);
                  onClose();
                } catch (error) {
                  console.error("Failed to edit remark:", error);
                  alert(`修改备注失败: ${error}`);
                  onClose();
                }
              }}
            >
              修改备注
            </MenuItem>
          )}
          {onDeleteHistory && (
            <MenuItem
              icon={<IconTrash />}
              danger
              onSelect={async () => {
                try {
                  await onDeleteHistory(menu.result.url!);
                  onClose();
                } catch (error) {
                  console.error("Failed to delete history:", error);
                  alert(`删除历史记录失败: ${error}`);
                  onClose();
                }
              }}
            >
              删除历史记录
            </MenuItem>
          )}
          {onOpenBrowserRules && (
            <>
              <MenuDivider />
              <MenuItem
                icon={<IconCog />}
                muted
                onSelect={() => {
                  onOpenBrowserRules();
                  onClose();
                }}
              >
                浏览器路由规则
              </MenuItem>
            </>
          )}
        </>
      )}
      {hasJsonMenu && (
        <MenuItem
          icon={<IconCopy />}
          onSelect={async () => {
            try {
              await onCopyJson(menu.result.jsonContent!);
              onClose();
            } catch (error) {
              console.error("Failed to copy JSON:", error);
              alert("复制失败，请手动复制");
              onClose();
            }
          }}
        >
          复制 JSON
        </MenuItem>
      )}
      {hasAiMenu && (
        <MenuItem
          icon={<IconCopy />}
          onSelect={async () => {
            try {
              await onCopyAiAnswer(menu.result.aiAnswer!);
              onClose();
            } catch (error) {
              console.error("Failed to copy AI answer:", error);
              alert("复制失败，请手动复制");
              onClose();
            }
          }}
        >
          复制回答
        </MenuItem>
      )}
    </div>
  );
}
