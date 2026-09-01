/**
 * 搜索过滤器前缀：a/f/p/m/e + 空格
 * 优先于搜索引擎前缀解析
 */

export type SearchScope =
  | "all"
  | "app"
  | "file"
  | "plugin"
  | "memo"
  | "everything";

export interface ParsedSearchFilter {
  scope: SearchScope;
  /** 去掉过滤器前缀后的关键词（已 trim） */
  keyword: string;
  /** 原始查询（未改写） */
  rawQuery: string;
  /** 是否匹配到过滤器前缀 */
  hasFilter: boolean;
  /** 展示用标签，如「仅应用」 */
  prefixLabel?: string;
  /** 匹配到的前缀文本，如 "a " */
  matchedPrefix?: string;
}

const FILTER_PREFIXES_RAW: Array<{
  prefix: string;
  scope: Exclude<SearchScope, "all">;
  label: string;
}> = [
  { prefix: "a ", scope: "app", label: "仅应用" },
  { prefix: "f ", scope: "file", label: "仅文件" },
  { prefix: "p ", scope: "plugin", label: "仅插件" },
  { prefix: "m ", scope: "memo", label: "仅备忘录" },
  { prefix: "e ", scope: "everything", label: "仅 Everything" },
];

const FILTER_PREFIXES = [...FILTER_PREFIXES_RAW].sort(
  (a, b) => b.prefix.length - a.prefix.length
);

/**
 * 解析搜索过滤器前缀。
 * 规则：前缀必须以空格结尾（如 "a "），且优先匹配更长前缀。
 */
export function parseSearchFilter(query: string): ParsedSearchFilter {
  const rawQuery = query ?? "";
  // 保留前缀所需的尾随空格：仅去掉首部空白，避免 "a " 被 trim 成 "a"
  const normalized = rawQuery.replace(/^\s+/, "");

  for (const item of FILTER_PREFIXES) {
    if (normalized.toLowerCase().startsWith(item.prefix)) {
      const keyword = normalized.slice(item.prefix.length).trim();
      return {
        scope: item.scope,
        keyword,
        rawQuery,
        hasFilter: true,
        prefixLabel: item.label,
        matchedPrefix: item.prefix,
      };
    }
  }

  const keyword = normalized.trim();
  return {
    scope: "all",
    keyword,
    rawQuery,
    hasFilter: false,
  };
}

/** 是否有有效搜索关键词（纯前缀不算） */
export function hasSearchKeyword(parsed: ParsedSearchFilter): boolean {
  return parsed.keyword.length > 0;
}

/**
 * 按 scope 判断是否应搜索某一数据源
 */
export function shouldSearchSource(
  scope: SearchScope,
  source:
    | "app"
    | "file"
    | "systemFolder"
    | "everything"
    | "plugin"
    | "memo"
    | "url"
    | "email"
    | "json"
    | "path"
    | "searchEngine"
    | "ai"
    | "history"
    | "settings"
): boolean {
  if (scope === "all") return true;

  switch (scope) {
    case "app":
      return source === "app" || source === "settings";
    case "file":
      return (
        source === "file" ||
        source === "everything" ||
        source === "systemFolder" ||
        source === "path"
      );
    case "plugin":
      return source === "plugin";
    case "memo":
      return source === "memo";
    case "everything":
      return source === "everything";
    default:
      return true;
  }
}

/**
 * 结果类型是否属于当前 scope
 */
export function resultMatchesScope(
  resultType: string,
  scope: SearchScope
): boolean {
  if (scope === "all") return true;

  switch (scope) {
    case "app":
      return resultType === "app" || resultType === "settings";
    case "file":
      return resultType === "file" || resultType === "everything";
    case "plugin":
      return resultType === "plugin";
    case "memo":
      return resultType === "memo";
    case "everything":
      return resultType === "everything";
    default:
      return true;
  }
}

/** Everything 自动搜索的最短关键词长度（JS string length，中文一字为 1） */
export const EVERYTHING_AUTO_MIN_KEYWORD_LENGTH = 2;

export function isShortEverythingKeyword(keyword: string): boolean {
  const trimmed = keyword.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length < EVERYTHING_AUTO_MIN_KEYWORD_LENGTH
  );
}

/** 是否应自动/强制走 Everything：达到最短长度，或用户已对当前关键词点过手动搜索 */
export function shouldAutoSearchEverything(
  keyword: string,
  forceKeyword?: string | null
): boolean {
  const trimmed = keyword.trim();
  if (!trimmed) return false;
  if (trimmed.length >= EVERYTHING_AUTO_MIN_KEYWORD_LENGTH) return true;
  return forceKeyword === trimmed;
}

/** 单字跳过磁盘搜索时，是否显示「点一下走 Everything」提示 */
export function shouldShowEverythingSkippedHint(options: {
  query: string;
  isEverythingAvailable: boolean;
  isSearchingEverything: boolean;
  forceKeyword?: string | null;
}): boolean {
  if (!options.isEverythingAvailable) return false;
  if (options.isSearchingEverything) return false;
  const parsed = parseSearchFilter(options.query);
  if (!hasSearchKeyword(parsed)) return false;
  if (!shouldSearchSource(parsed.scope, "everything")) return false;
  if (!isShortEverythingKeyword(parsed.keyword)) return false;
  if (options.forceKeyword === parsed.keyword) return false;
  return true;
}
