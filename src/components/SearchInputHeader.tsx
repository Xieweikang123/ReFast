import React, { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { parseSearchFilter } from "../utils/searchFilterUtils";
import { getSearchEngineIntent } from "../utils/searchHintUtils";
import type { SearchEngineConfig } from "../types";

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
  searchEngines?: SearchEngineConfig[];
}

export const SearchInputHeader = React.memo(function SearchInputHeader({
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
  searchEngines = [],
}: SearchInputHeaderProps) {
  const [localQuery, setLocalQuery] = useState(query);
  const lastEmittedRef = useRef(query);
  const isComposingRef = useRef(false);

  useEffect(() => {
    if (query !== lastEmittedRef.current) {
      setLocalQuery(query);
      lastEmittedRef.current = query;
    }
  }, [query]);

  const emitQuery = (value: string) => {
    lastEmittedRef.current = value;
    startTransition(() => {
      setQuery(value);
    });
  };
  
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
    const parsed = parseSearchFilter(localQuery);
    return parsed.hasFilter ? parsed.prefixLabel : undefined;
  }, [localQuery]);

  const searchEngineHint = useMemo(() => {
    if (filterHint) return undefined;
    return getSearchEngineIntent(localQuery, searchEngines)?.engine.name;
  }, [filterHint, localQuery, searchEngines]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el || !localQuery) return;
    const looksLikePath = /[\\/]/.test(localQuery) && localQuery.length > 40;
    if (pastedImageDataUrl || looksLikePath) {
      requestAnimationFrame(() => {
        el.scrollLeft = el.scrollWidth;
      });
    }
  }, [localQuery, pastedImageDataUrl, inputRef]);

  return (
    <div 
      className={`${layout.header} select-none`}
      onMouseDown={async (e) => {
        const target = e.target as HTMLElement;
        const isInput = target.tagName === 'INPUT' || target.closest('input');
        const isAppCenterButton = target.closest('[title="应用中心"]');
        const isFooterButton = target.closest('button') && target.closest('[class*="border-t"]');
        const isButton = target.tagName === 'BUTTON' || target.closest('button');
        if (!isInput && !isAppCenterButton && !isFooterButton && !isButton) {
          e.preventDefault();
          e.stopPropagation();
          onStartWindowDragging();
        }
      }}
    >
      <div className="flex items-center gap-3 select-none h-full">
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
            const target = e.target as HTMLElement;
            const isInput = target.tagName === 'INPUT' || target.closest('input');
            const isImage = target.tagName === 'IMG' || target.closest('img');
            if (!isInput && !isImage) {
              e.stopPropagation();
              e.preventDefault();
              onStartWindowDragging();
            }
          }}
        >
          {pastedImageDataUrl && (
            <img
              src={pastedImageDataUrl}
              alt="粘贴的图片"
              className="w-8 h-8 object-cover rounded border border-gray-300 flex-shrink-0"
              style={{ imageRendering: 'auto' }}
              onError={(e) => {
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
          {!filterHint && searchEngineHint && (
            <span
              className="flex-shrink-0 text-xs font-medium px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-600 border border-indigo-100"
              title={`网页搜索：${searchEngineHint}（此前缀默认只搜网页）`}
            >
              {searchEngineHint}
            </span>
          )}
          <input
            ref={inputRef}
            type="text"
            value={localQuery}
            title={localQuery || undefined}
            onChange={(e) => {
              const value = e.target.value;
              const nativeEvent = e.nativeEvent as { isComposing?: boolean };
              const composing = isComposingRef.current || !!nativeEvent.isComposing;
              setLocalQuery(value);
              if (composing) {
                return;
              }
              emitQuery(value);
            }}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              isComposingRef.current = false;
              const value = e.currentTarget.value;
              setLocalQuery(value);
              emitQuery(value);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="输入应用名称或粘贴文件路径..."
            className={inputClassName}
            style={inputStyle}
            autoFocus
            onFocus={(e) => {
              e.target.focus();
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
              if (contextMenu) {
                setContextMenu(null);
              }
            }}
            onClick={(e) => {
              e.stopPropagation();
            }}
          />
        </div>
        <div
          className="relative flex items-center justify-center"
          onMouseEnter={() => setIsHoveringAiIcon(true)}
          onMouseLeave={() => setIsHoveringAiIcon(false)}
          onClick={(e) => {
            e.stopPropagation();
            onPluginListClick();
          }}
          onMouseDown={(e) => {
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
});
