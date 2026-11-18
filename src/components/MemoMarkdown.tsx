import { useCallback, useEffect, useState, type ImgHTMLAttributes } from "react";
import ReactMarkdown from "react-markdown";
import { tauriApi } from "../api/tauri";
import { useMemoImageUrl } from "../hooks/useMemoImageUrl";
import { isMemoLocalImageSrc } from "../utils/memoImageUtils";

type PreviewState = {
  /** 原始 markdown src：本地相对/绝对路径，或远程 URL */
  src: string;
  /** 实际用于展示的 URL（blob: 或 http(s)） */
  displayUrl: string;
  alt: string;
};

async function blobToPngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("PNG 转换失败"))),
      "image/png"
    );
  });
}

/** 复制单张图片到系统剪贴板：本地优先走后端，失败或远程则用浏览器 API */
async function copyPreviewImage(src: string, displayUrl: string): Promise<void> {
  if (isMemoLocalImageSrc(src)) {
    try {
      await tauriApi.copyImageToClipboard(src);
      return;
    } catch (e) {
      console.warn("后端复制图片失败，尝试浏览器剪贴板:", e);
    }
  }

  const resp = await fetch(displayUrl);
  if (!resp.ok) throw new Error("读取图片失败");
  const blob = await resp.blob();
  const pngBlob = await blobToPngBlob(blob);
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": pngBlob }),
  ]);
}

function MemoImageLightbox({
  preview,
  onClose,
}: {
  preview: PreviewState;
  onClose: () => void;
}) {
  const [copying, setCopying] = useState(false);
  const [copyHint, setCopyHint] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.keyCode === 27) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    // window capture 早于 document，避免详情页 Esc 抢先返回列表
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const handleCopy = async () => {
    if (copying) return;
    setCopying(true);
    setCopyHint(null);
    try {
      await copyPreviewImage(preview.src, preview.displayUrl);
      setCopyHint("已复制");
      window.setTimeout(() => setCopyHint(null), 1500);
    } catch (e) {
      console.error("复制图片失败:", e);
      setCopyHint("复制失败");
      window.setTimeout(() => setCopyHint(null), 2000);
    } finally {
      setCopying(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
    >
      <div
        className="relative flex max-h-[90vh] max-w-[90vw] flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex w-full items-center justify-between gap-3 rounded-full border border-white/15 bg-white/95 px-2 py-1.5 shadow-lg shadow-black/20 backdrop-blur">
          <div className="flex items-center gap-2 pl-2">
            <span className="text-xs font-medium text-gray-600">图片预览</span>
            {copyHint === "复制失败" && (
              <span className="text-xs text-red-500">复制失败</span>
            )}
            {copyHint === "已复制" && (
              <span className="text-xs text-blue-600">已复制</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleCopy}
              disabled={copying}
              className="rounded-full px-3 py-1.5 text-sm text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-60"
            >
              {copying ? "复制中…" : "复制图片"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full px-3 py-1.5 text-sm text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
              title="关闭预览（Esc）"
            >
              关闭
            </button>
          </div>
        </div>
        <img
          src={preview.displayUrl}
          alt={preview.alt || "图片预览"}
          className="max-h-[calc(90vh-4.5rem)] max-w-[90vw] rounded-xl object-contain shadow-2xl shadow-black/40 ring-1 ring-white/10"
        />
      </div>
    </div>
  );
}

function MemoLocalImage({
  onOpenPreview,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & {
  onOpenPreview: (preview: PreviewState) => void;
}) {
  const { src, alt, ...rest } = props;
  const local = !!(src && isMemoLocalImageSrc(src));
  const { url, loading } = useMemoImageUrl(local ? src : null);

  if (local) {
    if (loading || !url) {
      return (
        <span className="my-2 inline-block rounded-md bg-gray-50 px-2 py-1 text-xs text-gray-400">
          {loading ? "图片加载中…" : "图片"}
        </span>
      );
    }
    return (
      <img
        {...rest}
        src={url}
        alt={alt || "图片"}
        className="my-2 max-w-full cursor-zoom-in rounded-lg border border-gray-200/80 shadow-sm transition-shadow hover:shadow-md"
        onClick={() =>
          onOpenPreview({
            src: src!,
            displayUrl: url,
            alt: alt || "图片",
          })
        }
      />
    );
  }

  if (!src) return null;
  return (
    <img
      {...rest}
      src={src}
      alt={alt || ""}
      className="my-2 max-w-full cursor-zoom-in rounded-lg border border-gray-200/80 shadow-sm transition-shadow hover:shadow-md"
      onClick={() =>
        onOpenPreview({
          src,
          displayUrl: src,
          alt: alt || "图片",
        })
      }
    />
  );
}

interface MemoMarkdownProps {
  content: string;
}

/** 备忘录详情：Markdown + 本地相对路径图片；点击图片可大图预览并复制 */
export function MemoMarkdown({ content }: MemoMarkdownProps) {
  const text = content?.trim() ? content : "(无内容)";
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const closePreview = useCallback(() => setPreview(null), []);

  return (
    <div className="prose prose-sm max-w-none break-words text-gray-700 prose-p:my-2 prose-img:my-2 prose-headings:text-gray-900">
      <ReactMarkdown
        components={{
          img: (props) => (
            <MemoLocalImage {...props} onOpenPreview={setPreview} />
          ),
          p: ({ children }) => (
            <p className="mb-2 whitespace-pre-wrap leading-relaxed">{children}</p>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              className="text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-700"
              target="_blank"
              rel="noreferrer"
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
      {preview && (
        <MemoImageLightbox preview={preview} onClose={closePreview} />
      )}
    </div>
  );
}
