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

  const dotClass =
    tone === "dirty"
      ? "bg-amber-500"
      : tone === "info"
      ? "bg-blue-500"
      : "bg-gray-300";
  const textClass =
    tone === "dirty"
      ? "text-amber-700"
      : tone === "info"
      ? "text-blue-600"
      : "text-gray-400";

  return (
    <div className="shrink-0 border-t border-gray-200/80 bg-white/95 backdrop-blur-sm">
      <div
        className={`flex items-center justify-between gap-3 py-3 ${
          contentClassName ?? "px-4"
        }`.trim()}
      >
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <span
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`}
            aria-hidden
          />
          <span className={`truncate ${textClass}`}>{status}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void onSave()}
            className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-600"
          >
            保存
          </button>
          <button
            type="button"
            onClick={() => void onCancel()}
            className="rounded-lg px-4 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-100"
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
              className="rounded-lg px-4 py-2 text-sm text-red-600 transition-colors hover:bg-red-50"
            >
              删除
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
