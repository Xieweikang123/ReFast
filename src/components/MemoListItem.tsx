import { useEffect, useRef, useState } from "react";
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
  "block w-full px-3 py-1.5 text-left text-[12px] transition-colors disabled:opacity-50";

/** 备忘录列表行：整行点击编辑；悬停显示「预览」「编辑」「⋯」 */
export function MemoListItem({
  memo,
  thumbSize = 48,
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
  const menuWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = menuWrapRef.current;
      if (el && !el.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <div
      role="button"
      tabIndex={0}
      title="点击编辑"
      className="group relative flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200/90 bg-white px-3.5 py-2.5 shadow-sm outline-none transition-[border-color,background-color,box-shadow] duration-150 hover:border-blue-200 hover:bg-blue-50/40 focus-visible:border-blue-300 focus-visible:bg-blue-50/40 focus-visible:ring-2 focus-visible:ring-blue-200/60"
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
      <div className="min-w-0 flex-1 pr-1">
        <div className="truncate text-[15px] font-semibold leading-snug tracking-tight text-gray-900">
          {memo.title || "(无标题)"}
        </div>
        <div className="mt-0.5 truncate text-[13px] leading-snug text-gray-500">
          {preview || "（无内容）"}
        </div>
        <div className="mt-1 text-[11px] leading-none text-gray-400 tabular-nums">
          更新于 {formatFullDateTime(memo.updated_at)}
        </div>
      </div>

      {thumb && (
        <MemoImageThumb
          src={thumb}
          size={thumbSize}
          className="mt-0.5 shrink-0 pointer-events-none"
        />
      )}

      {/* 右侧操作：不遮挡正文；悬停/焦点/菜单打开时显示 */}
      <div
        data-memo-control
        className={`ml-0.5 flex shrink-0 items-center gap-1 self-center transition-opacity duration-150 ${
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
            setMenuOpen(false);
            onPreview();
          }}
          className="rounded-md border border-gray-200 bg-white px-2 py-0.5 text-[11px] font-medium text-gray-700 shadow-sm transition-colors hover:border-gray-300 hover:bg-gray-50"
          title="只读预览"
        >
          预览
        </button>
        <button
          type="button"
          data-memo-control
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen(false);
            onOpen();
          }}
          className="rounded-md border border-blue-500 bg-blue-500 px-2 py-0.5 text-[11px] font-medium text-white shadow-sm transition-colors hover:border-blue-600 hover:bg-blue-600"
          title="编辑备忘录"
        >
          编辑
        </button>

        <div className="relative" ref={menuWrapRef}>
          <button
            type="button"
            data-memo-control
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className={`flex h-6 w-6 items-center justify-center rounded-md border text-[13px] leading-none transition-colors ${
              menuOpen
                ? "border-gray-300 bg-gray-100 text-gray-800"
                : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50"
            }`}
            title="更多操作"
          >
            ⋯
          </button>

          {menuOpen && (
            <div
              role="menu"
              data-memo-control
              className="absolute right-0 top-full z-20 mt-1 min-w-[7.5rem] overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                data-memo-control
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onPreview();
                }}
                className={`${menuItemClass} text-gray-700 hover:bg-gray-50`}
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
                  setMenuOpen(false);
                  onOpen();
                }}
                className={`${menuItemClass} text-blue-600 hover:bg-blue-50`}
                title="编辑备忘录"
              >
                编辑
              </button>
              <div className="my-1 border-t border-gray-100" />
              <button
                type="button"
                role="menuitem"
                data-memo-control
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  void onInsert();
                }}
                className={`${menuItemClass} text-gray-700 hover:bg-gray-50`}
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
                  setMenuOpen(false);
                  void onCopy();
                }}
                className={`${menuItemClass} text-blue-600 hover:bg-blue-50`}
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
                  setMenuOpen(false);
                  void onCopyAndClose();
                }}
                className={`${menuItemClass} text-blue-600 hover:bg-blue-50`}
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
                  setMenuOpen(false);
                  void onCopyPrompt();
                }}
                className={`${menuItemClass} text-gray-700 hover:bg-gray-50`}
                title="复制 AI 阅读本篇笔记的提示词"
              >
                复制提示词
              </button>
              <div className="my-1 border-t border-gray-100" />
              <button
                type="button"
                role="menuitem"
                data-memo-control
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenuOpen(false);
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
