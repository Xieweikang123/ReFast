interface MemoToastProps {
  message: string | null;
  /** info：普通反馈；error：失败提示 */
  tone?: "info" | "error";
}

/**
 * 备忘录轻量 Toast：非阻塞、约 1.5–2s 自动消失，替代 window.alert。
 */
export function MemoToast({ message, tone = "info" }: MemoToastProps) {
  if (!message) return null;

  const toneClass =
    tone === "error"
      ? "bg-red-600 text-white"
      : "bg-gray-800/95 text-white";

  return (
    <div
      className={`pointer-events-none fixed bottom-8 left-1/2 z-[110] max-w-[min(90vw,24rem)] -translate-x-1/2 truncate rounded-lg px-3.5 py-2 text-center text-xs shadow-lg ${toneClass}`}
      role="status"
      aria-live="polite"
    >
      {message}
    </div>
  );
}
