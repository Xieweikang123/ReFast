/**
 * 纵向搜索结果可见列表（扁平，不再按类型分组）
 */

import type { SearchResult } from "./resultUtils";

export const EVERYTHING_DEFAULT_LIMIT = 15;

export const SHOW_MORE_EVERYTHING_PATH = "ui://show-more-everything" as const;

export type VisibleVerticalItem =
  | { kind: "result"; result: SearchResult }
  | {
      kind: "show_more";
      remaining: number;
      /** 合成 path，便于键盘/点击识别 */
      path: typeof SHOW_MORE_EVERYTHING_PATH;
    };

export interface BuildVisibleOptions {
  /** 已按相关性+最近使用排序的扁平纵向结果 */
  verticalResults: SearchResult[];
  everythingLimit: number;
}

/**
 * 从排序后的扁平纵向结果生成可见列表。
 * Everything 结果默认截断到 everythingLimit 条，并在末尾插入「显示更多」。
 * 结果顺序完全由全局排序决定：最近使用的「其他」类型结果也会自然排到前面。
 */
export function buildVisibleVerticalItems(
  options: BuildVisibleOptions
): VisibleVerticalItem[] {
  const { verticalResults, everythingLimit } = options;
  const limit = Math.max(0, everythingLimit);
  const items: VisibleVerticalItem[] = [];
  let everythingShown = 0;
  let everythingTotal = 0;

  for (const result of verticalResults) {
    if (result.type === "everything") {
      everythingTotal++;
      if (everythingShown < limit) {
        everythingShown++;
        items.push({ kind: "result", result });
      }
    } else {
      items.push({ kind: "result", result });
    }
  }

  const remaining = Math.max(0, everythingTotal - limit);
  if (remaining > 0) {
    items.push({
      kind: "show_more",
      remaining,
      path: SHOW_MORE_EVERYTHING_PATH,
    });
  }

  return items;
}

/** 从可见项中取出可启动的 SearchResult（show_more 返回 null） */
export function getResultFromVisibleItem(
  item: VisibleVerticalItem | undefined
): SearchResult | null {
  if (!item || item.kind !== "result") return null;
  return item.result;
}

/**
 * 用默认 Everything 截断，从完整纵向结果生成可见列表。
 * 供结果加载时计算选中索引，避免对未展示项选中后滚到底部。
 */
export function buildDefaultVisibleVerticalItems(
  verticalResults: SearchResult[]
): VisibleVerticalItem[] {
  return buildVisibleVerticalItems({
    verticalResults,
    everythingLimit: EVERYTHING_DEFAULT_LIMIT,
  });
}
