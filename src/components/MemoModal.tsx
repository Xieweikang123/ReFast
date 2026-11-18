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
import { MemoModeToggle } from "./MemoModeToggle";

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
  "px-3.5 py-1.5 text-sm rounded-xl border transition-[background-color,border-color,box-shadow,color]";
const headerBtnSecondary =
  `${headerBtn} border-slate-200/90 bg-white/90 text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50`;
const headerBtnPrimary =
  `${headerBtn} border-sky-500 bg-sky-500 font-semibold text-white shadow-[0_4px_14px_rgba(14,165,233,0.35)] hover:border-sky-600 hover:bg-sky-600`;

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
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-slate-900/45 backdrop-blur-[6px]">
      <div
        className={`relative m-4 my-auto flex max-h-[calc(100vh-32px)] min-h-[500px] w-full flex-col overflow-hidden rounded-[1.35rem] border border-white/60 bg-white shadow-[0_32px_80px_rgba(15,23,42,0.28)] ${
          isListMode
            ? "max-w-2xl"
            : "max-w-2xl md:max-w-4xl lg:max-w-5xl xl:max-w-6xl"
        }`}
      >
        <div className="relative flex items-center justify-between border-b border-slate-200/40 bg-white/90 px-5 py-3.5 backdrop-blur-xl">
          <div>
            <h2 className="text-lg font-bold tracking-tight text-slate-900">
              {pageTitle}
            </h2>
            {isListMode &&
              !listLoading &&
              !listError &&
              memos.length > 0 && (
              <p className="mt-0.5 text-[12px] font-medium text-slate-400 tabular-nums">
                共 <span className="text-sky-600">{memos.length}</span> 条
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
            {(isEditing || isPreviewMode) && (
              <MemoModeToggle
                mode={isEditing ? "edit" : "preview"}
                onEdit={() => {
                  if (!selectedMemo || isEditing) return;
                  onSetEditTitle(selectedMemo.title);
                  onSetEditContent(selectedMemo.content);
                  onSetEditing(true);
                }}
                onPreview={() => void switchToPreview()}
              />
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
          className={`relative flex-1 p-5 ${
            isEditing
              ? "flex min-h-0 flex-col overflow-hidden"
              : "overflow-y-auto"
          }`}
          style={{
            backgroundImage:
              "radial-gradient(ellipse 90% 55% at 50% -15%, rgba(14,165,233,0.14), transparent 55%), radial-gradient(circle at 1px 1px, rgba(15,23,42,0.045) 1px, transparent 0), linear-gradient(180deg, #f0f9ff 0%, #f8fafc 42%, #eef2f7 100%)",
            backgroundSize: "auto, 18px 18px, auto",
          }}
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
                  <div className="space-y-3">
                    {filteredMemos.map((memo) => (
                      <MemoListItem
                        key={memo.id}
                        memo={memo}
                        thumbSize={52}
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
              <div className="shrink-0 rounded-[1.35rem] border border-slate-200/70 bg-white px-5 py-4 shadow-[0_1px_0_rgba(255,255,255,0.9)_inset,0_8px_28px_rgba(15,23,42,0.05)]">
                <label
                  htmlFor="memo-modal-edit-title"
                  className="mb-1.5 block text-[11px] font-semibold tracking-[0.14em] text-slate-400"
                >
                  标题
                </label>
                <input
                  id="memo-modal-edit-title"
                  type="text"
                  value={editTitle}
                  onChange={(e) => onSetEditTitle(e.target.value)}
                  className="w-full border-0 bg-transparent p-0 text-[1.35rem] font-bold leading-snug tracking-tight text-slate-900 outline-none placeholder:font-semibold placeholder:text-slate-300 focus:ring-0"
                  placeholder="标题（可选）"
                />
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-2">
                <div className="flex shrink-0 items-baseline justify-between gap-3 px-0.5">
                  <span className="text-[11px] font-semibold tracking-[0.14em] text-slate-400">
                    正文
                  </span>
                  <span className="text-[12px] text-slate-400">
                    粘贴图片即显 · Ctrl+S 保存
                  </span>
                </div>
                <MemoContentEditor
                  value={editContent}
                  onChange={onSetEditContent}
                  autoFocus
                  fillHeight
                />
              </div>
            </div>
          ) : selectedMemo ? (
            <article className="overflow-hidden rounded-[1.35rem] border border-slate-200/70 bg-white shadow-[0_1px_0_rgba(255,255,255,0.9)_inset,0_12px_40px_rgba(15,23,42,0.06)]">
              <header className="border-b border-slate-100 px-6 pb-5 pt-6">
                <h3 className="text-[1.5rem] font-bold leading-snug tracking-tight text-slate-900">
                  {selectedMemo.title || "(无标题)"}
                </h3>
                <p className="mt-3 text-[12px] font-medium text-slate-400 tabular-nums">
                  创建于 {formatFullDateTime(selectedMemo.created_at)}
                  <span className="mx-2 text-slate-200" aria-hidden>
                    ·
                  </span>
                  更新于 {formatFullDateTime(selectedMemo.updated_at)}
                </p>
              </header>
              <div className="px-6 py-5">
                <MemoMarkdown content={selectedMemo.content} />
              </div>
            </article>
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
