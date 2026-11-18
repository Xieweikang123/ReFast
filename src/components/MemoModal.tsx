import { useCallback, useEffect } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { MemoItem } from "../types";
import { tauriApi } from "../api/tauri";
import { formatFullDateTime } from "../utils/dateUtils";
import { hasMemoSubstance } from "../utils/memoPreviewUtils";
import {
  buildMemoFileAiPrompt,
  buildMemosRootAiPrompt,
  isMemoEditDirty,
  joinMemoMdPath,
  MEMO_AI_PROMPT_COPIED_MESSAGE,
  MEMO_DISCARD_CONFIRM_MESSAGE,
} from "../utils/memoUtils";
import { MemoContentEditor } from "./MemoContentEditor";
import { MemoEditFooter } from "./MemoEditFooter";
import { MemoEmptyState } from "./MemoEmptyState";
import { MemoListItem } from "./MemoListItem";
import { MemoMarkdown } from "./MemoMarkdown";

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

const headerBtn =
  "px-3 py-1.5 text-sm rounded-lg border transition-colors";
const headerBtnSecondary =
  `${headerBtn} border-gray-200 bg-white text-gray-700 shadow-sm hover:border-gray-300 hover:bg-gray-50`;
const headerBtnPrimary =
  `${headerBtn} border-blue-500 bg-blue-500 font-medium text-white shadow-sm hover:border-blue-600 hover:bg-blue-600`;

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
  const openMemosFolder = useCallback(async () => {
    try {
      const root = await tauriApi.getMemosRootPath();
      await tauriApi.revealInFolder(root);
    } catch (error) {
      console.error("打开备忘录目录失败:", error);
      alert(`打开备忘录目录失败: ${error}`);
    }
  }, [tauriApi]);

  const copyMemoFilePrompt = useCallback(
    async (memoId: string) => {
      try {
        const root = await tauriApi.getMemosRootPath();
        const filePath = joinMemoMdPath(root, memoId);
        await navigator.clipboard.writeText(buildMemoFileAiPrompt(filePath));
        alert(MEMO_AI_PROMPT_COPIED_MESSAGE);
      } catch (error) {
        console.error("复制提示词失败:", error);
        alert(`复制提示词失败: ${error}`);
      }
    },
    [tauriApi]
  );

  const confirmDiscardIfDirty = useCallback(async (): Promise<boolean> => {
    if (!isEditing) return true;
    const baselineTitle = selectedMemo?.title ?? "";
    const baselineContent = selectedMemo?.content ?? "";
    if (
      !isMemoEditDirty(editTitle, editContent, baselineTitle, baselineContent)
    ) {
      return true;
    }
    return confirm(MEMO_DISCARD_CONFIRM_MESSAGE, {
      title: "未保存确认",
      kind: "warning",
    });
  }, [isEditing, editTitle, editContent, selectedMemo]);

  /** 退出编辑回到列表（丢弃本地编辑态） */
  const returnToList = useCallback(() => {
    onSetListMode(true);
    onSetSelectedMemo(null);
    onSetEditTitle("");
    onSetEditContent("");
    onSetEditing(false);
  }, [
    onSetListMode,
    onSetSelectedMemo,
    onSetEditTitle,
    onSetEditContent,
    onSetEditing,
  ]);

  /** 取消编辑：回到列表 */
  const discardEdit = useCallback(() => {
    returnToList();
  }, [returnToList]);

  const openPreview = useCallback(
    (memo: MemoItem) => {
      onSetListMode(false);
      onSetSelectedMemo(memo);
      onSetEditTitle(memo.title);
      onSetEditContent(memo.content);
      onSetEditing(false);
    },
    [
      onSetListMode,
      onSetSelectedMemo,
      onSetEditTitle,
      onSetEditContent,
      onSetEditing,
    ]
  );

  const openEdit = useCallback(
    (memo: MemoItem) => {
      onSetListMode(false);
      onSetSelectedMemo(memo);
      onSetEditTitle(memo.title);
      onSetEditContent(memo.content);
      onSetEditing(true);
    },
    [
      onSetListMode,
      onSetSelectedMemo,
      onSetEditTitle,
      onSetEditContent,
      onSetEditing,
    ]
  );

  /** 保存后留在编辑态，不自动回列表 */
  const handleSave = useCallback(async () => {
    try {
      if (!hasMemoSubstance(editTitle, editContent)) {
        alert("请输入标题、内容或图片");
        return;
      }
      // 保存成功后留在编辑态，用编辑区内容对齐基线（避免空标题落成「无标题」后误判脏）
      const saved = selectedMemo
        ? await tauriApi.updateMemo(selectedMemo.id, editTitle, editContent)
        : await tauriApi.addMemo(editTitle.trim() || "无标题", editContent);
      onSetSelectedMemo({
        ...saved,
        title: editTitle,
        content: editContent,
      });
      void onRefreshMemos();
    } catch (error) {
      console.error("Failed to save memo:", error);
      alert(`保存备忘录失败: ${error}`);
    }
  }, [
    selectedMemo,
    editTitle,
    editContent,
    tauriApi,
    onSetSelectedMemo,
    onRefreshMemos,
  ]);

  const handleCancelEdit = useCallback(async () => {
    if (!(await confirmDiscardIfDirty())) return;
    discardEdit();
  }, [confirmDiscardIfDirty, discardEdit]);

  /** ESC：编辑中确认后回列表；预览中直接回列表（与 MemoWindow 一致） */
  const handleEscapeFromDetail = useCallback(async () => {
    if (isEditing) {
      if (!(await confirmDiscardIfDirty())) return;
    }
    returnToList();
  }, [isEditing, confirmDiscardIfDirty, returnToList]);

  useEffect(() => {
    if (!isOpen || isListMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        if (!isEditing) return;
        e.preventDefault();
        e.stopPropagation();
        void handleSave();
        return;
      }
      if (e.key === "Escape" || e.keyCode === 27) {
        e.preventDefault();
        e.stopPropagation();
        void handleEscapeFromDetail();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [isOpen, isListMode, isEditing, handleSave, handleEscapeFromDetail]);

  if (!isOpen) return null;

  const handleClose = async () => {
    if (isListMode) {
      onClose();
      onSetListMode(true);
      onSetSelectedMemo(null);
      onSetEditing(false);
      setTimeout(() => {
        onHideLauncher();
      }, 100);
      return;
    }
    if (isEditing) {
      if (!(await confirmDiscardIfDirty())) return;
    }
    returnToList();
  };

  const handleDelete = async (memoId: string) => {
    try {
      await tauriApi.deleteMemo(memoId);
      await onRefreshMemos();
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
    const confirmed = await confirm("确定要删除这条备忘录吗？", {
      title: "删除确认",
      kind: "warning",
    });
    if (!confirmed) return;
    try {
      await tauriApi.deleteMemo(memoToDelete.id);
      await onRefreshMemos();
      returnToList();
    } catch (error) {
      console.error("Failed to delete memo:", error);
      alert(`删除备忘录失败: ${error}`);
    }
  };

  const editDirty =
    isEditing &&
    isMemoEditDirty(
      editTitle,
      editContent,
      selectedMemo?.title ?? "",
      selectedMemo?.content ?? ""
    );

  const isPreviewMode = !isListMode && !isEditing && !!selectedMemo;

  const pageTitle = isListMode
    ? "备忘录列表"
    : isEditing
    ? selectedMemo
      ? "编辑备忘录"
      : "新建备忘录"
    : "预览备忘录";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-black/45 backdrop-blur-[2px]">
      <div className="m-4 my-auto flex max-h-[calc(100vh-32px)] min-h-[500px] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-2xl shadow-gray-900/10">
        <div className="flex items-center justify-between border-b border-gray-200/80 bg-white px-4 py-3">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-gray-900">
              {pageTitle}
            </h2>
            {isListMode && memos.length > 0 && (
              <p className="mt-0.5 text-[11px] text-gray-400">
                共 {memos.length} 条
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isListMode && (
              <>
                <button
                  type="button"
                  onClick={openMemosFolder}
                  className={headerBtnSecondary}
                  title="在资源管理器中打开笔记目录"
                >
                  打开目录
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onSetListMode(false);
                    onSetSelectedMemo(null);
                    onSetEditTitle("");
                    onSetEditContent("");
                    onSetEditing(true);
                  }}
                  className={headerBtnPrimary}
                >
                  新建
                </button>
              </>
            )}
            {isPreviewMode && selectedMemo && (
              <button
                type="button"
                onClick={() => {
                  onSetEditTitle(selectedMemo.title);
                  onSetEditContent(selectedMemo.content);
                  onSetEditing(true);
                }}
                className={headerBtnPrimary}
              >
                编辑
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleClose()}
              className={headerBtnSecondary}
            >
              {isListMode ? "关闭" : "返回"}
            </button>
          </div>
        </div>

        <div
          className={`flex-1 bg-gray-50/60 p-4 ${
            isEditing
              ? "flex min-h-0 flex-col overflow-hidden"
              : "overflow-y-auto"
          }`}
        >
          {isListMode ? (
            memos.length === 0 ? (
              <MemoEmptyState />
            ) : (
              <div className="space-y-2">
                {memos.map((memo) => (
                  <MemoListItem
                    key={memo.id}
                    memo={memo}
                    thumbSize={44}
                    onOpen={() => openEdit(memo)}
                    onPreview={() => openPreview(memo)}
                    onInsert={async () => {
                      try {
                        const textToPaste = memo.title
                          ? memo.content
                            ? `${memo.title}\n${memo.content}`
                            : memo.title
                          : memo.content || "(无内容)";
                        await navigator.clipboard.writeText(textToPaste);
                        await onHideLauncher();
                        await tauriApi.pasteTextToCursor("");
                      } catch (error) {
                        console.error("Failed to paste to cursor:", error);
                        alert(`插入失败: ${error}`);
                      }
                    }}
                    onCopy={async () => {
                      try {
                        await navigator.clipboard.writeText(
                          memo.title || "(无标题)"
                        );
                      } catch (error) {
                        console.error("Failed to copy to clipboard:", error);
                        alert(`复制失败: ${error}`);
                      }
                    }}
                    onCopyAndClose={async () => {
                      try {
                        await navigator.clipboard.writeText(
                          memo.title || "(无标题)"
                        );
                        await onHideLauncher();
                      } catch (error) {
                        console.error("Failed to copy to clipboard:", error);
                        alert(`复制失败: ${error}`);
                      }
                    }}
                    onDelete={async () => {
                      const confirmed = await confirm(
                        "确定要删除这条备忘录吗？",
                        { title: "删除确认", kind: "warning" }
                      );
                      if (!confirmed) return;
                      await handleDelete(memo.id);
                    }}
                  />
                ))}
              </div>
            )
          ) : isEditing ? (
            <div className="flex h-full min-h-0 flex-col gap-4">
              <div className="shrink-0">
                <label className="mb-1.5 block text-sm font-medium text-gray-600">
                  标题
                </label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => onSetEditTitle(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-gray-900 shadow-sm transition-shadow placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                  placeholder="标题（可选）"
                />
              </div>
              <div className="flex min-h-0 flex-1 flex-col">
                <label className="mb-1.5 shrink-0 text-sm font-medium text-gray-600">
                  内容
                  <span className="ml-2 font-normal text-xs text-gray-400">
                    粘贴图片即显 · Ctrl+S 保存
                  </span>
                </label>
                <MemoContentEditor
                  value={editContent}
                  onChange={onSetEditContent}
                  autoFocus
                  fillHeight
                />
              </div>
            </div>
          ) : selectedMemo ? (
            <div className="space-y-4">
              <div>
                <div className="mb-1.5 text-sm font-medium text-gray-600">
                  标题
                </div>
                <div className="text-lg font-semibold tracking-tight text-gray-900">
                  {selectedMemo.title || "(无标题)"}
                </div>
              </div>
              <div>
                <div className="mb-1.5 text-sm font-medium text-gray-600">
                  内容
                </div>
                <div className="rounded-xl border border-gray-200/80 bg-white px-4 py-3 shadow-sm">
                  <MemoMarkdown content={selectedMemo.content} />
                </div>
              </div>
              <div className="space-y-0.5 border-t border-gray-200/80 pt-3 text-xs text-gray-400 tabular-nums">
                <div>创建于 {formatFullDateTime(selectedMemo.created_at)}</div>
                <div>更新于 {formatFullDateTime(selectedMemo.updated_at)}</div>
              </div>
            </div>
          ) : null}
        </div>

        {isEditing && (
          <MemoEditFooter
            dirty={editDirty}
            onSave={handleSave}
            onCancel={handleCancelEdit}
            showDelete={!!selectedMemo}
            onDelete={handleDeleteInEdit}
          />
        )}
      </div>
    </div>
  );
}
