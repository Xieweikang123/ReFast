interface MemoListLoadingProps {
  message?: string;
}

/** 列表加载中 */
export function MemoListLoading({
  message = "加载备忘录…",
}: MemoListLoadingProps) {
  return (
    <div className="flex h-full min-h-[220px] flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 h-9 w-9 animate-spin rounded-full border-[3px] border-sky-100 border-t-sky-500" />
      <div className="text-sm font-medium text-slate-500">{message}</div>
    </div>
  );
}

interface MemoListErrorProps {
  message: string;
  onRetry: () => void;
}

/** 列表加载失败 */
export function MemoListError({ message, onRetry }: MemoListErrorProps) {
  return (
    <div className="flex h-full min-h-[220px] flex-col items-center justify-center px-6 text-center">
      <div className="text-base font-bold text-red-600">加载失败</div>
      <div className="mt-2 max-w-sm text-[13px] leading-relaxed text-slate-500">
        {message}
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 rounded-xl border border-sky-500 bg-sky-500 px-4 py-2 text-sm font-semibold text-white shadow-[0_4px_14px_rgba(14,165,233,0.35)] hover:border-sky-600 hover:bg-sky-600"
      >
        重试
      </button>
    </div>
  );
}

interface MemoListNoMatchProps {
  query: string;
  onClear: () => void;
}

/** 有数据但搜索无结果 */
export function MemoListNoMatch({ query, onClear }: MemoListNoMatchProps) {
  return (
    <div className="flex h-full min-h-[200px] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200/90 bg-white/50 px-6 py-10 text-center">
      <div className="text-base font-bold text-slate-800">无匹配备忘录</div>
      <div className="mt-2 max-w-xs text-[13px] leading-relaxed text-slate-500">
        没有找到包含「{query.trim()}」的标题或正文
      </div>
      <button
        type="button"
        onClick={onClear}
        className="mt-4 rounded-xl bg-sky-50 px-3.5 py-1.5 text-[13px] font-semibold text-sky-600 ring-1 ring-sky-200/80 transition-colors hover:bg-sky-100"
      >
        清除搜索
      </button>
    </div>
  );
}
