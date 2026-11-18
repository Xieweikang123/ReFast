import { useState, useEffect, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { tauriApi } from "../api/tauri";
import type { MemoItem } from "../types";
import { useMemoAutosave } from "../hooks/useMemoAutosave";
import { useMemoFeedback } from "../hooks/useMemoFeedback";
import { useWindowClose } from "../hooks/useWindowClose";
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

const headerBtn =
  "px-3.5 py-1.5 text-sm rounded-xl border transition-[background-color,border-color,box-shadow,color]";
const headerBtnSecondary =
  `${headerBtn} border-slate-200/90 bg-white/90 text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50`;
const headerBtnPrimary =
  `${headerBtn} border-sky-500 bg-sky-500 font-semibold text-white shadow-[0_4px_14px_rgba(14,165,233,0.35)] hover:border-sky-600 hover:bg-sky-600`;

export function MemoWindow() {
  const [memos, setMemos] = useState<MemoItem[]>([]);
  const [selectedMemo, setSelectedMemo] = useState<MemoItem | null>(null);
  const [memoEditTitle, setMemoEditTitle] = useState("");
  const [memoEditContent, setMemoEditContent] = useState("");
  const [isEditingMemo, setIsEditingMemo] = useState(false);
  const [isMemoListMode, setIsMemoListMode] = useState(true);
  const [listQuery, setListQuery] = useState("");
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const { showToast, askConfirm, feedbackNodes } = useMemoFeedback();

  const isEditingMemoRef = useRef(isEditingMemo);
  const askConfirmRef = useRef(askConfirm);
  isEditingMemoRef.current = isEditingMemo;
  askConfirmRef.current = askConfirm;

  const loadMemos = useCallback(
    async (options?: { quiet?: boolean }) => {
      const quiet = options?.quiet ?? false;
      if (!quiet) {
        setListLoading(true);
        setListError(null);
      }
      try {
        const list = await tauriApi.getAllMemos();
        setMemos(list);
        if (!quiet) setListError(null);
      } catch (error) {
        console.error("Failed to load memos:", error);
        const msg = `加载备忘录失败: ${error}`;
        if (quiet) {
          showToast(msg, "error");
        } else {
          setListError(msg);
        }
      } finally {
        if (!quiet) setListLoading(false);
      }
    },
    [showToast]
  );

  const refreshMemosQuiet = useCallback(
    () => loadMemos({ quiet: true }),
    [loadMemos]
  );

  const { statusLabel, isDirty, saveNow, flushOnExit } = useMemoAutosave({
    enabled: isEditingMemo,
    selectedMemo,
    editTitle: memoEditTitle,
    editContent: memoEditContent,
    onSelectedMemoChange: setSelectedMemo,
    onRefreshMemos: refreshMemosQuiet,
  });

  const isDirtyRef = useRef(isDirty);
  const flushOnExitRef = useRef(flushOnExit);
  isDirtyRef.current = isDirty;
  flushOnExitRef.current = flushOnExit;

  const handleClose = useWindowClose();

  const handleHide = useCallback(async () => {
    const window = getCurrentWindow();
    await window.hide();
  }, []);

  const openMemosFolder = useCallback(async () => {
    try {
      const root = await tauriApi.getMemosRootPath();
      await tauriApi.revealInFolder(root);
    } catch (error) {
      console.error("打开备忘录目录失败:", error);
      showToast(`打开备忘录目录失败: ${error}`, "error");
    }
  }, [showToast]);

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
  }, [showToast]);

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
    [showToast]
  );

  const confirmDiscardIfDirty = useCallback(async (): Promise<boolean> => {
    if (!isEditingMemo) return true;
    if (!isDirty()) return true;
    return askConfirm({
      title: "未保存确认",
      message: MEMO_DISCARD_CONFIRM_MESSAGE,
      confirmText: "丢弃",
      variant: "warning",
    });
  }, [isEditingMemo, isDirty, askConfirm]);

  /** 退出编辑回到列表（丢弃本地编辑态） */
  const returnToList = useCallback(() => {
    setIsMemoListMode(true);
    setSelectedMemo(null);
    setMemoEditTitle("");
    setMemoEditContent("");
    setIsEditingMemo(false);
  }, []);

  /** 离开编辑：先 flush 有实质内容的改动，再对仍脏的空草稿确认 */
  const leaveEditToList = useCallback(async () => {
    await flushOnExit();
    if (!(await confirmDiscardIfDirty())) return;
    returnToList();
  }, [flushOnExit, confirmDiscardIfDirty, returnToList]);

  /** 打开只读预览（列表「预览」入口） */
  const openPreview = useCallback((memo: MemoItem) => {
    setIsMemoListMode(false);
    setSelectedMemo(memo);
    setMemoEditTitle(memo.title);
    setMemoEditContent(memo.content);
    setIsEditingMemo(false);
  }, []);

  /** 打开编辑（列表点击 /「编辑」） */
  const openEdit = useCallback((memo: MemoItem) => {
    setIsMemoListMode(false);
    setSelectedMemo(memo);
    setMemoEditTitle(memo.title);
    setMemoEditContent(memo.content);
    setIsEditingMemo(true);
  }, []);

  /** 立即保存并留在编辑态 */
  const handleSave = useCallback(async (): Promise<boolean> => {
    return saveNow({ explicit: true });
  }, [saveNow]);

  /** 编辑顶栏「预览」：有未保存改动则先落盘，再切只读预览 */
  const switchToPreview = useCallback(async () => {
    if (!hasMemoSubstance(memoEditTitle, memoEditContent) && !selectedMemo) {
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
    setIsEditingMemo(false);
  }, [
    memoEditTitle,
    memoEditContent,
    selectedMemo,
    isDirty,
    saveNow,
    showToast,
  ]);

  useEffect(() => {
    void loadMemos();
  }, [loadMemos]);

  // 关闭窗口时：先 flush，仍脏则确认
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const setup = async () => {
      unlisten = await getCurrentWindow().onCloseRequested(async (event) => {
        if (!isEditingMemoRef.current) return;
        await flushOnExitRef.current();
        if (!isDirtyRef.current()) return;
        event.preventDefault();
        const ok = await askConfirmRef.current({
          title: "未保存确认",
          message: MEMO_DISCARD_CONFIRM_MESSAGE,
          confirmText: "丢弃",
          variant: "warning",
        });
        if (ok) {
          await getCurrentWindow().destroy();
        }
      });
    };
    void setup();
    return () => {
      unlisten?.();
    };
  }, []);

  // ESC / Ctrl+S
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        if (isEditingMemo) {
          e.preventDefault();
          e.stopPropagation();
          await handleSave();
        }
        return;
      }

      if (e.key === "Escape" || e.keyCode === 27) {
        e.preventDefault();
        e.stopPropagation();

        if (isMemoListMode) {
          await handleClose();
        } else if (isEditingMemo) {
          await leaveEditToList();
        } else {
          returnToList();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [
    isMemoListMode,
    isEditingMemo,
    handleClose,
    handleSave,
    leaveEditToList,
    returnToList,
  ]);

  const resetMemoState = () => {
    returnToList();
  };

  const startNewMemo = () => {
    setIsMemoListMode(false);
    setSelectedMemo(null);
    setMemoEditTitle("");
    setMemoEditContent("");
    setIsEditingMemo(true);
  };

  const handleBackOrClose = async () => {
    if (isMemoListMode) {
      await handleClose();
      return;
    }
    if (isEditingMemo) {
      await leaveEditToList();
      return;
    }
    returnToList();
  };

  const handleCancelEdit = async () => {
    await leaveEditToList();
  };

  const confirmAndDelete = async (memoId: string, afterDelete: () => void) => {
    const confirmed = await askConfirm({
      title: "删除确认",
      message: MEMO_DELETE_CONFIRM_MESSAGE,
      confirmText: "删除",
      variant: "danger",
    });
    if (!confirmed) return;
    try {
      await tauriApi.deleteMemo(memoId);
      await loadMemos();
      afterDelete();
    } catch (error) {
      console.error("Failed to delete memo:", error);
      showToast(`删除备忘录失败: ${error}`, "error");
    }
  };

  const editDirty = isEditingMemo && isDirty();

  const isPreviewMode = !isMemoListMode && !isEditingMemo && !!selectedMemo;

  const filteredMemos = filterMemosByQuery(memos, listQuery);

  const pageTitle = isMemoListMode
    ? "备忘录列表"
    : isEditingMemo
    ? selectedMemo
      ? "编辑备忘录"
      : "新建备忘录"
    : "预览备忘录";

  /** 顶栏/正文/底栏共用内容列；列表略窄，编辑/预览在大窗尽量铺开 */
  const shellClass = isMemoListMode
    ? "mx-auto w-full max-w-2xl px-4 sm:px-5"
    : "mx-auto w-full max-w-4xl px-5 sm:px-7 md:max-w-5xl lg:max-w-6xl lg:px-10 xl:max-w-7xl";

  return (
    <div
      className="relative flex h-screen w-screen flex-col"
      style={{
        backgroundImage:
          "radial-gradient(ellipse 90% 50% at 50% -12%, rgba(14,165,233,0.16), transparent 55%), radial-gradient(circle at 1px 1px, rgba(15,23,42,0.045) 1px, transparent 0), linear-gradient(180deg, #f0f9ff 0%, #f8fafc 40%, #eef2f7 100%)",
        backgroundSize: "auto, 18px 18px, auto",
      }}
    >
      <div className="relative shrink-0 border-b border-slate-200/40 bg-white/80 shadow-[0_6px_20px_rgba(15,23,42,0.04)] backdrop-blur-xl">
        <div
          className={`${shellClass} flex items-center justify-between gap-3 py-3.5`}
        >
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold tracking-tight text-slate-900">
              {pageTitle}
            </h2>
            {isMemoListMode && !listLoading && !listError && memos.length > 0 && (
              <p className="mt-0.5 text-[12px] font-medium text-slate-400 tabular-nums">
                共 <span className="text-sky-600">{memos.length}</span> 条
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isMemoListMode && (
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
                  onClick={startNewMemo}
                  className={headerBtnPrimary}
                >
                  新建
                </button>
              </>
            )}
            {(isEditingMemo || isPreviewMode) && (
              <MemoModeToggle
                mode={isEditingMemo ? "edit" : "preview"}
                onEdit={() => {
                  if (!selectedMemo || isEditingMemo) return;
                  setMemoEditTitle(selectedMemo.title);
                  setMemoEditContent(selectedMemo.content);
                  setIsEditingMemo(true);
                }}
                onPreview={() => void switchToPreview()}
              />
            )}
            <button
              type="button"
              onClick={() => void handleBackOrClose()}
              className={headerBtnSecondary}
            >
              {isMemoListMode ? "关闭" : "返回"}
            </button>
          </div>
        </div>
      </div>

      <div
        className={`min-h-0 flex-1 ${
          isEditingMemo
            ? "flex flex-col overflow-hidden"
            : "overflow-y-auto"
        }`}
      >
        <div
          className={`${shellClass} ${
            isEditingMemo ? "flex min-h-0 flex-1 flex-col py-4" : "py-4"
          }`}
        >
        {isMemoListMode ? (
          listLoading && memos.length === 0 ? (
            <MemoListLoading />
          ) : listError && memos.length === 0 ? (
            <MemoListError
              message={listError}
              onRetry={() => void loadMemos()}
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
                      thumbSize={56}
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
                          await handleHide();
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
                          console.error("Failed to copy to clipboard:", error);
                          showToast(`复制失败: ${error}`, "error");
                        }
                      }}
                      onCopyAndClose={async () => {
                        try {
                          await navigator.clipboard.writeText(
                            getMemoPrimaryCopyText(memo)
                          );
                          await handleClose();
                        } catch (error) {
                          console.error("Failed to copy to clipboard:", error);
                          showToast(`复制失败: ${error}`, "error");
                        }
                      }}
                      onDelete={async () => {
                        await confirmAndDelete(memo.id, () => {
                          if (selectedMemo?.id === memo.id) {
                            resetMemoState();
                          }
                        });
                      }}
                    />
                  ))}
                </div>
              )}
            </>
          )
        ) : isEditingMemo ? (
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="shrink-0 rounded-[1.35rem] border border-slate-200/70 bg-white px-5 py-4 shadow-[0_1px_0_rgba(255,255,255,0.9)_inset,0_8px_28px_rgba(15,23,42,0.05)]">
              <label
                htmlFor="memo-edit-title"
                className="mb-1.5 block text-[11px] font-semibold tracking-[0.14em] text-slate-400"
              >
                标题
              </label>
              <input
                id="memo-edit-title"
                type="text"
                value={memoEditTitle}
                onChange={(e) => setMemoEditTitle(e.target.value)}
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
                value={memoEditContent}
                onChange={setMemoEditContent}
                autoFocus
                fillHeight
              />
            </div>
          </div>
        ) : selectedMemo ? (
          <article className="overflow-hidden rounded-[1.35rem] border border-slate-200/70 bg-white shadow-[0_1px_0_rgba(255,255,255,0.9)_inset,0_12px_40px_rgba(15,23,42,0.06)]">
            <header className="border-b border-slate-100 px-7 pb-5 pt-7">
              <h3 className="text-[1.65rem] font-bold leading-snug tracking-tight text-slate-900">
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
            <div className="px-7 py-6">
              <MemoMarkdown content={selectedMemo.content} />
            </div>
          </article>
        ) : null}
        </div>
      </div>

      {isEditingMemo && (
        <MemoEditFooter
          dirty={editDirty}
          statusText={statusLabel}
          contentClassName={shellClass}
          onSave={async () => {
            await handleSave();
          }}
          onCancel={handleCancelEdit}
          showDelete={!!selectedMemo}
          onDelete={async () => {
            if (!selectedMemo) return;
            await confirmAndDelete(selectedMemo.id, () => {
              resetMemoState();
            });
          }}
        />
      )}

      {feedbackNodes}
    </div>
  );
}
