import { useState, useEffect, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import { tauriApi } from "../api/tauri";
import type { MemoItem } from "../types";
import { formatFullDateTime } from "../utils/dateUtils";

export function MemoWindow() {
  const [memos, setMemos] = useState<MemoItem[]>([]);
  const [selectedMemo, setSelectedMemo] = useState<MemoItem | null>(null);
  const [memoEditTitle, setMemoEditTitle] = useState("");
  const [memoEditContent, setMemoEditContent] = useState("");
  const [isEditingMemo, setIsEditingMemo] = useState(false);
  const [isMemoListMode, setIsMemoListMode] = useState(true);

  const loadMemos = async () => {
    try {
      const list = await tauriApi.getAllMemos();
      setMemos(list);
    } catch (error) {
      console.error("Failed to load memos:", error);
    }
  };

  const handleClose = useCallback(async () => {
    const window = getCurrentWindow();
    await window.close();
  }, []);

  const handleHide = useCallback(async () => {
    const window = getCurrentWindow();
    await window.hide();
  }, []);

  useEffect(() => {
    loadMemos();
  }, []);

  // ESC 键处理
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.keyCode === 27) {
        e.preventDefault();
        e.stopPropagation();
        
        if (isMemoListMode) {
          // 列表模式：关闭窗口
          await handleClose();
        } else if (isEditingMemo && !selectedMemo) {
          // 新建模式：返回列表
          setIsMemoListMode(true);
          setSelectedMemo(null);
          setMemoEditTitle("");
          setMemoEditContent("");
          setIsEditingMemo(false);
        } else if (isEditingMemo && selectedMemo) {
          // 编辑模式：取消编辑
          setIsEditingMemo(false);
          setMemoEditTitle(selectedMemo.title);
          setMemoEditContent(selectedMemo.content);
        } else {
          // 详情模式：返回列表
          setIsMemoListMode(true);
          setSelectedMemo(null);
          setIsEditingMemo(false);
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isMemoListMode, isEditingMemo, selectedMemo, handleClose]);

  const resetMemoState = () => {
    setIsMemoListMode(true);
    setSelectedMemo(null);
    setMemoEditTitle("");
    setMemoEditContent("");
    setIsEditingMemo(false);
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-gray-50">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-200 bg-white">
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
                await handleClose();
              } else if (isEditingMemo && !selectedMemo) {
                setIsMemoListMode(true);
                setSelectedMemo(null);
                setMemoEditTitle("");
                setMemoEditContent("");
                setIsEditingMemo(false);
              } else {
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
          <div className="space-y-2">
            {memos.length === 0 ? (
              <div className="text-sm text-gray-500">还没有任何备忘录</div>
            ) : (
              memos.map((memo) => (
                <div
                  key={memo.id}
                  className="p-3 border border-gray-200 rounded hover:bg-white transition-colors group"
                >
                  <div
                    className="cursor-pointer"
                    onClick={(e) => {
                      // 如果点击的是按钮或其子元素，不执行操作
                      const target = e.target as HTMLElement;
                      if (target.closest('button')) {
                        return;
                      }
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
                    <div className="text-xs text-gray-500 truncate mt-1">
                      {memo.content ? memo.content.slice(0, 80) : "(无内容)"}
                      {memo.content && memo.content.length > 80 ? "..." : ""}
                    </div>
                    <div className="text-[11px] text-gray-400 mt-1">
                      更新于 {formatFullDateTime(memo.updated_at)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          // 组合标题和内容
                          const textToPaste = memo.title 
                            ? (memo.content ? `${memo.title}\n${memo.content}` : memo.title)
                            : (memo.content || "(无内容)");
                          // 使用 navigator.clipboard.writeText 设置剪贴板（和复制按钮一样的方式）
                          await navigator.clipboard.writeText(textToPaste);
                          // 先隐藏窗口（而不是关闭），让用户有时间切换到目标窗口，同时保持 JavaScript 上下文
                          await handleHide();
                          // 然后只模拟按键（剪贴板已经通过 navigator.clipboard.writeText 设置好了）
                          await tauriApi.pasteTextToCursor("");
                        } catch (error) {
                          console.error("Failed to paste to cursor:", error);
                          alert(`插入失败: ${error}`);
                        }
                      }}
                      className="px-2 py-1 text-xs text-purple-600 hover:text-purple-800 hover:bg-purple-50 rounded border border-purple-300 hover:border-purple-400 transition-colors"
                      title="插入到系统光标位置"
                    >
                      插入
                    </button>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          const textToCopy = memo.title || "(无标题)";
                          await navigator.clipboard.writeText(textToCopy);
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
                          // 复制成功后关闭窗口
                          await handleClose();
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
                        const confirmed = await confirm("确定要删除这条备忘录吗？", {
                          title: "删除确认",
                          kind: "warning",
                        });
                        if (!confirmed) {
                          return;
                        }
                        try {
                          await tauriApi.deleteMemo(memo.id);
                          await loadMemos();
                          // 如果删除的是当前显示的备忘录，重置状态
                          if (selectedMemo?.id === memo.id) {
                            resetMemoState();
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
          <div className="space-y-4 max-w-2xl mx-auto">
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
          <div className="space-y-4 max-w-2xl mx-auto">
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
                  {formatFullDateTime(selectedMemo.created_at)}
                </div>
                <div>
                  更新时间:{" "}
                  {formatFullDateTime(selectedMemo.updated_at)}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Footer */}
      {isEditingMemo && (
        <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-200 bg-white">
          <button
            onClick={async () => {
              try {
                if (selectedMemo) {
                  await tauriApi.updateMemo(
                    selectedMemo.id,
                    memoEditTitle,
                    memoEditContent
                  );
                  await loadMemos();
                  const list = await tauriApi.getAllMemos();
                  const updated = list.find((m) => m.id === selectedMemo.id);
                  if (updated) {
                    setSelectedMemo(updated);
                  }
                  setIsEditingMemo(false);
                } else {
                  if (!memoEditTitle.trim() && !memoEditContent.trim()) {
                    alert("请输入标题或内容");
                    return;
                  }
                  const newMemo = await tauriApi.addMemo(
                    memoEditTitle.trim() || "无标题",
                    memoEditContent.trim()
                  );
                  await loadMemos();
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
                setIsEditingMemo(false);
                setMemoEditTitle(selectedMemo.title);
                setMemoEditContent(selectedMemo.content);
              } else {
                setIsMemoListMode(true);
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
                const confirmed = await confirm("确定要删除这条备忘录吗？", {
                  title: "删除确认",
                  kind: "warning",
                });
                if (!confirmed) {
                  return;
                }
                try {
                  await tauriApi.deleteMemo(selectedMemo.id);
                  await loadMemos();
                  resetMemoState();
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
  );
}

