import {
  useCallback,
  useEffect,
  useRef,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import { tauriApi } from "../api/tauri";
import {
  findUnsavedMemoImages,
  persistUnsavedImagesInEditor,
  rewriteHtmlImagesForMemo,
  saveMemoImageFile,
} from "../utils/memoImageUtils";
import {
  editorRootToMarkdown,
  extractImageSrcsFromHtml,
  insertHtmlAtSelection,
  markdownToEditorHtml,
} from "../utils/memoWysiwygUtils";

interface MemoContentEditorProps {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  autoFocus?: boolean;
  /** 填满父级剩余高度（大窗/全屏编辑布局） */
  fillHeight?: boolean;
  className?: string;
}

async function loadImageBlobs(root: HTMLElement) {
  const imgs = root.querySelectorAll<HTMLImageElement>("img[data-memo-src]");
  await Promise.all(
    Array.from(imgs).map(async (img) => {
      const src = img.getAttribute("data-memo-src");
      if (!src || (img.getAttribute("src") || "").startsWith("blob:")) return;
      try {
        const data = await tauriApi.getMemoImageData(src);
        const bytes =
          data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const blob = new Blob([copy], { type: "image/png" });
        const url = URL.createObjectURL(blob);
        const prev = img.dataset.blobUrl;
        if (prev) URL.revokeObjectURL(prev);
        img.dataset.blobUrl = url;
        img.src = url;
      } catch (e) {
        console.error("加载编辑区图片失败:", e);
      }
    })
  );
}

function revokeBlobUrls(root: HTMLElement) {
  root.querySelectorAll<HTMLImageElement>("img[data-memo-src]").forEach((img) => {
    const url = img.dataset.blobUrl;
    if (url) URL.revokeObjectURL(url);
  });
}

/** 同步读取剪贴板中的图片 File（须在 await 前调用，以便及时 preventDefault） */
function imageFilesFromClipboard(e: ClipboardEvent): File[] {
  const items = e.clipboardData?.items;
  if (!items) return [];
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

function escapeForInsert(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 所见即所得备忘录编辑：文字与图片内联显示，对外仍输出 Markdown */
export function MemoContentEditor({
  value,
  onChange,
  rows = 12,
  placeholder = "输入文字，可直接粘贴或拖入图片",
  autoFocus = false,
  fillHeight = false,
  className = "",
}: MemoContentEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef(value);
  const composing = useRef(false);
  const mounted = useRef(false);
  /** 正在落盘外链图片时忽略 input，避免重复触发 */
  const persisting = useRef(false);

  const emitMarkdown = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const md = editorRootToMarkdown(el);
    lastEmitted.current = md;
    onChange(md);
  }, [onChange]);

  /** 先尽量把未落盘图片写入 images/，再序列化；失败会留下可见占位 */
  const emitMarkdownAfterPersist = useCallback(async () => {
    const el = ref.current;
    if (!el || persisting.current) return;
    persisting.current = true;
    try {
      const failed = await persistUnsavedImagesInEditor(el);
      emitMarkdown();
      if (failed > 0) {
        alert(`有 ${failed} 张图片保存失败，已标记为[未保存的图片]`);
      }
    } catch (err) {
      console.error("保存编辑区图片失败:", err);
      alert(`保存图片失败: ${err}`);
      emitMarkdown();
    } finally {
      persisting.current = false;
    }
  }, [emitMarkdown]);

  const resetFromMarkdown = useCallback(async (md: string) => {
    const el = ref.current;
    if (!el) return;
    revokeBlobUrls(el);
    el.innerHTML = markdownToEditorHtml(md);
    await loadImageBlobs(el);
    lastEmitted.current = md;
  }, []);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      void resetFromMarkdown(value);
      return;
    }
    if (value !== lastEmitted.current) {
      void resetFromMarkdown(value);
    }
  }, [value, resetFromMarkdown]);

  useEffect(() => {
    return () => {
      if (ref.current) revokeBlobUrls(ref.current);
    };
  }, []);

  useEffect(() => {
    if (autoFocus) {
      const t = window.setTimeout(() => ref.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
  }, [autoFocus]);

  const insertImageFiles = async (files: File[]) => {
    const el = ref.current;
    if (!el || files.length === 0) return;
    el.focus();
    try {
      for (const file of files) {
        const rel = await saveMemoImageFile(file);
        const data = await file.arrayBuffer();
        const copy = new Uint8Array(data.byteLength);
        copy.set(new Uint8Array(data));
        const blob = new Blob([copy], { type: file.type || "image/png" });
        const url = URL.createObjectURL(blob);
        const html = `<div><img data-memo-src="${rel}" data-blob-url="${url}" src="${url}" alt="图片" class="memo-wysiwyg-img" /></div><div><br></div>`;
        insertHtmlAtSelection(html, el);
      }
      emitMarkdown();
    } catch (err) {
      console.error("插入图片失败:", err);
      alert(`插入图片失败: ${err}`);
    }
  };

  const onInput = (_e: FormEvent<HTMLDivElement>) => {
    if (composing.current || persisting.current) return;
    const el = ref.current;
    // 兜底：浏览器默认粘贴带入的外链图，在序列化前尽量落盘
    if (el && findUnsavedMemoImages(el).length > 0) {
      void emitMarkdownAfterPersist();
      return;
    }
    emitMarkdown();
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    // 必须在任何 await 之前同步判断并 preventDefault，否则浏览器会先把外链 img 写进编辑器
    const files = imageFilesFromClipboard(e);
    const html = e.clipboardData?.getData("text/html") ?? "";
    const htmlHasImages = extractImageSrcsFromHtml(html).length > 0;

    if (files.length > 0) {
      e.preventDefault();
      void insertImageFiles(files);
      return;
    }

    if (htmlHasImages) {
      e.preventDefault();
      void (async () => {
        const el = ref.current;
        if (!el) return;
        el.focus();
        try {
          const { html: prepared, failedCount } = await rewriteHtmlImagesForMemo(html);
          insertHtmlAtSelection(prepared, el);
          emitMarkdown();
          if (failedCount > 0) {
            alert(`有 ${failedCount} 张图片保存失败，已标记为[未保存的图片]`);
          }
        } catch (err) {
          console.error("粘贴图片失败:", err);
          alert(`粘贴图片失败: ${err}`);
        }
      })();
      return;
    }

    const text = e.clipboardData?.getData("text/plain");
    if (text != null && text !== "") {
      e.preventDefault();
      const el = ref.current;
      if (!el) return;
      insertHtmlAtSelection(
        text
          .split(/\r?\n/)
          .map((line) => `<div>${line ? escapeForInsert(line) : "<br>"}</div>`)
          .join(""),
        el
      );
      emitMarkdown();
    }
  };

  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    const files = Array.from(e.dataTransfer?.files || []).filter((f) =>
      f.type.startsWith("image/")
    );
    if (files.length === 0) return;
    e.preventDefault();
    await insertImageFiles(files);
  };

  const minHeightRem = Math.max(rows, 8) * 1.5;
  const showPlaceholder = !value.trim();

  return (
    <div
      className={`relative ${
        fillHeight ? "flex h-full min-h-0 flex-1 flex-col" : ""
      } ${className}`.trim()}
    >
      {showPlaceholder && (
        <div className="pointer-events-none absolute left-3.5 top-2.5 z-0 text-sm text-gray-400">
          {placeholder}
        </div>
      )}
      <div
        ref={ref}
        role="textbox"
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        onInput={onInput}
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer?.types || []).includes("Files")) {
            e.preventDefault();
          }
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          emitMarkdown();
        }}
        className={`memo-wysiwyg relative z-10 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-gray-800 shadow-sm transition-shadow focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 ${
          fillHeight ? "h-full min-h-0 flex-1" : ""
        }`}
        style={fillHeight ? undefined : { minHeight: `${minHeightRem}rem` }}
      />
      <style>{`
        .memo-wysiwyg .memo-wysiwyg-img {
          display: block;
          max-width: 100%;
          max-height: 360px;
          height: auto;
          margin: 10px 0;
          border-radius: 8px;
          border: 1px solid #e5e7eb;
          background: #fff;
          box-shadow: 0 1px 2px rgba(0,0,0,0.04);
        }
        .memo-wysiwyg div { min-height: 1.35em; line-height: 1.55; }
      `}</style>
    </div>
  );
}
