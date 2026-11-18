import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoItem } from "../types";
import { tauriApi } from "../api/tauri";
import { useMemoAutosave } from "../hooks/useMemoAutosave";
import { useMemoFeedback } from "../hooks/useMemoFeedback";
import { formatFullDateTime } from "../utils/dateUtils";
import {
  filterMemosByQuery,
  hasMemoSubstance,
} from "../utils/memoPreviewUtils";
import {
  buildMemoFileAiPrompt,
  buildMemosRootAiPrompt,
  getMemoPrimaryCopyText,
  joinMemoMdPath,
  MEMO_AI_PROMPT_COPIED_MESSAGE,
  MEMO_DELETE_CONFIRM_MESSAGE,
  MEMO_DISCARD_CONFIRM_MESSAGE,
} from "../utils/memoUtils";
import { MemoContentEditor } from "./MemoContentEditor";
import { MemoEditFooter } from "./MemoEditFooter";
import { MemoEmptyState } from "./MemoEmptyState";
import { MemoListItem } from "./MemoListItem";
import { MemoListSearchBar } from "./MemoListSearchBar";
import {
  MemoListError,
  MemoListLoading,
  MemoListNoMatch,
} from "./MemoListStatus";
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
  const { showToast, askConfirm, feedbackNodes } = useMemoFeedback();
  const [listQuery, setListQuery] = useState("");
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  const refreshList = useCallback(
    async (options?: { quiet?: boolean }) => {
      const quiet = options?.quiet ?? false;
      if (!quiet) {
        setListLoading(true);
        setListError(null);
      }
      try {
        await onRefreshMemos();
        if (!isOpenRef.current) return;
        if (!quiet) setListError(null);
      } catch (error) {
        console.error("Failed to load memos:", error);
        if (!isOpenRef.current) return;
        const msg = `加载备忘录失败: ${error}`;
        if (quiet) {
          showToast(msg, "error");
        } else {
          setListError(msg);
        }
      } finally {
        if (!quiet && isOpenRef.current) setListLoading(false);
      }
    },
    [onRefreshMemos, showToast]
  );

  const refreshMemosQuiet = useCallback(
    () => refreshList({ quiet: true }),
    [refreshList]
  );

  const { statusLabel, isDirty, saveNow, flushOnExit } = useMemoAutosave({
    enabled: isOpen && isEditing,
    selectedMemo,
    editTitle,
    editContent,
    onSelectedMemoChange: onSetSelectedMemo,
    onRefreshMemos: refreshMemosQuiet,
    api: tauriApi,
  });

  useEffect(() => {
    if (!isOpen) {
      setListQuery("");
      setListError(null);
      setListLoading(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !isListMode || memos.length > 0) return;
    void refreshList();
    // 仅随打开/切回列表触发；memos 由父组件填充后不再重复拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, isListMode]);

  const openMemosFolder = useCallback(async () => {
    try {
      const root = await tauriApi.getMemosRootPath();
      await tauriApi.revealInFolder(root);
    } catch (error) {
      console.error("打开备忘录目录失败:", error);
      showToast(`打开备忘录目录失败: ${error}`, "error");
    }
  }, [tauriApi, showToast]);

  /** 列表顶栏：复制「阅读整个备忘录目录」提示词 */
  const copyMemosRootPrompt = useCallback(async () => {
    try {
      const root = await tauriApi.getMemosRootPath();
      await navigator.clipboard.writeText(buildMemosRootAiPrompt(root));
      showToast(MEMO_AI_PROMPT_COPIED_MESSAGE);
    } catch (error) {
      console.error("复制提示词失败:", error);
      showToast(`复制提示词失败: ${error}`, "error");
    }
  }, [tauriApi, showToast]);

  /** 单条：复制「阅读该 .md」提示词 */
  const copyMemoFilePrompt = useCallback(
    async (memoId: string) => {
      try {
        const root = await tauriApi.getMemosRootPath();
        const filePath = joinMemoMdPath(root, memoId);
        await navigator.clipboard.writeText(buildMemoFileAiPrompt(filePath));
        showToast(MEMO_AI_PROMPT_COPIED_MESSAGE);
      } catch (error) {
        console.error("复制提示词失败:", error);
        showToast(`复制提示词失败: ${error}`, "error");
      }
    },
    [tauriApi, showToast]
  );

  const confirmDiscardIfDirty = useCallback(async (): Promise<boolean> => {
    if (!isEditing) return true;
    if (!isDirty()) return true;
    return askConfirm({
      title: "未保存确认",
      message: MEMO_DISCARD_CONFIRM_MESSAGE,
      confirmText: "丢弃",
      variant: "warning",
    });
  }, [isEditing, isDirty, askConfirm]);

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

  /** 离开编辑：先 flush，再对仍脏的空草稿确认 */
  const leaveEditToList = useCallback(async () => {
    await flushOnExit();
    if (!(await confirmDiscardIfDirty())) return;
    returnToList();
  }, [flushOnExit, confirmDiscardIfDirty, returnToList]);

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

  /** 立即保存并留在编辑态 */
  const handleSave = useCallback(async (): Promise<boolean> => {
    return saveNow({ explicit: true });
  }, [saveNow]);

  /** 编辑顶栏「预览」：有未保存改动则先落盘，再切只读预览 */
  const switchToPreview = useCallback(async () => {
    if (!hasMemoSubstance(editTitle, editContent) && !selectedMemo) {
      showToast("请先输入内容", "error");
      return;
    }
    if (isDirty()) {
      const ok = await saveNow({ explicit: true });
      if (!ok) return;
    } else if (!selectedMemo) {
      showToast("请先输入内容", "error");
      return;
    }
    onSetEditing(false);
  }, [
    editTitle,
    editContent,
    selectedMemo,
    isDirty,
    saveNow,
    onSetEditing,
    showToast,
  ]);

  const handleCancelEdit = useCallback(async () => {
    await leaveEditToList();
  }, [leaveEditToList]);

  /** ESC：编辑中 flush+确认后回列表；预览中直接回列表 */
  const handleEscapeFromDetail = useCallback(async () => {
    if (isEditing) {
      await leaveEditToList();
      return;
    }
    returnToList();
  }, [isEditing, leaveEditToList, returnToList]);

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
      await leaveEditToList();
      return;
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
      showToast(`删除备忘录失败: ${error}`, "error");
    }
  };

  const confirmAndDelete = async (afterDelete: () => void | Promise<void>) => {
    const confirmed = await askConfirm({
      title: "删除确认",
      message: MEMO_DELETE_CONFIRM_MESSAGE,
      confirmText: "删除",
      variant: "danger",
    });
    if (!confirmed) return;
    try {
      await afterDelete();
    } catch (error) {
      console.error("Failed to delete memo:", error);
      showToast(`删除备忘录失败: ${error}`, "error");
    }
  };

  const handleDeleteInEdit = async () => {
    const memoToDelete = selectedMemo;
    if (!memoToDelete) return;
    await confirmAndDelete(async () => {
      await tauriApi.deleteMemo(memoToDelete.id);
      await onRefreshMemos();
      returnToList();
    });
  };

  const editDirty = isEditing && isDirty();

  const isPreviewMode = !isListMode && !isEditing && !!selectedMemo;

  const filteredMemos = filterMemosByQuery(memos, listQuery);

  const pageTitle = isListMode
    ? "备忘录列表"
    : isEditing
    ? selectedMemo
      ? "编辑备忘录"
      : "新建备忘录"
    : "预览备忘录";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-black/45 backdrop-blur-[2px]">
      <div className="relative m-4 my-auto flex max-h-[calc(100vh-32px)] min-h-[500px] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-2xl shadow-gray-900/10">
        <div className="flex items-center justify-between border-b border-gray-200/80 bg-white px-4 py-3">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-gray-900">
              {pageTitle}
            </h2>
            {isListMode &&
              !listLoading &&
              !listError &&
              memos.length > 0 && (
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
                  onClick={() => void copyMemosRootPrompt()}
                  className={headerBtnSecondary}
                  title="复制让 AI 阅读全部备忘录的提示词"
                >
                  复制提示词
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
            {isEditing && (
              <button
                type="button"
                onClick={() => void switchToPreview()}
                className={headerBtnSecondary}
                title="保存后切换到只读预览"
              >
                预览
              </button>
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
            listLoading && memos.length === 0 ? (
              <MemoListLoading />
            ) : listError && memos.length === 0 ? (
              <MemoListError
                message={listError}
                onRetry={() => void refreshList()}
              />
            ) : memos.length === 0 ? (
              <MemoEmptyState />
            ) : (
              <>
                <MemoListSearchBar
                  value={listQuery}
                  onChange={setListQuery}
                  matchCount={filteredMemos.length}
                  totalCount={memos.length}
                />
                {filteredMemos.length === 0 ? (
                  <MemoListNoMatch
                    query={listQuery}
                    onClear={() => setListQuery("")}
                  />
                ) : (
                  <div className="space-y-2">
                    {filteredMemos.map((memo) => (
                      <MemoListItem
                        key={memo.id}
                        memo={memo}
                        thumbSize={44}
                        onOpen={() => openEdit(memo)}
                        onPreview={() => openPreview(memo)}
                        onCopyPrompt={() => copyMemoFilePrompt(memo.id)}
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
                            showToast(`插入失败: ${error}`, "error");
                          }
                        }}
                        onCopy={async () => {
                          try {
                            await navigator.clipboard.writeText(
                              getMemoPrimaryCopyText(memo)
                            );
                            showToast("已复制标题");
                          } catch (error) {
                            console.error(
                              "Failed to copy to clipboard:",
                              error
                            );
                            showToast(`复制失败: ${error}`, "error");
                          }
                        }}
                        onCopyAndClose={async () => {
                          try {
                            await navigator.clipboard.writeText(
                              getMemoPrimaryCopyText(memo)
                            );
                            await onHideLauncher();
                          } catch (error) {
                            console.error(
                              "Failed to copy to clipboard:",
                              error
                            );
                            showToast(`复制失败: ${error}`, "error");
                          }
                        }}
                        onDelete={async () => {
                          await confirmAndDelete(() => handleDelete(memo.id));
                        }}
                      />
                    ))}
                  </div>
                )}
              </>
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
            statusText={statusLabel}
            onSave={async () => {
              await handleSave();
            }}
            onCancel={handleCancelEdit}
            showDelete={!!selectedMemo}
            onDelete={handleDeleteInEdit}
          />
        )}
      </div>

      {/* 放在卡片外，避免 overflow-hidden 裁切确认层 / Toast */}
      {feedbackNodes}
    </div>
  );
}
