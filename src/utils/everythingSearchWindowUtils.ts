/**
 * Everything 搜索窗口用到的纯函数：查询拼装、类型识别、高亮分段
 */

export type FileKind =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "code"
  | "archive"
  | "document"
  | "program"
  | "file";

export type ItemKindFilter = "all" | "file" | "folder";

export interface ComposeEverythingQueryOptions {
  pathScope?: string;
  caseSensitive?: boolean;
  matchWholeWord?: boolean;
}

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "webp",
  "svg",
  "ico",
  "tif",
  "tiff",
  "heic",
  "avif",
]);
const VIDEO_EXTS = new Set([
  "mp4",
  "mkv",
  "avi",
  "mov",
  "wmv",
  "flv",
  "webm",
  "m4v",
  "ts",
]);
const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "ape"]);
const ARCHIVE_EXTS = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso"]);
const DOCUMENT_EXTS = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "txt",
  "rtf",
  "odt",
  "csv",
  "md",
]);
const PROGRAM_EXTS = new Set(["exe", "msi", "bat", "cmd", "ps1", "lnk", "com", "msc"]);
const CODE_EXTS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "java",
  "c",
  "cpp",
  "h",
  "cs",
  "rs",
  "go",
  "rb",
  "php",
  "kt",
  "swift",
  "sh",
  "html",
  "css",
  "scss",
  "less",
  "json",
  "jsonc",
  "yml",
  "yaml",
  "toml",
  "ini",
  "sql",
  "vue",
  "xml",
]);

/** 把界面选项拼成 Everything 查询（不覆盖用户已写的语法） */
export function composeEverythingQuery(
  raw: string,
  options: ComposeEverythingQueryOptions = {}
): string {
  const trimmed = raw.trim();
  const parts: string[] = [];

  if (options.caseSensitive && !/(^|\s)case:/i.test(trimmed)) {
    parts.push("case:");
  }
  if (options.matchWholeWord && !/(^|\s)ww:/i.test(trimmed)) {
    parts.push("ww:");
  }
  if (trimmed) {
    parts.push(trimmed);
  }

  const scope = options.pathScope?.trim();
  if (scope && !/(^|\s)path:/i.test(trimmed)) {
    const cleaned = scope.replace(/"/g, "");
    if (cleaned) {
      parts.push(`path:"${cleaned}"`);
    }
  }

  return parts.join(" ");
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function getExtension(pathOrName: string): string | null {
  const lastDotIndex = pathOrName.lastIndexOf(".");
  if (lastDotIndex <= 0) return null;
  const ext = pathOrName.substring(lastDotIndex + 1);
  if (ext.includes("/") || ext.includes("\\") || ext.length === 0) return null;
  return ext.toLowerCase();
}

export function parseDate(dateStr?: string): number | null {
  if (!dateStr) return null;
  const ts = Date.parse(dateStr);
  if (Number.isNaN(ts)) return null;
  return ts;
}

export function classifyFileKind(
  name: string,
  isFolder?: boolean | null
): FileKind {
  if (isFolder) return "folder";
  const ext = getExtension(name);
  if (!ext) return "file";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (ARCHIVE_EXTS.has(ext)) return "archive";
  if (DOCUMENT_EXTS.has(ext)) return "document";
  if (PROGRAM_EXTS.has(ext)) return "program";
  if (CODE_EXTS.has(ext)) return "code";
  return "file";
}

export function getFileKindLabel(kind: FileKind): string {
  switch (kind) {
    case "folder":
      return "文件夹";
    case "image":
      return "图片";
    case "video":
      return "视频";
    case "audio":
      return "音频";
    case "archive":
      return "压缩包";
    case "document":
      return "文档";
    case "program":
      return "程序";
    case "code":
      return "代码";
    default:
      return "文件";
  }
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

/** 按关键词（忽略 Everything 语法前缀）把文件名拆成高亮段 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const keyword = extractHighlightKeyword(query);
  if (!keyword || !text) {
    return [{ text, match: false }];
  }

  const lowerText = text.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const segments: HighlightSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const index = lowerText.indexOf(lowerKeyword, cursor);
    if (index === -1) {
      segments.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (index > cursor) {
      segments.push({ text: text.slice(cursor, index), match: false });
    }
    segments.push({
      text: text.slice(index, index + keyword.length),
      match: true,
    });
    cursor = index + keyword.length;
  }

  return segments.length > 0 ? segments : [{ text, match: false }];
}

function extractHighlightKeyword(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return "";
  const tokens = trimmed.split(/\s+/).filter((token) => {
    const lower = token.toLowerCase();
    return (
      lower !== "case:" &&
      lower !== "ww:" &&
      lower !== "file:" &&
      lower !== "folder:" &&
      !lower.startsWith("path:") &&
      !lower.startsWith("ext:") &&
      !lower.startsWith("regex:") &&
      !lower.startsWith("parent:")
    );
  });
  const first = tokens[0] || "";
  return first.replace(/[*?"]/g, "");
}

export function readRecentQueries(raw: string | null, max = 8): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, max);
  } catch {
    return [];
  }
}

export function pushRecentQuery(
  list: string[],
  query: string,
  max = 8
): string[] {
  const trimmed = query.trim();
  if (!trimmed) return list;
  const next = [trimmed, ...list.filter((item) => item !== trimmed)];
  return next.slice(0, max);
}
