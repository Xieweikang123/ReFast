interface MemoListSearchBarProps {
  value: string;
  onChange: (value: string) => void;
  /** 当前过滤后条数（有关键词时展示） */
  matchCount?: number;
  totalCount?: number;
}

/** 备忘录列表顶栏搜索框 */
export function MemoListSearchBar({
  value,
  onChange,
  matchCount,
  totalCount,
}: MemoListSearchBarProps) {
  const showCount =
    value.trim().length > 0 &&
    typeof matchCount === "number" &&
    typeof totalCount === "number";

  return (
    <div className="mb-4">
      <label className="sr-only" htmlFor="memo-list-search">
        搜索备忘录
      </label>
      <div className="relative">
        <svg
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
        <input
          id="memo-list-search"
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="搜索标题或正文…"
          autoComplete="off"
          className="w-full rounded-2xl border border-slate-200/90 bg-white/80 py-3 pl-10 pr-10 text-[15px] text-slate-900 shadow-[0_2px_10px_rgba(15,23,42,0.05)] backdrop-blur-sm transition-[border-color,box-shadow,background-color] placeholder:text-slate-400 focus:border-sky-400 focus:bg-white focus:outline-none focus:ring-4 focus:ring-sky-500/15"
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-sm text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            title="清除"
          >
            ×
          </button>
        )}
      </div>
      {showCount && (
        <p className="mt-2 text-[12px] font-medium text-slate-400 tabular-nums">
          匹配{" "}
          <span className="text-sky-600">{matchCount}</span> / {totalCount} 条
        </p>
      )}
    </div>
  );
}
