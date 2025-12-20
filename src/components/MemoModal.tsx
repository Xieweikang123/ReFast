import type { MemoItem } from "../types";
import { tauriApi } from "../api/tauri";
import { formatFullDateTime } from "../utils/dateUtils";

interface MemoModalProps {
  isOpen: boolean;
  isListMode: boolean;
  memos: MemoItem[];
  selectedMemo: MemoItem | null;
  isEditing: boolean;
  editTitle: string;
  editContent: string;
  onClose: () => void;
  onSetListMode: (mode: boolean) => void;
  onSetSelectedMemo: (memo: MemoItem | null) => void;
  onSetEditing: (editing: boolean) => void;
  onSetEditTitle: (title: string) => void;
  onSetEditContent: (content: string) => void;
  onRefreshMemos: () => Promise<void>;
  onHideLauncher: () => Promise<void>;
  tauriApi: typeof tauriApi;
}

export function MemoModal({
  isOpen,
  isListMode,
  memos,
  selectedMemo,
  isEditing,
  editTitle,
  editContent,
  onClose,
  onSetListMode,
  onSetSelectedMemo,
  onSetEditing,
  onSetEditTitle,
  onSetEditContent,
  onRefreshMemos,
  onHideLauncher,
  tauriApi,
}: MemoModalProps) {
  if (!isOpen) return null;

  const handleClose = async () => {
    if (isListMode) {
      // 列表模式：关闭并隐藏窗口（插件像独立软件一样运行）
      onClose();
      onSetListMode(true);
      onSetSelectedMemo(null);
      onSetEditing(false);
      // 延迟隐藏窗口，让关闭动画完成
      setTimeout(() => {
        onHideLauncher();
      }, 100);
    } else if (isEditing && !selectedMemo) {
      // 新建模式：返回列表
      onSetListMode(true);
      onSetSelectedMemo(null);
      onSetEditTitle("");
      onSetEditContent("");
      onSetEditing(false);
    } else {
      // 详情/编辑模式：返回列表
      onSetListMode(true);
      onSetSelectedMemo(null);
      onSetEditing(false);
    }
  };

  const handleSave = async () => {
    try {
      if (selectedMemo) {
        // 编辑模式：更新已有备忘录
        await tauriApi.updateMemo(selectedMemo.id, editTitle, editContent);
        // 刷新备忘录列表
        await onRefreshMemos();
        // 更新当前选中的备忘录
        const list = await tauriApi.getAllMemos();
        const updated = list.find((m) => m.id === selectedMemo.id);
        if (updated) {
          onSetSelectedMemo(updated);
        }
        onSetEditing(false);
      } else {
        // 新建模式：创建新备忘录
        if (!editTitle.trim() && !editContent.trim()) {
          alert("请输入标题或内容");
          return;
        }
        const newMemo = await tauriApi.addMemo(
          editTitle.trim() || "无标题",
          editContent.trim()
        );
        // 刷新备忘录列表
        await onRefreshMemos();
        // 切换到查看模式，显示新创建的备忘录
        onSetSelectedMemo(newMemo);
        onSetEditing(false);
      }
    } catch (error) {
      console.error("Failed to save memo:", error);
      alert(`保存备忘录失败: ${error}`);
    }
  };

  const handleDelete = async (memoId: string) => {
    try {
      await tauriApi.deleteMemo(memoId);
      // 刷新备忘录列表
      await onRefreshMemos();
      // 如果删除的是当前显示的备忘录，关闭弹窗
      if (selectedMemo?.id === memoId) {
        onClose();
        onSetSelectedMemo(null);
      }
    } catch (error) {
      console.error("Failed to delete memo:", error);
      alert(`删除备忘录失败: ${error}`);
    }
  };

  const handleDeleteInEdit = async () => {
    const memoToDelete = selectedMemo;
    if (!memoToDelete) return;
    if (!confirm("确定要删除这条备忘录吗？")) return;
    try {
      await tauriApi.deleteMemo(memoToDelete.id);
      // 刷新备忘录列表
      await onRefreshMemos();
      onClose();
      onSetSelectedMemo(null);
      onSetEditing(false);
    } catch (error) {
      console.error("Failed to delete memo:", error);
      alert(`删除备忘录失败: ${error}`);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 overflow-auto">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl min-h-[500px] max-h-[calc(100vh-32px)] flex flex-col m-4 my-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-800">
            {isListMode
              ? "备忘录列表"
              : selectedMemo
              ? isEditing
                ? "编辑备忘录"
                : "备忘录详情"
              : "新建备忘录"}
          </h2>
          <div className="flex items-center gap-2">
            {isListMode && (
              <button
                onClick={() => {
                  // 切换到新建模式
                  onSetListMode(false);
                  onSetSelectedMemo(null);
                  onSetEditTitle("");
                  onSetEditContent("");
                  onSetEditing(true);
                }}
                className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
              >
                新建
              </button>
            )}
            {!isListMode && !isEditing && selectedMemo && (
              <button
                onClick={() => {
                  onSetEditing(true);
                }}
                className="px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-50 rounded transition-colors"
              >
                编辑
              </button>
            )}
            <button
              onClick={handleClose}
              className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded transition-colors"
            >
              {isListMode ? "关闭" : "返回"}
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {isListMode ? (
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
                        if (target.closest("button")) {
                          return;
                        }
                        // 点击列表项进入单条查看模式
                        onSetListMode(false);
                        onSetSelectedMemo(memo);
                        onSetEditTitle(memo.title);
                        onSetEditContent(memo.content);
                        onSetEditing(false);
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
                        更新于{" "}
                        {formatFullDateTime(memo.updated_at)}
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
                            // 先隐藏窗口，让用户有时间切换到目标窗口
                            await onHideLauncher();
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
                            await onHideLauncher();
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
                          await handleDelete(memo.id);
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
          ) : isEditing ? (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  标题
                </label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => onSetEditTitle(e.target.value)}
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
                  value={editContent}
                  onChange={(e) => onSetEditContent(e.target.value)}
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
        {isEditing && (
          <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-200">
            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
            >
              保存
            </button>
            <button
              onClick={() => {
                if (selectedMemo) {
                  // 编辑模式：取消编辑，恢复原内容
                  onSetEditing(false);
                  onSetEditTitle(selectedMemo.title);
                  onSetEditContent(selectedMemo.content);
                } else {
                  // 新建模式：直接关闭弹窗
                  onClose();
                  onSetSelectedMemo(null);
                  onSetEditTitle("");
                  onSetEditContent("");
                  onSetEditing(false);
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
                  await handleDeleteInEdit();
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
  );
}

