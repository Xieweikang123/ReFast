import { tauriApi } from "../api/tauri";
import type { FileOpenHandler, FileOpenRules } from "../types";

/** 支持配置左键打开方式的扩展名 */
export const CONFIGURABLE_FILE_EXTENSIONS = ["md", "markdown"] as const;

export type ConfigurableFileExtension = (typeof CONFIGURABLE_FILE_EXTENSIONS)[number];

export function getFileExtension(path: string): string | null {
  const name = path.split(/[/\\]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

export function isConfigurableFileExtension(
  ext: string | null
): ext is ConfigurableFileExtension {
  if (!ext) return false;
  return (CONFIGURABLE_FILE_EXTENSIONS as readonly string[]).includes(ext);
}

export function resolveFileOpenHandler(
  path: string,
  rules: FileOpenRules
): FileOpenHandler {
  const ext = getFileExtension(path);
  if (!ext) return "default";
  const handler = rules[ext];
  if (handler === "markdown_editor") return "markdown_editor";
  return "default";
}

export function getFileOpenHandlerLabel(handler: FileOpenHandler): string {
  switch (handler) {
    case "markdown_editor":
      return "Markdown 编辑器打开";
    default:
      return "系统默认打开";
  }
}

export function getFileOpenRuleOptions(
  ext: ConfigurableFileExtension
): Array<{ handler: FileOpenHandler; label: string }> {
  if (ext === "md" || ext === "markdown") {
    return [
      { handler: "default", label: "系统默认打开" },
      { handler: "markdown_editor", label: "Markdown 编辑器打开" },
    ];
  }
  return [{ handler: "default", label: "系统默认打开" }];
}

/** 同步关联扩展名（如 md 与 markdown）的打开方式 */
export function syncRelatedFileOpenRules(
  rules: FileOpenRules,
  ext: string,
  handler: FileOpenHandler
): FileOpenRules {
  const next = { ...rules, [ext]: handler };
  if (ext === "md" || ext === "markdown") {
    next.md = handler;
    next.markdown = handler;
  }
  return next;
}

export async function openFileWithHandler(
  path: string,
  handler: FileOpenHandler,
  api: typeof tauriApi = tauriApi
): Promise<void> {
  if (handler === "markdown_editor") {
    await api.showMarkdownEditorWindow(path);
    const { emit } = await import("@tauri-apps/api/event");
    await emit("markdown-editor:open-file", { path });
    return;
  }
  await api.launchFile(path);
}
