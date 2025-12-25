import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleContextMenu,
  handleContextMenuWithResult,
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
      const menuWidth = 160;
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
      const menuHeight = 50;
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

    it("应该正确计算菜单位置", () => {
      const setContextMenu = vi.fn();
      const result: SearchResult = {
        type: "app",
        displayName: "Test App",
        path: "C:\\test\\app.exe",
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

      const callArgs = setContextMenu.mock.calls[0][0];
      expect(callArgs.x).toBe(100);
      expect(callArgs.y).toBe(100);
      expect(callArgs.result).toBe(result);
    });
  });
});

