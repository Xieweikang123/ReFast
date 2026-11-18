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
    <div className="mb-3">
      <label className="sr-only" htmlFor="memo-list-search">
        搜索备忘录
      </label>
      <div className="relative">
        <input
          id="memo-list-search"
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="搜索标题或正文…"
          autoComplete="off"
          className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-3 pr-9 text-sm text-gray-900 shadow-sm transition-shadow placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            title="清除"
          >
            ×
          </button>
        )}
      </div>
      {showCount && (
        <p className="mt-1.5 text-[11px] text-gray-400">
          匹配 {matchCount} / {totalCount} 条
        </p>
      )}
    </div>
  );
}
