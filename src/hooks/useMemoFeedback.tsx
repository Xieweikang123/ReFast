import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { MemoToast } from "../components/MemoToast";

type ToastTone = "info" | "error";

type ConfirmOptions = {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "danger" | "warning";
};

type ConfirmRequest = ConfirmOptions & {
  resolve: (ok: boolean) => void;
};

const TOAST_MS = 1800;

/**
 * 备忘录反馈：轻量 Toast + 站内确认（替代 alert / Tauri 原生 confirm）。
 */
export function useMemoFeedback() {
  const [toast, setToast] = useState<{
    message: string;
    tone: ToastTone;
  } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);

  const showToast = useCallback((message: string, tone: ToastTone = "info") => {
    setToast({ message, tone });
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const askConfirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setConfirmReq((prev) => {
        prev?.resolve(false);
        return { ...options, resolve };
      });
    });
  }, []);

  const closeConfirm = useCallback((ok: boolean) => {
    setConfirmReq((prev) => {
      prev?.resolve(ok);
      return null;
    });
  }, []);

  const feedbackNodes = (
    <>
      <MemoToast message={toast?.message ?? null} tone={toast?.tone} />
      <ConfirmDialog
        isOpen={!!confirmReq}
        title={confirmReq?.title ?? ""}
        message={confirmReq?.message ?? ""}
        confirmText={confirmReq?.confirmText}
        cancelText={confirmReq?.cancelText}
        variant={confirmReq?.variant ?? "warning"}
        onConfirm={() => closeConfirm(true)}
        onCancel={() => closeConfirm(false)}
      />
    </>
  );

  return { showToast, askConfirm, feedbackNodes };
}
