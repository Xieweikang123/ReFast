import { useEffect } from "react";
import type { ResultStyle } from "../utils/themeConfig";

export function useScrollbarStyle(resultStyle: ResultStyle) {
  useEffect(() => {
    const styleId = 'custom-scrollbar-style';
    const config = (() => {
      if (resultStyle === "soft") {
        return {
          scrollbarSize: 12,
          trackBg: "linear-gradient(to bottom, rgba(245, 247, 250, 0.8), rgba(250, 251, 253, 0.9))",
          trackBorder: "rgba(226, 232, 240, 0.9)",
          thumbBg: "linear-gradient(to bottom, rgba(148, 163, 184, 0.7), rgba(100, 116, 139, 0.8))",
          thumbHover: "linear-gradient(to bottom, rgba(100, 116, 139, 0.9), rgba(71, 85, 105, 0.95))",
          thumbActive: "linear-gradient(to bottom, rgba(71, 85, 105, 0.95), rgba(51, 65, 85, 1))",
          thumbBorder: 2.5,
          thumbBorderBg: "rgba(255, 255, 255, 0.95)",
          thumbHoverBorder: "rgba(255, 255, 255, 1)",
          thumbActiveBorder: "rgba(255, 255, 255, 1)",
          minHeight: 40,
          thumbShadow: "0 2px 8px rgba(0, 0, 0, 0.1)",
          thumbHoverShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
        };
      }
      if (resultStyle === "skeuomorphic") {
        return {
          scrollbarSize: 12,
          trackBg: "linear-gradient(to bottom, rgba(246, 248, 251, 0.8), rgba(249, 251, 254, 0.95))",
          trackBorder: "rgba(227, 233, 241, 0.95)",
          thumbBg: "linear-gradient(to bottom, rgba(197, 208, 222, 0.75), rgba(178, 193, 214, 0.85))",
          thumbHover: "linear-gradient(to bottom, rgba(178, 193, 214, 0.9), rgba(159, 176, 201, 0.98))",
          thumbActive: "linear-gradient(to bottom, rgba(159, 176, 201, 0.98), rgba(139, 158, 186, 1))",
          thumbBorder: 2.5,
          thumbBorderBg: "rgba(249, 251, 254, 0.98)",
          thumbHoverBorder: "rgba(238, 243, 250, 1)",
          thumbActiveBorder: "rgba(227, 233, 243, 1)",
          minHeight: 40,
          thumbShadow: "0 2px 8px rgba(0, 0, 0, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.6)",
          thumbHoverShadow: "0 4px 12px rgba(0, 0, 0, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.7)",
        };
      }
      return {
        scrollbarSize: 12,
        trackBg: "linear-gradient(to bottom, rgba(248, 250, 252, 0.8), rgba(251, 252, 254, 0.9))",
        trackBorder: "rgba(226, 232, 240, 0.9)",
        thumbBg: "linear-gradient(to bottom, rgba(148, 163, 184, 0.7), rgba(100, 116, 139, 0.8))",
        thumbHover: "linear-gradient(to bottom, rgba(100, 116, 139, 0.9), rgba(71, 85, 105, 0.95))",
        thumbActive: "linear-gradient(to bottom, rgba(71, 85, 105, 0.95), rgba(51, 65, 85, 1))",
        thumbBorder: 2.5,
        thumbBorderBg: "rgba(255, 255, 255, 0.95)",
        thumbHoverBorder: "rgba(255, 255, 255, 1)",
        thumbActiveBorder: "rgba(255, 255, 255, 1)",
        minHeight: 40,
        thumbShadow: "0 2px 8px rgba(0, 0, 0, 0.1)",
        thumbHoverShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
      };
    })();
    
    const buildStyleText = () => `
        .results-list-scroll {
          overflow-y: auto !important;
          scrollbar-width: thin !important;
          scrollbar-color: rgba(148, 163, 184, 0.8) rgba(248, 250, 252, 0.8) !important;
        }
        
        .results-list-scroll::-webkit-scrollbar {
          width: ${config.scrollbarSize}px !important;
          height: ${config.scrollbarSize}px !important;
          display: block !important;
          -webkit-appearance: none !important;
          background: transparent !important;
        }
        
        .results-list-scroll::-webkit-scrollbar-button {
          display: none !important;
          width: 0 !important;
          height: 0 !important;
          display: none !important;
        }
        
        .results-list-scroll::-webkit-scrollbar-track {
          background: ${config.trackBg} !important;
          border-left: 1px solid ${config.trackBorder} !important;
          border-radius: 12px !important;
          margin: 6px 2px !important;
          opacity: 1 !important;
        }
        
        .results-list-scroll::-webkit-scrollbar-thumb {
          background: ${config.thumbBg} !important;
          border-radius: 12px !important;
          border: ${config.thumbBorder}px solid ${config.thumbBorderBg} !important;
          background-clip: padding-box !important;
          min-height: ${config.minHeight}px !important;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
          box-shadow: ${config.thumbShadow} !important;
          opacity: 1 !important;
          visibility: visible !important;
        }
        
        .results-list-scroll::-webkit-scrollbar-thumb:hover {
          background: ${config.thumbHover} !important;
          border: ${config.thumbBorder}px solid ${config.thumbHoverBorder} !important;
          box-shadow: ${config.thumbHoverShadow} !important;
        }
        
        .results-list-scroll::-webkit-scrollbar-thumb:active {
          background: ${config.thumbActive} !important;
          border: ${config.thumbBorder}px solid ${config.thumbActiveBorder} !important;
          box-shadow: ${config.thumbHoverShadow} !important;
        }
        
        /* 可执行文件横向滚动条的滚动条样式 */
        .executable-scroll-container {
          overflow-x: auto !important;
          scrollbar-width: thin !important;
          scrollbar-color: rgba(148, 163, 184, 0.8) rgba(248, 250, 252, 0.8) !important;
        }
        
        .executable-scroll-container::-webkit-scrollbar {
          height: ${config.scrollbarSize}px !important;
          width: ${config.scrollbarSize}px !important;
          display: block !important;
          -webkit-appearance: none !important;
          background: transparent !important;
        }
        
        .executable-scroll-container::-webkit-scrollbar-button {
          display: none !important;
          width: 0 !important;
          height: 0 !important;
        }
        
        .executable-scroll-container::-webkit-scrollbar-track {
          background: ${config.trackBg} !important;
          border-top: 1px solid ${config.trackBorder} !important;
          border-radius: 12px !important;
          margin: 2px 6px !important;
          opacity: 1 !important;
        }
        
        .executable-scroll-container::-webkit-scrollbar-thumb {
          background: ${config.thumbBg} !important;
          border-radius: 12px !important;
          border: ${config.thumbBorder}px solid ${config.thumbBorderBg} !important;
          background-clip: padding-box !important;
          min-width: ${config.minHeight}px !important;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
          box-shadow: ${config.thumbShadow} !important;
          opacity: 1 !important;
          visibility: visible !important;
        }
        
        .executable-scroll-container::-webkit-scrollbar-thumb:hover {
          background: ${config.thumbHover} !important;
          border: ${config.thumbBorder}px solid ${config.thumbHoverBorder} !important;
          box-shadow: ${config.thumbHoverShadow} !important;
        }
        
        .executable-scroll-container::-webkit-scrollbar-thumb:active {
          background: ${config.thumbActive} !important;
          border: ${config.thumbBorder}px solid ${config.thumbActiveBorder} !important;
          box-shadow: ${config.thumbHoverShadow} !important;
        }
      `;

    // 计算本次样式文本（供判重，避免重复注入触发全文档样式重算）
    const styleText = buildStyleText();

    const injectStyle = () => {
      // 若已存在的样式节点内容一致，跳过重建，避免不必要的样式重算
      const existingStyle = document.getElementById(styleId);
      if (existingStyle && existingStyle.textContent === styleText) {
        return;
      }
      // 如果样式已存在，先移除
      if (existingStyle) {
        existingStyle.remove();
      }

      // 创建新的 style 标签
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = styleText;
      document.head.appendChild(style);
    };

    // 立即注入样式
    injectStyle();
    
    // 延迟再次注入，确保在元素渲染后也能应用
    const timeoutId = setTimeout(() => {
      injectStyle();
    }, 100);
    
    // 监听 DOM 变化，当滚动容器出现时再次注入
    const observer = new MutationObserver(() => {
      if (document.querySelector('.results-list-scroll')) {
        injectStyle();
      }
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    
    return () => {
      clearTimeout(timeoutId);
      observer.disconnect();
      // 清理：组件卸载时移除样式
      const styleToRemove = document.getElementById(styleId);
      if (styleToRemove) {
        styleToRemove.remove();
      }
    };
  }, [resultStyle]);
}
