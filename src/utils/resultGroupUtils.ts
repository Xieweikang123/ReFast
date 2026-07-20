/**
 * 纵向搜索结果分组与可见列表
 */

import type { SearchResult } from "./resultUtils";

export const EVERYTHING_DEFAULT_LIMIT = 15;

export type VerticalGroupId = "files" | "everything" | "other";

export interface VerticalGroup {
  id: VerticalGroupId;
  title: string;
  results: SearchResult[];
}

export type VisibleVerticalItem =
  | { kind: "result"; result: SearchResult; groupId: VerticalGroupId }
  | {
      kind: "show_more";
      groupId: "everything";
      remaining: number;
      /** 合成 path，便于键盘/点击识别 */
      path: "ui://show-more-everything";
    };

export const SHOW_MORE_EVERYTHING_PATH = "ui://show-more-everything" as const;

export interface GroupCollapseState {
  files: boolean;
  everything: boolean;
  other: boolean;
}

export const DEFAULT_GROUP_COLLAPSE: GroupCollapseState = {
  files: false,
  everything: false,
  other: false,
};

const FILE_TYPES = new Set(["file"]);
const EVERYTHING_TYPES = new Set(["everything"]);

export function getGroupTitle(id: VerticalGroupId, isMac = false): string {
  switch (id) {
    case "files":
      return "文件";
    case "everything":
      return isMac ? "Spotlight" : "Everything";
    case "other":
      return "其他";
  }
}

/**
 * 将纵向结果分成 文件 / Everything / 其他
 */
export function groupVerticalResults(
  verticalResults: SearchResult[],
  isMac = false
): VerticalGroup[] {
  const files: SearchResult[] = [];
  const everything: SearchResult[] = [];
  const other: SearchResult[] = [];

  for (const result of verticalResults) {
    if (FILE_TYPES.has(result.type)) {
      files.push(result);
    } else if (EVERYTHING_TYPES.has(result.type)) {
      everything.push(result);
    } else {
      other.push(result);
    }
  }

  const groups: VerticalGroup[] = [];
  if (files.length > 0) {
    groups.push({ id: "files", title: getGroupTitle("files", isMac), results: files });
  }
  if (everything.length > 0) {
    groups.push({
      id: "everything",
      title: getGroupTitle("everything", isMac),
      results: everything,
    });
  }
  if (other.length > 0) {
    groups.push({ id: "other", title: getGroupTitle("other", isMac), results: other });
  }
  return groups;
}

export interface BuildVisibleOptions {
  groups: VerticalGroup[];
  collapsed: GroupCollapseState;
  everythingLimit: number;
}

/**
 * 根据折叠与 Everything 条数限制，生成可键盘导航的可见扁平列表
 *（不含组头；组头仅作 UI 分隔）
 */
export function buildVisibleVerticalItems(
  options: BuildVisibleOptions
): VisibleVerticalItem[] {
  const { groups, collapsed, everythingLimit } = options;
  const items: VisibleVerticalItem[] = [];

  for (const group of groups) {
    if (collapsed[group.id]) continue;

    if (group.id === "everything") {
      const limit = Math.max(0, everythingLimit);
      const visible = group.results.slice(0, limit);
      for (const result of visible) {
        items.push({ kind: "result", result, groupId: "everything" });
      }
      const remaining = group.results.length - visible.length;
      if (remaining > 0) {
        items.push({
          kind: "show_more",
          groupId: "everything",
          remaining,
          path: SHOW_MORE_EVERYTHING_PATH,
        });
      }
    } else {
      for (const result of group.results) {
        items.push({ kind: "result", result, groupId: group.id });
      }
    }
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
