interface MemoModeToggleProps {
  mode: "edit" | "preview";
  onEdit: () => void;
  onPreview: () => void;
  /** 预览不可用时（如新建未落盘）禁用预览侧 */
  previewDisabled?: boolean;
}

/** 编辑 / 预览分段切换，统一顶栏模式层级 */
export function MemoModeToggle({
  mode,
  onEdit,
  onPreview,
  previewDisabled = false,
}: MemoModeToggleProps) {
  const segment =
    "relative z-[1] rounded-[10px] px-3.5 py-1.5 text-[13px] font-semibold transition-colors";
  const active = "bg-white text-slate-900 shadow-sm";
  const idle = "text-slate-500 hover:text-slate-700";

  return (
    <div
      className="inline-flex items-center rounded-xl bg-slate-100/90 p-1 ring-1 ring-slate-200/80"
      role="group"
      aria-label="编辑或预览"
    >
      <button
        type="button"
        onClick={onEdit}
        aria-pressed={mode === "edit"}
        className={`${segment} ${mode === "edit" ? active : idle}`}
      >
        编辑
      </button>
      <button
        type="button"
        onClick={onPreview}
        disabled={previewDisabled}
        aria-pressed={mode === "preview"}
        title={previewDisabled ? "保存后可预览" : "切换到只读预览"}
        className={`${segment} ${
          mode === "preview" ? active : idle
        } disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-slate-500`}
      >
        预览
      </button>
    </div>
  );
}
