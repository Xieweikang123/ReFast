/** 将 Markdown 图片语法收成 [图片]，便于列表摘要 */
export function stripMemoImages(content: string): string {
  return content.replace(/!\[[^\]]*\]\([^)]+\)/g, "[图片]");
}

/** 提取正文中的本地图片相对路径 `images/...` */
export function extractMemoImageRefs(content: string): string[] {
  const refs: string[] = [];
  const re = /!\[[^\]]*\]\((images\/[^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const rel = m[1];
    if (rel && !rel.includes("..") && !refs.includes(rel)) {
      refs.push(rel);
    }
  }
  return refs;
}

export function firstMemoImageRef(content: string): string | null {
  return extractMemoImageRefs(content)[0] ?? null;
}

/** 从正文移除某张图的 Markdown 引用 */
export function removeMemoImageRef(content: string, rel: string): string {
  const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content
    .replace(new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)\\n?`, "g"), "")
    .replace(/\n{3,}/g, "\n\n");
}

/** 是否有可保存的实质内容（文字或图片） */
export function hasMemoSubstance(
  title: string,
  content: string
): boolean {
  if (title.trim()) return true;
  const raw = content.trim();
  if (!raw) return false;
  if (extractMemoImageRefs(raw).length > 0) return true;
  return stripMemoImages(raw).replace(/\s+/g, "").length > 0;
}

/** 列表/搜索用的纯文本预览 */
export function getMemoContentPreview(
  content: string | null | undefined,
  maxLen = 80
): string {
  const raw = (content ?? "").trim();
  if (!raw) return "(无内容)";
  const stripped = stripMemoImages(raw).replace(/\s+/g, " ").trim();
  if (!stripped) return "[图片]";
  if (stripped.length <= maxLen) return stripped;
  return `${stripped.slice(0, maxLen)}...`;
}
