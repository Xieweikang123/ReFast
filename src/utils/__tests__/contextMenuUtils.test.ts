import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleContextMenu,
  handleContextMenuWithResult,
  clampContextMenuPosition,
  estimateContextMenuHeight,
} from "../contextMenuUtils";
import type { SearchResult } from "../resultUtils";

// Mock tauriApi
vi.mock("../api/tauri", () => ({
  tauriApi: {
    revealInFolder: vi.fn(),
    checkPathExists: vi.fn(),
    deleteFileHistory: vi.fn(),
  },
}));

describe("contextMenuUtils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 重置 window 尺寸
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 800,
    });
    Object.defineProperty(window, "innerHeight", {
      writable: true,
      configurable: true,
      value: 600,
    });
  });

  describe("estimateContextMenuHeight", () => {
    it("URL 类型菜单应使用更大的估算高度", () => {
      const result: SearchResult = {
        type: "url",
        url: "https://example.com",
        displayName: "https://example.com",
        path: "https://example.com",
      };

      expect(estimateContextMenuHeight(result)).toBeGreaterThan(200);
    });
  });

  describe("clampContextMenuPosition", () => {
    it("应将超出底部的菜单上移", () => {
      const position = clampContextMenuPosition(
        100,
        550,
        { width: 160, height: 360 },
        { width: 800, height: 600 }
      );

      expect(position.y + 360).toBeLessThanOrEqual(600 - 8);
    });

    it("应将超出右侧的菜单左移", () => {
      const position = clampContextMenuPosition(
        700,
        100,
        { width: 160, height: 200 },
        { width: 800, height: 600 }
      );

      expect(position.x + 160).toBeLessThanOrEqual(800 - 8);
    });
  });

  describe("handleContextMenu", () => {
    it("应该显示上下文菜单", () => {
      const setContextMenu = vi.fn();
      const mockEvent = {
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientX: 100,
        clientY: 100,
        currentTarget: {
          dataset: { result: null },
        },
      } as any;

      handleContextMenu({
        e: mockEvent,
        setContextMenu,
      });

      expect(mockEvent.preventDefault).toHaveBeenCalled();
      expect(mockEvent.stopPropagation).toHaveBeenCalled();
      expect(setContextMenu).toHaveBeenCalled();
    });

    it("应该调整菜单位置当接近右边界时", () => {
      const setContextMenu = vi.fn();
      const windowWidth = 800;
      const clientX = windowWidth - 50; // 接近右边界

      const mockEvent = {
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientX,
        clientY: 100,
        currentTarget: {
          dataset: { result: null },
        },
      } as any;

      handleContextMenu({
        e: mockEvent,
        setContextMenu,
      });

      expect(setContextMenu).toHaveBeenCalled();
      const callArgs = setContextMenu.mock.calls[0][0];
      expect(callArgs.x).toBeLessThan(clientX); // 应该调整到左侧
    });

    it("应该调整菜单位置当接近下边界时", () => {
      const setContextMenu = vi.fn();
      const windowHeight = 600;
      const clientY = windowHeight - 20; // 接近下边界

      const mockEvent = {
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientX: 100,
        clientY,
        currentTarget: {
          dataset: { result: null },
        },
      } as any;

      handleContextMenu({
        e: mockEvent,
        setContextMenu,
      });

      expect(setContextMenu).toHaveBeenCalled();
      const callArgs = setContextMenu.mock.calls[0][0];
      expect(callArgs.y).toBeLessThan(clientY); // 应该调整到上方
    });
  });

  describe("handleContextMenuWithResult", () => {
    it("应该显示带结果的上下文菜单", () => {
      const setContextMenu = vi.fn();
      const result: SearchResult = {
        type: "file",
        displayName: "Test File",
        path: "C:\\test\\file.txt",
      };

      const mockEvent = {
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientX: 100,
        clientY: 100,
      } as any;

      handleContextMenuWithResult({
        e: mockEvent,
        result,
        setContextMenu,
      });

      expect(mockEvent.preventDefault).toHaveBeenCalled();
      expect(mockEvent.stopPropagation).toHaveBeenCalled();
      expect(setContextMenu).toHaveBeenCalled();
      const callArgs = setContextMenu.mock.calls[0][0];
      expect(callArgs.result).toBe(result);
    });

    it("URL 结果应使用更大的初始偏移避免底部裁切", () => {
      const setContextMenu = vi.fn();
      const windowHeight = 600;
      const clientY = windowHeight - 20;
      const result: SearchResult = {
        type: "url",
        url: "https://example.com",
        displayName: "https://example.com",
        path: "https://example.com",
      };

      const mockEvent = {
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientX: 100,
        clientY,
      } as any;

      handleContextMenuWithResult({
        e: mockEvent,
        result,
        setContextMenu,
      });

      const callArgs = setContextMenu.mock.calls[0][0];
      expect(callArgs.y).toBeLessThan(clientY);
      expect(callArgs.y + estimateContextMenuHeight(result)).toBeLessThanOrEqual(
        windowHeight - 8
      );
    });
  });
});

