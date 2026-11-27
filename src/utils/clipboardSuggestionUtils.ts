/**
 * 启动器剪贴板静默建议：路径 / URL / JSON / 公式 / 换算 / hex / 多行算式
 * 只产出建议，不自动改 query。
 */

import type { tauriApi } from "../api/tauri";
import { isMathExpression } from "./launcherUtils";
import {
  convertUnit,
  evaluateMathExpression,
} from "./instantToolsUtils";

export type ClipboardSuggestionKind =
  | "path"
  | "url"
  | "json"
  | "calc"
  | "unit"
  | "hex"
  | "calc_pad";

export interface ClipboardSuggestion {
  kind: ClipboardSuggestionKind;
  /** 动作使用的完整内容 */
  raw: string;
  message: string;
  actionLabel: string;
  testId: string;
}

const JSON_MAX_CHARS = 200_000;
const HEX_BARE_MIN = 8;
const HEX_BARE_MAX = 256;
const PREVIEW_MAX = 48;

export function truncatePreview(text: string, max = PREVIEW_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

/** 去首尾引号、统一取首行（路径/URL 用） */
export function normalizeClipboardFirstLine(text: string): string {
  let s = text.replace(/^\uFEFF/, "").trim();
  s = s.replace(/^["']|["']$/g, "");
  s = s.split(/\r?\n/)[0] ?? "";
  return s.trim().replace(/^["']|["']$/g, "");
}

export function looksLikeFilesystemPath(text: string): boolean {
  const s = text.trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return false;
  return (
    s.includes("\\") ||
    s.includes("/") ||
    /^[A-Za-z]:/.test(s) ||
    s.startsWith("\\\\")
  );
}

export function looksLikeUrl(text: string): boolean {
  return /^https?:\/\/\S+/i.test(text.trim());
}

export function tryParseJsonSuggestion(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length > JSON_MAX_CHARS) return null;
  const head = trimmed[0];
  if (head !== "{" && head !== "[") return null;
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    return null;
  }
}

/** 0x… 或收紧后的纯 hex 串 */
export function looksLikeHexPayload(text: string): boolean {
  const s = text.trim().replace(/\s+/g, "");
  if (!s) return false;

  if (/^0x[0-9a-fA-F]{2,}$/i.test(s)) {
    return true;
  }

  if (s.length < HEX_BARE_MIN || s.length > HEX_BARE_MAX) return false;
  if (s.length % 2 !== 0) return false;
  if (!/^[0-9a-fA-F]+$/.test(s)) return false;
  // 至少含一个 a-f，避免纯十进制电话/订单号误伤
  if (!/[a-fA-F]/.test(s)) return false;
  return true;
}

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** 多行且至少两行可算 */
export function detectMultilineCalcPad(text: string): string | null {
  const lines = nonEmptyLines(text);
  if (lines.length < 2) return null;
  let mathLines = 0;
  for (const line of lines) {
    if (evaluateMathExpression(line) !== null || isMathExpression(line)) {
      mathLines += 1;
    }
  }
  if (mathLines < 2) return null;
  return text.trim();
}

function pathSuggestion(raw: string): ClipboardSuggestion {
  return {
    kind: "path",
    raw,
    message: `剪贴板有路径：${truncatePreview(raw)}`,
    actionLabel: "搜索",
    testId: "clipboard-suggest-path-button",
  };
}

/**
 * 在已拿到剪贴板文本 / HDROP / 路径是否存在 的前提下做优先级匹配（便于单测）。
 * pathExists 为 true 的候选路径才会出 path 建议。
 */
export function detectClipboardSuggestion(input: {
  text?: string | null;
  filePath?: string | null;
  /** 已确认存在的路径（text 规范化后或 HDROP） */
  existingPath?: string | null;
}): ClipboardSuggestion | null {
  const text = input.text ?? "";
  const existingPath = input.existingPath?.trim() || null;

  if (existingPath) {
    return pathSuggestion(existingPath);
  }

  const firstLine = text ? normalizeClipboardFirstLine(text) : "";

  if (firstLine && looksLikeUrl(firstLine)) {
    const url = firstLine.trim();
    return {
      kind: "url",
      raw: url,
      message: `剪贴板有链接：${truncatePreview(url)}`,
      actionLabel: "打开",
      testId: "clipboard-suggest-url-button",
    };
  }

  const json = text ? tryParseJsonSuggestion(text) : null;
  if (json) {
    return {
      kind: "json",
      raw: json,
      message: "剪贴板是 JSON",
      actionLabel: "格式化",
      testId: "clipboard-suggest-json-button",
    };
  }

  const singleLine = nonEmptyLines(text).length <= 1;
  if (singleLine && firstLine) {
    const calcValue = evaluateMathExpression(firstLine);
    if (calcValue !== null) {
      return {
        kind: "calc",
        raw: firstLine,
        message: `剪贴板公式：${truncatePreview(firstLine)} → ${calcValue}`,
        actionLabel: "填入",
        testId: "clipboard-suggest-calc-button",
      };
    }

    const unit = convertUnit(firstLine);
    if (unit) {
      return {
        kind: "unit",
        raw: firstLine,
        message: `剪贴板换算：${truncatePreview(unit.displayName)}`,
        actionLabel: "填入",
        testId: "clipboard-suggest-unit-button",
      };
    }

    if (looksLikeHexPayload(firstLine)) {
      return {
        kind: "hex",
        raw: firstLine,
        message: `剪贴板像十六进制：${truncatePreview(firstLine)}`,
        actionLabel: "转换",
        testId: "clipboard-suggest-hex-button",
      };
    }
  }

  const pad = text ? detectMultilineCalcPad(text) : null;
  if (pad) {
    return {
      kind: "calc_pad",
      raw: pad,
      message: "剪贴板有多行算式",
      actionLabel: "稿纸",
      testId: "clipboard-suggest-calc-pad-button",
    };
  }

  // HDROP 未在 existingPath 里确认存在时不提示；无 text 也无建议
  void input.filePath;
  return null;
}

type ClipboardApi = Pick<
  typeof tauriApi,
  "getClipboardText" | "getClipboardFilePath" | "checkPathExists"
>;

/** 读系统剪贴板并解析出一条建议（或 null） */
export async function resolveClipboardSuggestion(
  api: ClipboardApi
): Promise<ClipboardSuggestion | null> {
  let text: string | null = null;
  let filePath: string | null = null;
  try {
    text = await api.getClipboardText();
  } catch {
    text = null;
  }
  try {
    filePath = await api.getClipboardFilePath();
  } catch {
    filePath = null;
  }

  let existingPath: string | null = null;

  const candidates: string[] = [];
  if (text) {
    const line = normalizeClipboardFirstLine(text);
    if (line && looksLikeFilesystemPath(line)) {
      candidates.push(line);
    }
  }
  if (filePath && filePath.trim()) {
    candidates.push(filePath.trim());
  }

  for (const candidate of candidates) {
    try {
      const item = await api.checkPathExists(candidate);
      if (item) {
        existingPath = candidate;
        break;
      }
    } catch {
      // ignore
    }
  }

  return detectClipboardSuggestion({ text, filePath, existingPath });
}
