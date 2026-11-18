import type { MemoItem } from "../types";

/** 丢弃未保存备忘录编辑时的确认文案 */
export const MEMO_DISCARD_CONFIRM_MESSAGE = "有未保存的修改，确定丢弃吗？";

/**
 * 编辑中的标题/正文相对基线是否有未保存改动。
 * 新建时基线为空串；编辑时基线为原备忘录的 title/content。
 */
export function isMemoEditDirty(
  editTitle: string,
  editContent: string,
  baselineTitle = "",
  baselineContent = ""
): boolean {
  return editTitle !== baselineTitle || editContent !== baselineContent;
}

/** 快速复制优先用标题（列表主行），标题空则退到正文 */
export function getMemoPrimaryCopyText(
  memo: Pick<MemoItem, "title" | "content">
): string {
  const title = memo.title?.trim() ?? "";
  if (title) return title;
  return memo.content?.trim() ?? "";
}

export function getMemoTitleText(
  memo: Pick<MemoItem, "title">
): string {
  return memo.title?.trim() ?? "";
}

export function getMemoContentText(
  memo: Pick<MemoItem, "content">
): string {
  return memo.content?.trim() ?? "";
}

/** 复制 AI 提示词成功后的短反馈文案 */
export const MEMO_AI_PROMPT_COPIED_MESSAGE = "已复制提示词";

/** 拼接备忘录 Markdown 绝对路径：`{root}/{id}.md`（兼容 / 与 \） */
export function joinMemoMdPath(root: string, memoId: string): string {
  const trimmed = root.replace(/[/\\]+$/, "");
  const sep = trimmed.includes("\\") || /^[a-zA-Z]:/.test(trimmed) ? "\\" : "/";
  return `${trimmed}${sep}${memoId}.md`;
}

/** 全局：让 AI 阅读整个备忘录目录 */
export function buildMemosRootAiPrompt(absolutePath: string): string {
  return `请阅读我的 ReFast 备忘录目录下的 Markdown 笔记（含 images 相对路径图片），目录：${absolutePath}。先列出笔记再按我的问题回答。`;
}

/** 单条：让 AI 阅读指定备忘录 .md 文件 */
export function buildMemoFileAiPrompt(filePath: string): string {
  return `请阅读这篇备忘录并回答我的问题：${filePath}`;
}
