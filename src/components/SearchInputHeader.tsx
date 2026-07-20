import React, { useMemo, useEffect } from "react";
import { parseSearchFilter } from "../utils/searchFilterUtils";

interface LayoutConfig {
  header: string;
  dragHandleIcon: string;
  searchIcon: string;
  pluginIcon: (isHovering: boolean) => string;
  input: string;
}

interface SearchInputHeaderProps {
  layout: LayoutConfig;
  inputRef: React.RefObject<HTMLInputElement>;
  query: string;
  setQuery: (query: string) => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  handlePaste: (e: React.ClipboardEvent) => void;
  pastedImageDataUrl: string | null;
  isHoveringAiIcon: boolean;
  setIsHoveringAiIcon: (isHovering: boolean) => void;
  onPluginListClick: () => void;
  onStartWindowDragging: () => void;
  contextMenu: any; // Using any for simplicity as it's just checking for null
  setContextMenu: (menu: any) => void;
}

export function SearchInputHeader({
  layout,
  inputRef,
  query,
  setQuery,
  handleKeyDown,
  handlePaste,
  pastedImageDataUrl,
  isHoveringAiIcon,
  setIsHoveringAiIcon,
  onPluginListClick,
  onStartWindowDragging,
  contextMenu,
  setContextMenu,
}: SearchInputHeaderProps) {
  
  // 缓存输入框的 className 和 style，避免每次渲染都创建新对象
  const inputClassName = useMemo(() => {
    return `w-full bg-transparent border-none outline-none p-0 text-lg ${layout.input.split(' ').filter(c => c.includes('placeholder') || c.includes('text-')).join(' ') || 'placeholder-gray-400 text-gray-700'}`;
  }, [layout.input]);
  
  const inputStyle = useMemo(() => ({
    cursor: 'text' as const,
    height: 'auto' as const,
    lineHeight: '1.5',
    minHeight: '1.5em'
  }), []);

  const filterHint = useMemo(() => {
    const parsed = parseSearchFilter(query);
    return parsed.hasFilter ? parsed.prefixLabel : undefined;
  }, [query]);

  // 粘贴长路径时滚到末尾，优先露出文件名
  useEffect(() => {
    const el = inputRef.current;
    if (!el || !query) return;
    const looksLikePath = /[\\/]/.test(query) && query.length > 40;
    if (pastedImageDataUrl || looksLikePath) {
      requestAnimationFrame(() => {
        el.scrollLeft = el.scrollWidth;
      });
    }
  }, [query, pastedImageDataUrl, inputRef]);

  return (
    <div 
      className={`${layout.header} select-none`}
      onMouseDown={async (e) => {
        // 手动触发拖拽，移除 data-tauri-drag-region 避免冲突
        // 排除输入框、应用中心按钮和 footer 区域的按钮
        // 注意：wrapper 区域会 stopPropagation，所以这里主要处理 wrapper 上方的区域
        const target = e.target as HTMLElement;
        const isInput = target.tagName === 'INPUT' || target.closest('input');
        const isAppCenterButton = target.closest('[title="应用中心"]');
        const isFooterButton = target.closest('button') && target.closest('[class*="border-t"]');
        const isButton = target.tagName === 'BUTTON' || target.closest('button');
        if (!isInput && !isAppCenterButton && !isFooterButton && !isButton) {
          // 使用和 wrapper 相同的可靠逻辑：先阻止默认行为和冒泡，再调用拖拽
          e.preventDefault();
          e.stopPropagation();
          onStartWindowDragging();
        }
      }}
    >
      <div className="flex items-center gap-3 select-none h-full">
        {/* 拖拽手柄图标 */}
        <svg
          className={layout.dragHandleIcon}
          fill="currentColor"
          viewBox="0 0 24 24"
          style={{ pointerEvents: 'none' }}
        >
          <circle cx="9" cy="5" r="1.5" />
          <circle cx="15" cy="5" r="1.5" />
          <circle cx="9" cy="12" r="1.5" />
          <circle cx="15" cy="12" r="1.5" />
          <circle cx="9" cy="19" r="1.5" />
          <circle cx="15" cy="19" r="1.5" />
        </svg>
        <svg
          className={layout.searchIcon}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          style={{ pointerEvents: 'none' }}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        {/* 输入框包裹层 - 负责占位和拖拽，缩小 input 的实际点击区域 */}
        <div 
          className="flex-1 flex select-none" 
          style={{ 
            userSelect: 'none', 
            WebkitUserSelect: 'none',
            height: '100%',
            alignItems: 'center',
            gap: '8px'
          }}
          onMouseDown={async (e) => {
            // 如果点击的不是输入框，触发拖拽（这个逻辑是可靠的，从不失效）
            const target = e.target as HTMLElement;
            const isInput = target.tagName === 'INPUT' || target.closest('input');
            const isImage = target.tagName === 'IMG' || target.closest('img');
            if (!isInput && !isImage) {
              // 阻止事件冒泡，避免 header 重复处理
              e.stopPropagation();
              e.preventDefault();
              onStartWindowDragging();
            }
            // 如果是输入框，不阻止冒泡，让输入框自己处理
          }}
        >
          {/* 粘贴图片预览 */}
          {pastedImageDataUrl && (
            <img
              src={pastedImageDataUrl}
              alt="粘贴的图片"
              className="w-8 h-8 object-cover rounded border border-gray-300 flex-shrink-0"
              style={{ imageRendering: 'auto' }}
              onError={(e) => {
                // 如果图片加载失败，隐藏预览
                (e.target as HTMLImageElement).style.display = 'none';
              }}
              onClick={(e) => {
                e.stopPropagation();
              }}
            />
          )}
          {filterHint && (
            <span
              className="flex-shrink-0 text-xs font-medium px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-600 border border-indigo-100"
              title={`过滤器：${filterHint}（前缀 a/f/p/m/e + 空格）`}
            >
              {filterHint}
            </span>
          )}
          <input
            ref={inputRef}
            type="text"
            value={query}
            title={query || undefined}
            onChange={(e) => {
              // 参考搜索插件输入框的简单实现，直接更新状态
              // React 的受控组件本身就能很好地处理输入法组合输入，不需要额外的干预
              setQuery(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="输入应用名称或粘贴文件路径..."
            className={inputClassName}
            style={inputStyle}
            autoFocus
            onFocus={(e) => {
              // Ensure input is focused, but don't select text if user is typing
              e.target.focus();
            }}
            onMouseDown={(e) => {
              // 阻止事件冒泡，防止触发窗口拖拽
              // 输入框内应该只处理输入和文本选择，不应该触发窗口拖拽
              e.stopPropagation();
              // Close context menu when clicking on search input
              if (contextMenu) {
                setContextMenu(null);
              }
            }}
            onClick={(e) => {
              // 点击输入框时，确保焦点正确，阻止事件冒泡避免触发其他操作
              e.stopPropagation();
            }}
          />
        </div>
        {/* 应用中心按钮 */}
        <div
          className="relative flex items-center justify-center"
          onMouseEnter={() => setIsHoveringAiIcon(true)}
          onMouseLeave={() => setIsHoveringAiIcon(false)}
          onClick={(e) => {
            e.stopPropagation();
            onPluginListClick();
          }}
          onMouseDown={(e) => {
            // 阻止拖拽，让按钮可以正常点击
            e.stopPropagation();
          }}
          style={{ cursor: 'pointer', minWidth: '24px', minHeight: '24px' }}
          title="应用中心"
        >
          <svg
            className={layout.pluginIcon(isHoveringAiIcon)}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            {/* 应用中心/插件图标 */}
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
            />
          </svg>
        </div>
      </div>
    </div>
  );
}
