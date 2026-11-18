import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MemoItem } from "../types";
import { formatFullDateTime } from "../utils/dateUtils";
import {
  firstMemoImageRef,
  getMemoContentPreview,
} from "../utils/memoPreviewUtils";
import { MemoImageThumb } from "./MemoImageThumb";

interface MemoListItemProps {
  memo: MemoItem;
  thumbSize?: number;
  /** 点击行 /「编辑」：直接进入编辑 */
  onOpen: () => void;
  /** 「预览」：只读详情（Markdown + 灯箱） */
  onPreview: () => void;
  onInsert: () => void | Promise<void>;
  onCopy: () => void | Promise<void>;
  onCopyAndClose: () => void | Promise<void>;
  /** 复制「请 AI 阅读本篇 .md」提示词 */
  onCopyPrompt: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}

const menuItemClass =
  "block w-full px-3.5 py-2 text-left text-[13px] transition-colors disabled:opacity-50";

type MenuPos = { top: number; left: number };

/** 按触发按钮与菜单尺寸计算 fixed 坐标，必要时向上翻转并夹紧视口 */
function computeMenuPos(
  trigger: DOMRect,
  menuWidth: number,
  menuHeight: number
): MenuPos {
  const gap = 8;
  const pad = 8;
  let top = trigger.bottom + gap;
  if (top + menuHeight > window.innerHeight - pad) {
    top = Math.max(pad, trigger.top - gap - menuHeight);
  }
  let left = trigger.right - menuWidth;
  left = Math.max(pad, Math.min(left, window.innerWidth - menuWidth - pad));
  return { top, left };
}

/** 备忘录列表行：整行点击编辑；悬停显示「预览」「编辑」「⋯」 */
export function MemoListItem({
  memo,
  thumbSize = 56,
  onOpen,
  onPreview,
  onInsert,
  onCopy,
  onCopyAndClose,
  onCopyPrompt,
  onDelete,
}: MemoListItemProps) {
  const thumb = firstMemoImageRef(memo.content);
  const preview = getMemoContentPreview(memo.content);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuPos(null);
      return;
    }
    const btn = menuBtnRef.current;
    const panel = menuPanelRef.current;
    if (!btn || !panel) return;
    setMenuPos(
      computeMenuPos(
        btn.getBoundingClientRect(),
        panel.offsetWidth,
        panel.offsetHeight
      )
    );
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuBtnRef.current?.contains(t)) return;
      if (menuPanelRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    /** 列表滚动 / 窗口缩放后 fixed 坐标会错位，直接关闭 */
    const onScrollOrResize = () => setMenuOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [menuOpen]);

  const closeMenu = () => setMenuOpen(false);

  const menuPanel =
    menuOpen &&
    createPortal(
      <div
        ref={menuPanelRef}
        role="menu"
        data-memo-control
        style={
          menuPos
            ? { top: menuPos.top, left: menuPos.left }
            : { top: 0, left: 0, visibility: "hidden" }
        }
        className="fixed z-[130] min-w-[9rem] overflow-hidden rounded-2xl border border-slate-200/90 bg-white/95 py-1.5 shadow-[0_16px_40px_rgba(15,23,42,0.16)] backdrop-blur-md"
      >
        <button
          type="button"
          role="menuitem"
          data-memo-control
          onClick={(e) => {
            e.stopPropagation();
            closeMenu();
            onPreview();
          }}
          className={`${menuItemClass} text-slate-700 hover:bg-slate-50`}
          title="只读预览"
        >
          预览
        </button>
        <button
          type="button"
          role="menuitem"
          data-memo-control
          onClick={(e) => {
            e.stopPropagation();
            closeMenu();
            onOpen();
          }}
          className={`${menuItemClass} font-medium text-sky-600 hover:bg-sky-50`}
          title="编辑备忘录"
        >
          编辑
        </button>
        <div className="my-1.5 border-t border-slate-100" />
        <button
          type="button"
          role="menuitem"
          data-memo-control
          onClick={(e) => {
            e.stopPropagation();
            closeMenu();
            void onInsert();
          }}
          className={`${menuItemClass} text-slate-700 hover:bg-slate-50`}
          title="插入到系统光标位置"
        >
          插入
        </button>
        <button
          type="button"
          role="menuitem"
          data-memo-control
          onClick={(e) => {
            e.stopPropagation();
            closeMenu();
            void onCopy();
          }}
          className={`${menuItemClass} text-sky-600 hover:bg-sky-50`}
          title="复制标题"
        >
          复制
        </button>
        <button
          type="button"
          role="menuitem"
          data-memo-control
          onClick={(e) => {
            e.stopPropagation();
            closeMenu();
            void onCopyAndClose();
          }}
          className={`${menuItemClass} text-sky-600 hover:bg-sky-50`}
          title="复制标题并关闭"
        >
          复制并关闭
        </button>
        <button
          type="button"
          role="menuitem"
          data-memo-control
          onClick={(e) => {
            e.stopPropagation();
            closeMenu();
            void onCopyPrompt();
          }}
          className={`${menuItemClass} text-slate-700 hover:bg-slate-50`}
          title="复制 AI 阅读本篇笔记的提示词"
        >
          复制提示词
        </button>
        <div className="my-1.5 border-t border-slate-100" />
        <button
          type="button"
          role="menuitem"
          data-memo-control
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            closeMenu();
            void onDelete();
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          className={`${menuItemClass} text-red-600 hover:bg-red-50`}
          title="删除备忘录"
        >
          删除
        </button>
      </div>,
      document.body
    );

  return (
    <div
      role="button"
      tabIndex={0}
      title="点击编辑"
      className="group relative flex cursor-pointer items-start gap-3.5 overflow-hidden rounded-2xl border border-slate-200/80 bg-white/95 px-4 py-3.5 shadow-[0_2px_8px_rgba(15,23,42,0.04),0_1px_0_rgba(255,255,255,0.8)_inset] outline-none transition-[border-color,background-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-sky-300/80 hover:bg-white hover:shadow-[0_12px_28px_rgba(14,165,233,0.12),0_4px_10px_rgba(15,23,42,0.06)] focus-visible:border-sky-400 focus-visible:ring-2 focus-visible:ring-sky-300/50"
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest("[data-memo-control]")) return;
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      {/* 左侧强调条：悬停/焦点时显形 */}
      <span
        aria-hidden
        className="absolute inset-y-3 left-0 w-[3px] rounded-full bg-sky-400/0 transition-all duration-200 group-hover:bg-sky-500 group-focus-visible:bg-sky-500"
      />

      <div className="min-w-0 flex-1 pl-1 pr-1">
        <div className="truncate text-[16px] font-bold leading-snug tracking-tight text-slate-900">
          {memo.title || "(无标题)"}
        </div>
        <div className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-slate-500">
          {preview || "（无内容）"}
        </div>
        <div className="mt-2.5 inline-flex items-center rounded-full bg-slate-100/90 px-2 py-0.5 text-[11px] font-medium leading-none text-slate-500 tabular-nums ring-1 ring-slate-200/60">
          更新于 {formatFullDateTime(memo.updated_at)}
        </div>
      </div>

      {thumb && (
        <MemoImageThumb
          src={thumb}
          size={thumbSize}
          className="mt-0.5 shrink-0 pointer-events-none transition-transform duration-200 group-hover:scale-[1.03]"
        />
      )}

      {/* 右侧操作：不遮挡正文；悬停/焦点/菜单打开时显示 */}
      <div
        data-memo-control
        className={`ml-0.5 flex shrink-0 items-center gap-1.5 self-center transition-opacity duration-150 ${
          menuOpen
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          data-memo-control
          onClick={(e) => {
            e.stopPropagation();
            closeMenu();
            onPreview();
          }}
          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
          title="只读预览"
        >
          预览
        </button>
        <button
          type="button"
          data-memo-control
          onClick={(e) => {
            e.stopPropagation();
            closeMenu();
            onOpen();
          }}
          className="rounded-lg border border-sky-500 bg-sky-500 px-2.5 py-1 text-[12px] font-semibold text-white shadow-[0_2px_8px_rgba(14,165,233,0.35)] transition-colors hover:border-sky-600 hover:bg-sky-600"
          title="编辑备忘录"
        >
          编辑
        </button>

        <div className="relative">
          <button
            ref={menuBtnRef}
            type="button"
            data-memo-control
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className={`flex h-7 w-7 items-center justify-center rounded-lg border text-[14px] leading-none transition-colors ${
              menuOpen
                ? "border-slate-300 bg-slate-100 text-slate-800"
                : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
            }`}
            title="更多操作"
          >
            ⋯
          </button>
        </div>
      </div>

      {menuPanel}
    </div>
  );
}
