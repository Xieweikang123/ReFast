import { useRef, useEffect } from "react";
import type { SearchResult } from "../utils/resultUtils";

function getAppIndexSearchQueryFromResult(result: SearchResult): string {
  const raw =
    result.app?.name ||
    result.displayName ||
    result.path.split(/[/\\]/).pop() ||
    "";
  return raw.replace(/\.(exe|lnk)$/i, "").trim();
}

interface ContextMenuProps {
  menu: { x: number; y: number; result: SearchResult } | null;
  onClose: () => void;
  onRevealInFolder: () => Promise<void>;
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
  onRevealInFolder,
  onRequestRemoveFromAppIndex,
  onRequestOpenAppIndexSameName,
  onEditMemo,
  onDeleteMemo,
  onOpenUrl,
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
      className="fixed bg-white border border-gray-200 text-gray-800 rounded-lg shadow-xl py-1 min-w-[160px] z-50"
      style={{
        left: `${menu.x}px`,
        top: `${menu.y}px`,
      }}
    >
      {canRevealInFolder && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRevealInFolder();
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
      {canOpenAppIndexSameName && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const q = getAppIndexSearchQueryFromResult(menu.result);
            if (q) {
              onRequestOpenAppIndexSameName!({ searchQuery: q });
            }
            onClose();
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 transition-colors"
          title="打开应用中心中的应用索引列表，并搜索与当前项同名的条目"
        >
          查看同名索引…
        </button>
      )}
      {canRemoveFromAppIndex && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
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
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
        >
          从应用索引删除
        </button>
      )}
      {hasMemoMenu && (
        <>
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onEditMemo();
              onClose();
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
            onClick={handleDeleteMemoClick}
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
        <>
          <button
            onClick={async (e) => {
              e.preventDefault();
              e.stopPropagation();
              try {
                await onOpenUrl(menu.result.url!);
                onClose();
              } catch (error) {
                console.error("Failed to open URL:", error);
                alert(`打开链接失败: ${error}`);
                onClose();
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
          {onEditRemark && (
            <button
              onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                try {
                  await onEditRemark(menu.result.url!);
                  onClose();
                } catch (error) {
                  console.error("Failed to edit remark:", error);
                  alert(`修改备注失败: ${error}`);
                  onClose();
                }
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 transition-colors"
            >
              修改备注
            </button>
          )}
          {onDeleteHistory && (
            <button
              onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                try {
                  await onDeleteHistory(menu.result.url!);
                  onClose();
                } catch (error) {
                  console.error("Failed to delete history:", error);
                  alert(`删除历史记录失败: ${error}`);
                  onClose();
                }
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
            >
              删除历史记录
            </button>
          )}
        </>
      )}
      {hasJsonMenu && (
        <button
          onClick={async (e) => {
            e.preventDefault();
            e.stopPropagation();
            try {
              await onCopyJson(menu.result.jsonContent!);
              onClose();
            } catch (error) {
              console.error("Failed to copy JSON:", error);
              alert("复制失败，请手动复制");
              onClose();
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
              await onCopyAiAnswer(menu.result.aiAnswer!);
              onClose();
            } catch (error) {
              console.error("Failed to copy AI answer:", error);
              alert("复制失败，请手动复制");
              onClose();
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
}

