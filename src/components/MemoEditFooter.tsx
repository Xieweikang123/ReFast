interface MemoEditFooterProps {
  /** 相对基线是否有未保存改动 */
  dirty: boolean;
  /** 可选：自动保存等额外状态文案；有值时优先显示 */
  statusText?: string | null;
  onSave: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
  showDelete?: boolean;
  /** 与顶栏/正文对齐的内容列 class（大窗布局用） */
  contentClassName?: string;
}

/**
 * 编辑底栏：左侧状态（未保存 / Ctrl+S / 自动保存文案），右侧操作。
 * statusText 预留给并行落地的 autosave，避免状态像外挂。
 */
export function MemoEditFooter({
  dirty,
  statusText,
  onSave,
  onCancel,
  onDelete,
  showDelete = false,
  contentClassName,
}: MemoEditFooterProps) {
  const external = statusText?.trim() || "";
  const status = external || (dirty ? "未保存的更改" : "Ctrl+S 保存");
  const tone: "info" | "dirty" | "idle" = external
    ? "info"
    : dirty
    ? "dirty"
    : "idle";

  const pillClass =
    tone === "dirty"
      ? "bg-amber-50 text-amber-800 ring-amber-200/90"
      : tone === "info"
      ? "bg-sky-50 text-sky-800 ring-sky-200/90"
      : "bg-slate-50 text-slate-500 ring-slate-200/80";
  const dotClass =
    tone === "dirty"
      ? "bg-amber-500"
      : tone === "info"
      ? "bg-sky-500"
      : "bg-slate-300";

  return (
    <div className="shrink-0 border-t border-slate-200/50 bg-white/95 shadow-[0_-10px_32px_rgba(15,23,42,0.05)] backdrop-blur-xl">
      <div
        className={`flex items-center justify-between gap-4 py-4 ${
          contentClassName ?? "px-5"
        }`.trim()}
      >
        <div
          className={`inline-flex min-w-0 max-w-[50%] items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium ring-1 ${pillClass}`}
        >
          <span
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotClass} ${
              tone === "dirty" ? "animate-pulse" : ""
            }`}
            aria-hidden
          />
          <span className="truncate">{status}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <button
            type="button"
            onClick={() => void onSave()}
            className="rounded-xl bg-sky-500 px-5 py-2.5 text-sm font-semibold text-white shadow-[0_4px_14px_rgba(14,165,233,0.4)] transition-[background-color,box-shadow,transform] hover:bg-sky-600 hover:shadow-[0_6px_18px_rgba(14,165,233,0.45)] active:translate-y-px"
          >
            保存
          </button>
          <button
            type="button"
            onClick={() => void onCancel()}
            className="rounded-xl border border-slate-200/90 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
          >
            取消
          </button>
          {showDelete && onDelete && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void onDelete();
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              className="rounded-xl px-4 py-2.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
            >
              删除
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
