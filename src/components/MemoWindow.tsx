import { useState, useEffect, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import { tauriApi } from "../api/tauri";
import type { MemoItem } from "../types";
import { useWindowClose } from "../hooks/useWindowClose";
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

const headerBtn =
  "px-3 py-1.5 text-sm rounded-lg border transition-colors";
const headerBtnSecondary =
  `${headerBtn} border-gray-200 bg-white text-gray-700 shadow-sm hover:border-gray-300 hover:bg-gray-50`;
const headerBtnPrimary =
  `${headerBtn} border-blue-500 bg-blue-500 font-medium text-white shadow-sm hover:border-blue-600 hover:bg-blue-600`;

export function MemoWindow() {
  const [memos, setMemos] = useState<MemoItem[]>([]);
  const [selectedMemo, setSelectedMemo] = useState<MemoItem | null>(null);
  const [memoEditTitle, setMemoEditTitle] = useState("");
  const [memoEditContent, setMemoEditContent] = useState("");
  const [isEditingMemo, setIsEditingMemo] = useState(false);
  const [isMemoListMode, setIsMemoListMode] = useState(true);

  const isEditingMemoRef = useRef(isEditingMemo);
  const memoEditTitleRef = useRef(memoEditTitle);
  const memoEditContentRef = useRef(memoEditContent);
  const selectedMemoRef = useRef(selectedMemo);
  isEditingMemoRef.current = isEditingMemo;
  memoEditTitleRef.current = memoEditTitle;
  memoEditContentRef.current = memoEditContent;
  selectedMemoRef.current = selectedMemo;

  const loadMemos = async () => {
    try {
      const list = await tauriApi.getAllMemos();
      setMemos(list);
    } catch (error) {
      console.error("Failed to load memos:", error);
    }
  };

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
      alert(`打开备忘录目录失败: ${error}`);
    }
  }, []);

  /** 列表顶栏：复制「阅读整个备忘录目录」提示词 */
  const copyMemosRootPrompt = useCallback(async () => {
    try {
      const root = await tauriApi.getMemosRootPath();
      await navigator.clipboard.writeText(buildMemosRootAiPrompt(root));
      alert(MEMO_AI_PROMPT_COPIED_MESSAGE);
    } catch (error) {
      console.error("复制提示词失败:", error);
      alert(`复制提示词失败: ${error}`);
    }
  }, []);

  /** 单条：复制「阅读该 .md」提示词 */
  const copyMemoFilePrompt = useCallback(async (memoId: string) => {
    try {
      const root = await tauriApi.getMemosRootPath();
      const filePath = joinMemoMdPath(root, memoId);
      await navigator.clipboard.writeText(buildMemoFileAiPrompt(filePath));
      alert(MEMO_AI_PROMPT_COPIED_MESSAGE);
    } catch (error) {
      console.error("复制提示词失败:", error);
      alert(`复制提示词失败: ${error}`);
    }
  }, []);

  const confirmDiscardIfDirty = useCallback(async (): Promise<boolean> => {
    if (!isEditingMemo) return true;
    const baselineTitle = selectedMemo?.title ?? "";
    const baselineContent = selectedMemo?.content ?? "";
    if (
      !isMemoEditDirty(
        memoEditTitle,
        memoEditContent,
        baselineTitle,
        baselineContent
      )
    ) {
      return true;
    }
    return confirm(MEMO_DISCARD_CONFIRM_MESSAGE, {
      title: "未保存确认",
      kind: "warning",
    });
  }, [isEditingMemo, memoEditTitle, memoEditContent, selectedMemo]);

  /** 退出编辑回到列表（丢弃本地编辑态） */
  const returnToList = useCallback(() => {
    setIsMemoListMode(true);
    setSelectedMemo(null);
    setMemoEditTitle("");
    setMemoEditContent("");
    setIsEditingMemo(false);
  }, []);

  /** 取消编辑：回到列表 */
  const discardEdit = useCallback(() => {
    returnToList();
  }, [returnToList]);

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

  /** 保存后留在编辑态，不自动回列表 */
  const handleSave = useCallback(async () => {
    try {
      if (!hasMemoSubstance(memoEditTitle, memoEditContent)) {
        alert("请输入标题、内容或图片");
        return;
      }
      // 保存成功后留在编辑态，用编辑区内容对齐基线（避免空标题落成「无标题」后误判脏）
      const saved = selectedMemo
        ? await tauriApi.updateMemo(
            selectedMemo.id,
            memoEditTitle,
            memoEditContent
          )
        : await tauriApi.addMemo(
            memoEditTitle.trim() || "无标题",
            memoEditContent
          );
      setSelectedMemo({
        ...saved,
        title: memoEditTitle,
        content: memoEditContent,
      });
      void loadMemos();
    } catch (error) {
      console.error("Failed to save memo:", error);
      alert(`保存备忘录失败: ${error}`);
    }
  }, [selectedMemo, memoEditTitle, memoEditContent]);
  useEffect(() => {
    loadMemos();
  }, []);

  // 关闭窗口时：编辑中有未保存改动则确认
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const setup = async () => {
      unlisten = await getCurrentWindow().onCloseRequested(async (event) => {
        if (!isEditingMemoRef.current) return;
        const baselineTitle = selectedMemoRef.current?.title ?? "";
        const baselineContent = selectedMemoRef.current?.content ?? "";
        if (
          !isMemoEditDirty(
            memoEditTitleRef.current,
            memoEditContentRef.current,
            baselineTitle,
            baselineContent
          )
        ) {
          return;
        }
        event.preventDefault();
        const ok = await confirm(MEMO_DISCARD_CONFIRM_MESSAGE, {
          title: "未保存确认",
          kind: "warning",
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
          if (!(await confirmDiscardIfDirty())) return;
          returnToList();
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
    confirmDiscardIfDirty,
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
      if (!(await confirmDiscardIfDirty())) return;
    }
    returnToList();
  };

  const handleCancelEdit = async () => {
    if (!(await confirmDiscardIfDirty())) return;
    discardEdit();
  };

  const editDirty =
    isEditingMemo &&
    isMemoEditDirty(
      memoEditTitle,
      memoEditContent,
      selectedMemo?.title ?? "",
      selectedMemo?.content ?? ""
    );

  const isPreviewMode = !isMemoListMode && !isEditingMemo && !!selectedMemo;

  const pageTitle = isMemoListMode
    ? "备忘录列表"
    : isEditingMemo
    ? selectedMemo
      ? "编辑备忘录"
      : "新建备忘录"
    : "预览备忘录";

  /** 顶栏/正文/底栏共用内容列；列表略窄避免宽屏被拉成空条 */
  const shellClass = isMemoListMode
    ? "mx-auto w-full max-w-2xl px-4 sm:px-5"
    : "mx-auto w-full max-w-3xl px-4 sm:px-6";

  return (
    <div className="flex h-screen w-screen flex-col bg-gray-50">
      <div className="shrink-0 border-b border-gray-200/80 bg-white shadow-sm">
        <div
          className={`${shellClass} flex items-center justify-between gap-3 py-3`}
        >
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold tracking-tight text-gray-900">
              {pageTitle}
            </h2>
            {isMemoListMode && memos.length > 0 && (
              <p className="mt-0.5 text-[11px] text-gray-400">
                共 {memos.length} 条
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
            {isPreviewMode && selectedMemo && (
              <button
                type="button"
                onClick={() => {
                  setMemoEditTitle(selectedMemo.title);
                  setMemoEditContent(selectedMemo.content);
                  setIsEditingMemo(true);
                }}
                className={headerBtnPrimary}
              >
                编辑
              </button>
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
          memos.length === 0 ? (
            <MemoEmptyState />
          ) : (
            <div className="space-y-2">
              {memos.map((memo) => (
                <MemoListItem
                  key={memo.id}
                  memo={memo}
                  thumbSize={48}
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
                      await handleClose();
                    } catch (error) {
                      console.error("Failed to copy to clipboard:", error);
                      alert(`复制失败: ${error}`);
                    }
                  }}
                  onCopyPrompt={() => copyMemoFilePrompt(memo.id)}
                  onDelete={async () => {
                    const confirmed = await confirm(
                      "确定要删除这条备忘录吗？",
                      { title: "删除确认", kind: "warning" }
                    );
                    if (!confirmed) return;
                    try {
                      await tauriApi.deleteMemo(memo.id);
                      await loadMemos();
                      if (selectedMemo?.id === memo.id) {
                        resetMemoState();
                      }
                    } catch (error) {
                      console.error("Failed to delete memo:", error);
                      alert(`删除备忘录失败: ${error}`);
                    }
                  }}
                />
              ))}
            </div>
          )
        ) : isEditingMemo ? (
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="shrink-0">
              <label className="mb-1.5 block text-sm font-medium text-gray-600">
                标题
              </label>
              <input
                type="text"
                value={memoEditTitle}
                onChange={(e) => setMemoEditTitle(e.target.value)}
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
                value={memoEditContent}
                onChange={setMemoEditContent}
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
      </div>

      {isEditingMemo && (
        <MemoEditFooter
          dirty={editDirty}
          contentClassName={shellClass}
          onSave={handleSave}
          onCancel={handleCancelEdit}
          showDelete={!!selectedMemo}
          onDelete={async () => {
            if (!selectedMemo) return;
            const confirmed = await confirm("确定要删除这条备忘录吗？", {
              title: "删除确认",
              kind: "warning",
            });
            if (!confirmed) return;
            try {
              await tauriApi.deleteMemo(selectedMemo.id);
              await loadMemos();
              resetMemoState();
            } catch (error) {
              console.error("Failed to delete memo:", error);
              alert(`删除备忘录失败: ${error}`);
            }
          }}
        />
      )}
    </div>
  );
}
