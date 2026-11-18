import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoItem } from "../types";
import { tauriApi } from "../api/tauri";
import { hasMemoSubstance } from "../utils/memoPreviewUtils";
import { isMemoEditDirty } from "../utils/memoUtils";

const DEFAULT_DEBOUNCE_MS = 1000;
const SAVED_STATUS_MS = 2500;

export type MemoAutosaveStatus = "idle" | "saving" | "saved" | "error";

export interface MemoAutosaveApi {
  addMemo: (title: string, content: string) => Promise<MemoItem>;
  updateMemo: (
    id: string,
    title?: string,
    content?: string
  ) => Promise<MemoItem>;
}

export interface UseMemoAutosaveOptions {
  /** 仅在编辑模式下启用自动保存 */
  enabled: boolean;
  selectedMemo: MemoItem | null;
  editTitle: string;
  editContent: string;
  onSelectedMemoChange: (memo: MemoItem) => void;
  onRefreshMemos: () => Promise<void>;
  debounceMs?: number;
  api?: MemoAutosaveApi;
}

export interface UseMemoAutosaveResult {
  status: MemoAutosaveStatus;
  /** 状态文案：保存中… / 已自动保存 / 错误信息；idle 为空串 */
  statusLabel: string;
  /** 相对上次成功落盘基线是否有未保存改动（同步可读，含 flush 后） */
  isDirty: () => boolean;
  /** 立即保存（取消 debounce）。explicit 时空内容会 alert */
  saveNow: (opts?: { explicit?: boolean }) => Promise<boolean>;
  /** 离开编辑前：取消 debounce 并尽量 flush 有实质内容的改动 */
  flushOnExit: () => Promise<boolean>;
}

/**
 * 备忘录防抖自动保存：新建首次 addMemo 后切到该 id，后续 updateMemo。
 * 与 Ctrl+S / 保存按钮共用同一落盘路径。
 */
export function useMemoAutosave({
  enabled,
  selectedMemo,
  editTitle,
  editContent,
  onSelectedMemoChange,
  onRefreshMemos,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  api = tauriApi,
}: UseMemoAutosaveOptions): UseMemoAutosaveResult {
  const [status, setStatus] = useState<MemoAutosaveStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const editTitleRef = useRef(editTitle);
  const editContentRef = useRef(editContent);
  const selectedMemoRef = useRef(selectedMemo);
  const baselineTitleRef = useRef(selectedMemo?.title ?? "");
  const baselineContentRef = useRef(selectedMemo?.content ?? "");
  const enabledRef = useRef(enabled);
  const wasEnabledRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChainRef = useRef(Promise.resolve<boolean>(true));
  const apiRef = useRef(api);
  const onSelectedMemoChangeRef = useRef(onSelectedMemoChange);
  const onRefreshMemosRef = useRef(onRefreshMemos);

  editTitleRef.current = editTitle;
  editContentRef.current = editContent;
  selectedMemoRef.current = selectedMemo;
  enabledRef.current = enabled;
  apiRef.current = api;
  onSelectedMemoChangeRef.current = onSelectedMemoChange;
  onRefreshMemosRef.current = onRefreshMemos;

  const clearDebounce = useCallback(() => {
    if (debounceTimerRef.current != null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const clearSavedTimer = useCallback(() => {
    if (savedClearTimerRef.current != null) {
      clearTimeout(savedClearTimerRef.current);
      savedClearTimerRef.current = null;
    }
  }, []);

  const isDirty = useCallback(() => {
    return isMemoEditDirty(
      editTitleRef.current,
      editContentRef.current,
      baselineTitleRef.current,
      baselineContentRef.current
    );
  }, []);

  // 进入编辑模式时同步基线
  useEffect(() => {
    if (enabled && !wasEnabledRef.current) {
      baselineTitleRef.current = selectedMemo?.title ?? "";
      baselineContentRef.current = selectedMemo?.content ?? "";
      setStatus("idle");
      setErrorMessage("");
    }
    if (!enabled) {
      clearDebounce();
      clearSavedTimer();
      setStatus("idle");
      setErrorMessage("");
    }
    wasEnabledRef.current = enabled;
  }, [enabled, selectedMemo, clearDebounce, clearSavedTimer]);

  const performSave = useCallback(
    async (explicit: boolean): Promise<boolean> => {
      if (!enabledRef.current) return true;

      const title = editTitleRef.current;
      const content = editContentRef.current;

      if (
        !isMemoEditDirty(
          title,
          content,
          baselineTitleRef.current,
          baselineContentRef.current
        )
      ) {
        return true;
      }

      if (!hasMemoSubstance(title, content)) {
        if (explicit) {
          alert("请输入标题、内容或图片");
        }
        return false;
      }

      setStatus("saving");
      setErrorMessage("");
      clearSavedTimer();

      try {
        const current = selectedMemoRef.current;
        let saved: MemoItem;
        if (current) {
          saved = await apiRef.current.updateMemo(current.id, title, content);
        } else {
          saved = await apiRef.current.addMemo(
            title.trim() || "无标题",
            content
          );
        }

        // 基线用编辑区实际内容，避免空标题落成「无标题」后误判脏
        baselineTitleRef.current = title;
        baselineContentRef.current = content;
        selectedMemoRef.current = saved;
        onSelectedMemoChangeRef.current(saved);
        await onRefreshMemosRef.current();

        setStatus("saved");
        clearSavedTimer();
        savedClearTimerRef.current = setTimeout(() => {
          setStatus((s) => (s === "saved" ? "idle" : s));
          savedClearTimerRef.current = null;
        }, SAVED_STATUS_MS);
        return true;
      } catch (error) {
        console.error("Failed to save memo:", error);
        const msg = `保存失败: ${error}`;
        setStatus("error");
        setErrorMessage(msg);
        if (explicit) {
          alert(`保存备忘录失败: ${error}`);
        }
        return false;
      }
    },
    [clearSavedTimer]
  );

  const enqueueSave = useCallback(
    (explicit: boolean): Promise<boolean> => {
      const next = saveChainRef.current.then(
        () => performSave(explicit),
        () => performSave(explicit)
      );
      saveChainRef.current = next.then(
        () => true,
        () => true
      );
      return next;
    },
    [performSave]
  );

  const saveNow = useCallback(
    async (opts?: { explicit?: boolean }): Promise<boolean> => {
      clearDebounce();
      return enqueueSave(opts?.explicit ?? false);
    },
    [clearDebounce, enqueueSave]
  );

  const flushOnExit = useCallback(async (): Promise<boolean> => {
    clearDebounce();
    if (!enabledRef.current) return true;
    if (!isDirty()) return true;
    if (
      !hasMemoSubstance(editTitleRef.current, editContentRef.current)
    ) {
      // 无实质内容：不落盘，交由脏检查提示
      return true;
    }
    return enqueueSave(false);
  }, [clearDebounce, enqueueSave, isDirty]);

  // 编辑中防抖自动保存
  useEffect(() => {
    if (!enabled) return;
    if (
      !isMemoEditDirty(
        editTitle,
        editContent,
        baselineTitleRef.current,
        baselineContentRef.current
      )
    ) {
      return;
    }
    if (!hasMemoSubstance(editTitle, editContent)) return;

    clearDebounce();
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      void enqueueSave(false);
    }, debounceMs);

    return () => {
      clearDebounce();
    };
  }, [enabled, editTitle, editContent, debounceMs, clearDebounce, enqueueSave]);

  useEffect(() => {
    return () => {
      clearDebounce();
      clearSavedTimer();
    };
  }, [clearDebounce, clearSavedTimer]);

  let statusLabel = "";
  if (status === "saving") statusLabel = "保存中…";
  else if (status === "saved") statusLabel = "已自动保存";
  else if (status === "error") statusLabel = errorMessage || "自动保存失败";

  return {
    status,
    statusLabel,
    isDirty,
    saveNow,
    flushOnExit,
  };
}
