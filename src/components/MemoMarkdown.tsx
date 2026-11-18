import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ImgHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
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

type SavedScroll = {
  el: HTMLElement;
  top: number;
  left: number;
};

/** 向上查找可纵向滚动的祖先（备忘录预览区 overflow-y-auto） */
function getScrollableAncestors(el: HTMLElement | null): HTMLElement[] {
  const result: HTMLElement[] = [];
  let node: HTMLElement | null = el;
  while (node && node !== document.documentElement) {
    const style = getComputedStyle(node);
    const overflowY = style.overflowY;
    if (
      (overflowY === "auto" ||
        overflowY === "scroll" ||
        overflowY === "overlay") &&
      node.scrollHeight > node.clientHeight
    ) {
      result.push(node);
    }
    node = node.parentElement;
  }
  return result;
}

function captureScrollPositions(from: HTMLElement | null): SavedScroll[] {
  return getScrollableAncestors(from).map((el) => ({
    el,
    top: el.scrollTop,
    left: el.scrollLeft,
  }));
}

function applyScrollPositions(saved: SavedScroll[]) {
  for (const { el, top, left } of saved) {
    if (el.scrollTop !== top) el.scrollTop = top;
    if (el.scrollLeft !== left) el.scrollLeft = left;
  }
}

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

const lightboxBtnClass =
  "flex h-9 w-9 items-center justify-center rounded-full bg-black/45 text-white/90 backdrop-blur-md transition-colors hover:bg-black/65 hover:text-white disabled:opacity-50";

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 6;
const ZOOM_STEP = 1.12;

function clampZoom(n: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n));
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
  const [entered, setEntered] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [smooth, setSmooth] = useState(true);
  const hintTimerRef = useRef<number | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef({ scale: 1, x: 0, y: 0 });
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  transformRef.current = { scale, x: offset.x, y: offset.y };

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      cancelAnimationFrame(id);
      document.body.style.overflow = prevOverflow;
      if (hintTimerRef.current != null) {
        window.clearTimeout(hintTimerRef.current);
      }
    };
  }, []);

  const showHint = useCallback((text: string, ms: number) => {
    setCopyHint(text);
    if (hintTimerRef.current != null) window.clearTimeout(hintTimerRef.current);
    hintTimerRef.current = window.setTimeout(() => setCopyHint(null), ms);
  }, []);

  const handleCopy = useCallback(async () => {
    if (copying) return;
    setCopying(true);
    try {
      await copyPreviewImage(preview.src, preview.displayUrl);
      showHint("已复制到剪贴板", 1600);
    } catch (e) {
      console.error("复制图片失败:", e);
      showHint("复制失败", 2000);
    } finally {
      setCopying(false);
    }
  }, [copying, preview.displayUrl, preview.src, showHint]);

  const resetView = useCallback(() => {
    setSmooth(true);
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  /** 以指针位置为中心缩放（相对舞台中心坐标系） */
  const zoomAt = useCallback((clientX: number, clientY: number, nextScale: number) => {
    const stage = stageRef.current;
    const clamped = clampZoom(nextScale);
    const { scale: prev, x, y } = transformRef.current;
    if (clamped === prev) return;
    setSmooth(false);
    if (!stage) {
      setScale(clamped);
      return;
    }
    const rect = stage.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const ratio = clamped / prev;
    const mx = clientX - cx;
    const my = clientY - cy;
    setScale(clamped);
    setOffset({
      x: mx - (mx - x) * ratio,
      y: my - (my - y) * ratio,
    });
  }, []);

  // 非 passive wheel，才能 preventDefault；缩放到 1 时清偏移
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const { scale: prev } = transformRef.current;
      // 触控板惯性过大时略微加强步进
      const intensity =
        Math.abs(e.deltaY) > 40 ? Math.min(1.35, 1 + Math.abs(e.deltaY) / 400) : 1;
      const step = Math.pow(ZOOM_STEP, intensity);
      const next = e.deltaY < 0 ? prev * step : prev / step;
      zoomAt(e.clientX, e.clientY, next);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.keyCode === 27) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        onClose();
        return;
      }
      if (e.key === "0" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        resetView();
        return;
      }
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        const stage = stageRef.current?.getBoundingClientRect();
        if (stage) {
          zoomAt(
            stage.left + stage.width / 2,
            stage.top + stage.height / 2,
            transformRef.current.scale * ZOOM_STEP
          );
        }
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        const stage = stageRef.current?.getBoundingClientRect();
        if (stage) {
          zoomAt(
            stage.left + stage.width / 2,
            stage.top + stage.height / 2,
            transformRef.current.scale / ZOOM_STEP
          );
        }
        return;
      }
      const isCopy =
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") ||
        (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "c");
      if (isCopy) {
        e.preventDefault();
        e.stopPropagation();
        void handleCopy();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [handleCopy, onClose, resetView, zoomAt]);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    // 仅放大/缩小后允许拖拽，避免 1x 时误拖
    if (Math.abs(scale - 1) < 0.02) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: offset.x,
      originY: offset.y,
    };
    setDragging(true);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setOffset({
      x: drag.originX + (e.clientX - drag.startX),
      y: drag.originY + (e.clientY - drag.startY),
    });
  };

  const endDrag = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  // 挂到 body，避免落在 overflow-y-auto / backdrop-filter 祖先内触发滚动复位
  return createPortal(
    <div
      ref={stageRef}
      className={`fixed inset-0 z-[200] overflow-hidden transition-opacity duration-200 ${
        entered ? "opacity-100" : "opacity-0"
      }`}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      style={{
        background:
          "radial-gradient(ellipse at center, rgba(40,40,44,0.92) 0%, rgba(0,0,0,0.92) 70%)",
      }}
    >
      <div
        className="absolute right-4 top-4 z-10 flex items-center gap-1.5"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => void handleCopy()}
          disabled={copying}
          className={lightboxBtnClass}
          title="复制图片（C）"
          aria-label="复制图片"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            viewBox="0 0 24 24"
            aria-hidden
          >
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onClose}
          className={lightboxBtnClass}
          title="关闭（Esc）"
          aria-label="关闭"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      <div
        className="absolute inset-0 flex items-center justify-center p-8"
        onClick={onClose}
      >
        <div
          className={`relative max-h-[88vh] max-w-[88vw] will-change-transform ${
            dragging
              ? "cursor-grabbing"
              : Math.abs(scale - 1) > 0.02
                ? "cursor-grab"
                : "cursor-zoom-in"
          }`}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${
              entered ? scale : scale * 0.97
            })`,
            transition:
              dragging || !smooth ? "none" : "transform 200ms ease-out",
          }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (scale > 1.05) {
              resetView();
            } else {
              zoomAt(e.clientX, e.clientY, 2);
            }
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {/* 暗底上用多层外发光 + 深投影，才能看出「浮起来」 */}
          <img
            src={preview.displayUrl}
            alt={preview.alt || "图片预览"}
            className="block max-h-[88vh] max-w-[88vw] select-none rounded-lg object-contain"
            style={{
              boxShadow:
                "0 0 0 1px rgba(255,255,255,0.12), 0 2px 8px rgba(0,0,0,0.35), 0 18px 50px rgba(0,0,0,0.55), 0 40px 100px rgba(0,0,0,0.45), 0 0 80px rgba(0,0,0,0.35)",
            }}
            draggable={false}
          />
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-8 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-2">
        {copyHint && (
          <div
            className={`rounded-full px-3.5 py-1.5 text-sm shadow-lg backdrop-blur-md ${
              copyHint.includes("失败")
                ? "bg-red-500/90 text-white"
                : "bg-white/95 text-gray-800"
            }`}
            role="status"
          >
            {copyHint}
          </div>
        )}
        {!copyHint && (
          <div className="rounded-full bg-black/40 px-3 py-1 text-[11px] text-white/55 backdrop-blur-sm">
            {Math.abs(scale - 1) > 0.02
              ? `${Math.round(scale * 100)}% · 拖拽平移 · 双击复位`
              : "滚轮缩放 · 双击放大 · Esc 关闭"}
          </div>
        )}
      </div>
    </div>,
    document.body
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
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onOpenPreview({
            src: src!,
            displayUrl: url,
            alt: alt || "图片",
          });
        }}
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
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenPreview({
          src,
          displayUrl: src,
          alt: alt || "图片",
        });
      }}
    />
  );
}

interface MemoMarkdownProps {
  content: string;
}

/** 备忘录详情：Markdown + 本地相对路径图片；点击图片可大图预览并复制 */
export function MemoMarkdown({ content }: MemoMarkdownProps) {
  const text = content?.trim() ? content : "(无内容)";
  const rootRef = useRef<HTMLDivElement>(null);
  const savedScrollRef = useRef<SavedScroll[]>([]);
  const [preview, setPreview] = useState<PreviewState | null>(null);

  const restoreScroll = useCallback(() => {
    applyScrollPositions(savedScrollRef.current);
  }, []);

  const openPreview = useCallback((next: PreviewState) => {
    // 打开前先记下预览区滚动位置，避免 setState / 挂载遮罩导致 scrollTop 归零
    savedScrollRef.current = captureScrollPositions(rootRef.current);
    setPreview(next);
  }, []);

  const closePreview = useCallback(() => {
    // 关闭前再抓一次当前值（开启期间可能被误改），并以打开时快照为准恢复
    setPreview(null);
  }, []);

  // 打开/关闭后在布局提交前恢复滚动；再补一帧防止后续 paint 冲掉
  useLayoutEffect(() => {
    if (savedScrollRef.current.length === 0) return;
    restoreScroll();
    const id = requestAnimationFrame(() => {
      restoreScroll();
    });
    return () => cancelAnimationFrame(id);
  }, [preview, restoreScroll]);

  // 稳定 components，避免仅因 preview 状态变化就让 ReactMarkdown 重挂载整棵树
  const markdownComponents = useMemo<Components>(
    () => ({
      img: (props) => (
        <MemoLocalImage {...props} onOpenPreview={openPreview} />
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
    }),
    [openPreview]
  );

  return (
    <div
      ref={rootRef}
      className="prose prose-sm max-w-none break-words text-gray-700 prose-p:my-2 prose-img:my-2 prose-headings:text-gray-900"
    >
      <ReactMarkdown components={markdownComponents}>{text}</ReactMarkdown>
      {preview && (
        <MemoImageLightbox preview={preview} onClose={closePreview} />
      )}
    </div>
  );
}
