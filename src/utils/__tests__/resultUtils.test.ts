import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  clearAllResults,
  resetSelectedIndices,
  selectFirstHorizontal,
  selectFirstVertical,
  splitResults,
} from "../resultUtils";
import type { SearchResult } from "../resultUtils";

describe("resultUtils", () => {
  describe("clearAllResults", () => {
    it("应该清空所有结果和索引", () => {
      const setResults = vi.fn();
      const setHorizontalResults = vi.fn();
      const setVerticalResults = vi.fn();
      const setSelectedHorizontalIndex = vi.fn();
      const setSelectedVerticalIndex = vi.fn();
      const horizontalResultsRef = { current: [] as SearchResult[] };
      const currentLoadResultsRef = { current: [] as SearchResult[] };

      clearAllResults({
        setResults,
        setHorizontalResults,
        setVerticalResults,
        setSelectedHorizontalIndex,
        setSelectedVerticalIndex,
        horizontalResultsRef,
        currentLoadResultsRef,
      });

      expect(setResults).toHaveBeenCalledWith([]);
      expect(setHorizontalResults).toHaveBeenCalledWith([]);
      expect(setVerticalResults).toHaveBeenCalledWith([]);
      expect(setSelectedHorizontalIndex).toHaveBeenCalledWith(null);
      expect(setSelectedVerticalIndex).toHaveBeenCalledWith(null);
      expect(horizontalResultsRef.current).toEqual([]);
      expect(currentLoadResultsRef.current).toEqual([]);
    });

    it("应该处理可选的 refs", () => {
      const setResults = vi.fn();
      const setHorizontalResults = vi.fn();
      const setVerticalResults = vi.fn();
      const setSelectedHorizontalIndex = vi.fn();
      const setSelectedVerticalIndex = vi.fn();

      clearAllResults({
        setResults,
        setHorizontalResults,
        setVerticalResults,
        setSelectedHorizontalIndex,
        setSelectedVerticalIndex,
      });

      expect(setResults).toHaveBeenCalledWith([]);
    });

    it("应该记录日志消息", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const setResults = vi.fn();
      const setHorizontalResults = vi.fn();
      const setVerticalResults = vi.fn();
      const setSelectedHorizontalIndex = vi.fn();
      const setSelectedVerticalIndex = vi.fn();

      clearAllResults({
        setResults,
        setHorizontalResults,
        setVerticalResults,
        setSelectedHorizontalIndex,
        setSelectedVerticalIndex,
        logMessage: "Test message",
      });

      expect(consoleSpy).toHaveBeenCalledWith("Test message");
      consoleSpy.mockRestore();
    });
  });

  describe("resetSelectedIndices", () => {
    it("应该重置所有选中索引", () => {
      const setSelectedHorizontalIndex = vi.fn();
      const setSelectedVerticalIndex = vi.fn();

      resetSelectedIndices(setSelectedHorizontalIndex, setSelectedVerticalIndex);

      expect(setSelectedHorizontalIndex).toHaveBeenCalledWith(null);
      expect(setSelectedVerticalIndex).toHaveBeenCalledWith(null);
    });
  });

  describe("selectFirstHorizontal", () => {
    it("应该选中第一个横向结果", () => {
      const setSelectedHorizontalIndex = vi.fn();
      const setSelectedVerticalIndex = vi.fn();

      selectFirstHorizontal(setSelectedHorizontalIndex, setSelectedVerticalIndex);

      expect(setSelectedHorizontalIndex).toHaveBeenCalledWith(0);
      expect(setSelectedVerticalIndex).toHaveBeenCalledWith(null);
    });
  });

  describe("selectFirstVertical", () => {
    it("应该选中第一个纵向结果", () => {
      const setSelectedHorizontalIndex = vi.fn();
      const setSelectedVerticalIndex = vi.fn();

      selectFirstVertical(setSelectedHorizontalIndex, setSelectedVerticalIndex);

      expect(setSelectedHorizontalIndex).toHaveBeenCalledWith(null);
      expect(setSelectedVerticalIndex).toHaveBeenCalledWith(0);
    });
  });

  describe("splitResults", () => {
    it("应该将应用结果放入横向列表", () => {
      const results: SearchResult[] = [
        {
          type: "app",
          displayName: "Test App",
          path: "C:\\test\\app.exe",
          app: { name: "Test App" },
        },
      ];

      const { horizontal, vertical } = splitResults(results);

      expect(horizontal.length).toBe(1);
      expect(horizontal[0].type).toBe("app");
      expect(vertical.length).toBe(0);
    });

    it("应该将 .lnk 文件放入横向列表", () => {
      const results: SearchResult[] = [
        {
          type: "app",
          displayName: "Shortcut",
          path: "C:\\test\\shortcut.lnk",
          app: { name: "Shortcut" },
        },
      ];

      const { horizontal, vertical } = splitResults(results);

      expect(horizontal.length).toBe(1);
      expect(horizontal[0].path.toLowerCase()).toContain(".lnk");
    });

    it("应该将非应用结果放入纵向列表", () => {
      const results: SearchResult[] = [
        {
          type: "file",
          displayName: "Test File",
          path: "C:\\test\\file.txt",
          file: { name: "Test File" },
        },
      ];

      const { horizontal, vertical } = splitResults(results);

      expect(horizontal.length).toBe(0);
      expect(vertical.length).toBe(1);
      expect(vertical[0].type).toBe("file");
    });

    it("应该对应用结果去重", () => {
      const results: SearchResult[] = [
        {
          type: "app",
          displayName: "Test App",
          path: "C:\\test\\app.exe",
          app: { name: "Test App" },
        },
        {
          type: "app",
          displayName: "Test App",
          path: "C:\\test\\app.exe",
          app: { name: "Test App" },
        },
      ];

      const { horizontal } = splitResults(results);

      expect(horizontal.length).toBe(1);
    });

    it("应该将插件结果放入横向列表", () => {
      const results: SearchResult[] = [
        {
          type: "plugin",
          displayName: "Test Plugin",
          path: "plugin://test",
          plugin: { id: "test", name: "Test Plugin" },
        },
      ];

      const { horizontal, vertical } = splitResults(results);

      expect(horizontal.length).toBe(1);
      expect(horizontal[0].type).toBe("plugin");
      expect(vertical.length).toBe(0);
    });

    it("应该按使用时间排序横向结果", () => {
      const now = Date.now();
      const results: SearchResult[] = [
        {
          type: "app",
          displayName: "Old App",
          path: "C:\\old.exe",
          app: { name: "Old App" },
        },
        {
          type: "app",
          displayName: "New App",
          path: "C:\\new.exe",
          app: { name: "New App" },
        },
      ];

      const openHistory = {
        "C:\\new.exe": now,
        "C:\\old.exe": now - 1000,
      };

      const { horizontal } = splitResults(results, openHistory, "");

      expect(horizontal.length).toBe(2);
      // 最近使用的应该排在前面
      expect(horizontal[0].path).toBe("C:\\new.exe");
    });
  });
});

