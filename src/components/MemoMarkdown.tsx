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

/** 灯箱玻璃按钮：高对比玻璃控件 */
const lightboxBtnClass =
  "flex h-10 w-10 items-center justify-center rounded-full text-white transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-white/20 hover:text-white hover:scale-105 disabled:opacity-45";

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

  const zoomed = Math.abs(scale - 1) > 0.02;

  // 挂到 body，避免落在 overflow-y-auto / backdrop-filter 祖先内触发滚动复位
  return createPortal(
    <div
      ref={stageRef}
      className={`fixed inset-0 z-[200] overflow-hidden transition-[opacity,backdrop-filter] duration-300 ease-out ${
        entered ? "opacity-100" : "opacity-0"
      }`}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      style={{
        background:
          "radial-gradient(ellipse 70% 55% at 50% 40%, rgba(28,36,52,0.72) 0%, rgba(6,8,14,0.92) 48%, rgba(0,0,0,0.98) 100%)",
      }}
    >
      {/* 电影感 vignette + 冷色氛围 */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden
        style={{
          background:
            "radial-gradient(ellipse 55% 45% at 50% 36%, rgba(56,189,248,0.14) 0%, transparent 65%), radial-gradient(ellipse 100% 100% at 50% 50%, transparent 42%, rgba(0,0,0,0.55) 100%)",
        }}
      />

      {/* 右上角玻璃控制条 */}
      <div
        className="absolute right-5 top-5 z-10 flex items-center gap-1 rounded-full border border-white/20 bg-black/45 p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.55),0_0_0_1px_rgba(255,255,255,0.06)_inset] backdrop-blur-2xl"
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
        <span className="mx-0.5 h-4 w-px bg-white/15" aria-hidden />
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
        className="absolute inset-0 flex items-center justify-center p-8 sm:p-10"
        onClick={onClose}
      >
        <div
          className={`relative max-h-[88vh] max-w-[88vw] will-change-transform ${
            dragging
              ? "cursor-grabbing"
              : zoomed
                ? "cursor-grab"
                : "cursor-zoom-in"
          }`}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${
              entered ? scale : scale * 0.94
            })`,
            opacity: entered ? 1 : 0.85,
            transition:
              dragging || !smooth
                ? "none"
                : "transform 280ms cubic-bezier(0.22, 1, 0.36, 1), opacity 280ms ease-out",
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
          {/* 图片背后光晕：电影感悬浮 */}
          <div
            className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[85%] w-[85%] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[48px]"
            aria-hidden
            style={{
              background:
                "radial-gradient(circle, rgba(255,255,255,0.22) 0%, rgba(56,189,248,0.16) 35%, rgba(14,165,233,0.06) 55%, transparent 72%)",
            }}
          />
          <img
            src={preview.displayUrl}
            alt={preview.alt || "图片预览"}
            className="block max-h-[88vh] max-w-[88vw] select-none rounded-2xl object-contain"
            style={{
              boxShadow:
                "0 0 0 1px rgba(255,255,255,0.22), 0 0 40px rgba(56,189,248,0.12), 0 2px 4px rgba(0,0,0,0.25), 0 12px 32px rgba(0,0,0,0.45), 0 36px 80px rgba(0,0,0,0.6), 0 64px 140px rgba(0,0,0,0.45)",
            }}
            draggable={false}
          />
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-8 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-3">
        {copyHint && (
          <div
            className={`rounded-full border px-5 py-2 text-sm font-semibold shadow-[0_12px_36px_rgba(0,0,0,0.45)] backdrop-blur-xl ${
              copyHint.includes("失败")
                ? "border-red-400/40 bg-red-500/95 text-white"
                : "border-white/50 bg-white text-slate-900"
            }`}
            role="status"
          >
            {copyHint}
          </div>
        )}
        {!copyHint && (
          <div className="flex items-center gap-2.5 rounded-full border border-white/18 bg-black/55 px-4 py-2 text-[12px] font-medium tracking-wide text-white/70 shadow-[0_8px_28px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.06)_inset] backdrop-blur-xl">
            {zoomed ? (
              <>
                <span className="tabular-nums text-sky-300">
                  {Math.round(scale * 100)}%
                </span>
                <span className="h-3 w-px bg-white/25" aria-hidden />
                <span>拖拽平移</span>
                <span className="text-white/25">·</span>
                <span>双击复位</span>
              </>
            ) : (
              <>
                <span>滚轮缩放</span>
                <span className="text-white/25">·</span>
                <span>双击放大</span>
                <span className="text-white/25">·</span>
                <span>Esc 关闭</span>
              </>
            )}
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
        className="my-3 max-w-full cursor-zoom-in rounded-2xl border border-slate-200/80 shadow-[0_6px_20px_rgba(15,23,42,0.1)] transition-[box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-[0_14px_32px_rgba(14,165,233,0.14),0_6px_16px_rgba(15,23,42,0.08)]"
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
      className="my-3 max-w-full cursor-zoom-in rounded-2xl border border-slate-200/80 shadow-[0_6px_20px_rgba(15,23,42,0.1)] transition-[box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-[0_14px_32px_rgba(14,165,233,0.14),0_6px_16px_rgba(15,23,42,0.08)]"
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
      className="prose prose-sm max-w-none break-words text-[15px] leading-[1.8] text-slate-700 prose-p:my-3 prose-img:my-4 prose-headings:font-bold prose-headings:tracking-tight prose-headings:text-slate-900 prose-a:text-sky-600 prose-li:my-1"
    >
      <ReactMarkdown components={markdownComponents}>{text}</ReactMarkdown>
      {preview && (
        <MemoImageLightbox preview={preview} onClose={closePreview} />
      )}
    </div>
  );
}
