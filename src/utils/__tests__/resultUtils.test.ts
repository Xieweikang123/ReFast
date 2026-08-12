import { describe, it, expect, vi } from "vitest";
import {
  clearAllResults,
  getResultKey,
  resetSelectedIndices,
  selectFirstHorizontal,
  selectFirstVertical,
  splitResults,
  compareSearchResults,
  shouldKeepResultForQuery,
  pickSelectionIndicesByOpenHistory,
  pickSelectionIndicesByOpenHistoryFromVertical,
  pickSelectionIndicesWithPin,
} from "../resultUtils";
import type { SearchResult } from "../resultUtils";
import {
  buildDefaultVisibleVerticalItems,
  EVERYTHING_DEFAULT_LIMIT,
} from "../resultGroupUtils";

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

      const { horizontal } = splitResults(results);

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
        "C:\\new.exe": Math.floor(now / 1000),
        "C:\\old.exe": Math.floor(now / 1000) - 1000,
      };

      const { horizontal } = splitResults(results, openHistory, "");

      expect(horizontal.length).toBe(2);
      // 最近使用的应该排在前面
      expect(horizontal[0].path).toBe("C:\\new.exe");
    });

    it("有查询时应过滤未命中项，并让完全匹配优先于最近使用", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const results: SearchResult[] = [
        {
          type: "app",
          displayName: "Cursor.lnk",
          path: "C:\\Cursor.lnk",
          app: { name: "Cursor.lnk" },
        },
        {
          type: "app",
          displayName: "OpenCode",
          path: "C:\\OpenCode.lnk",
          app: { name: "OpenCode" },
        },
        {
          type: "app",
          displayName: "OpenCode Helper",
          path: "C:\\OpenCodeHelper.exe",
          app: { name: "OpenCode Helper" },
        },
      ];

      const openHistory = {
        "C:\\Cursor.lnk": nowSec,
        "C:\\OpenCodeHelper.exe": nowSec - 10,
        // OpenCode 几乎未使用
      };

      const { horizontal } = splitResults(results, openHistory, "opencode");

      expect(horizontal.map((r) => r.displayName)).toEqual([
        "OpenCode",
        "OpenCode Helper",
      ]);
      expect(horizontal.some((r) => r.displayName.includes("Cursor"))).toBe(
        false
      );
    });
  });

  describe("shouldKeepResultForQuery", () => {
    it("应保留 URL 等检测型结果", () => {
      expect(
        shouldKeepResultForQuery(
          {
            type: "url",
            displayName: "https://example.com",
            path: "https://example.com",
            url: "https://example.com",
          },
          "opencode"
        )
      ).toBe(true);
    });
  });

  describe("getResultKey", () => {
    it("应按类型与路径生成稳定标识", () => {
      const result = {
        type: "app" as const,
        displayName: "微信",
        path: "C:\\Users\\Me\\AppData\\微信.exe",
        app: { name: "微信" },
      };
      expect(getResultKey(result)).toBe(
        "app:c:/users/me/appdata/微信.exe"
      );
    });

    it("大小写和斜杠不同的同一路径应得到相同标识", () => {
      const a = {
        type: "file" as const,
        displayName: "a",
        path: "C:\\Users\\Me\\file.txt",
      };
      const b = {
        type: "file" as const,
        displayName: "b",
        path: "c:/users/me/FILE.txt",
      };
      expect(getResultKey(a)).toBe(getResultKey(b));
    });

    it("不同类型同路径应得到不同标识", () => {
      const app = {
        type: "app" as const,
        displayName: "x",
        path: "C:\\app.exe",
      };
      const everything = {
        type: "everything" as const,
        displayName: "x",
        path: "C:\\app.exe",
      };
      expect(getResultKey(app)).not.toBe(getResultKey(everything));
    });

    it("URL 类型优先使用 url 字段作为标识", () => {
      const url = {
        type: "url" as const,
        displayName: "https://opencode.ai",
        path: "https://opencode.ai",
        url: "https://opencode.ai",
      };
      expect(getResultKey(url)).toBe("url:https://opencode.ai");
    });
  });

  describe("compareSearchResults", () => {
    it("有查询时完全匹配应压过仅最近使用的弱相关项", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const exact: SearchResult = {
        type: "app",
        displayName: "OpenCode",
        path: "C:\\OpenCode.lnk",
        app: { name: "OpenCode" },
      };
      const recentPrefix: SearchResult = {
        type: "app",
        displayName: "OpenCode Helper",
        path: "C:\\helper.exe",
        app: { name: "OpenCode Helper" },
      };
      const openHistory = {
        "C:\\helper.exe": nowSec,
      };

      expect(
        compareSearchResults(exact, recentPrefix, {
          query: "opencode",
          openHistory,
        })
      ).toBeLessThan(0);
    });

    it("浏览器路由直达结果应优先于普通结果", () => {
      const ruleUrl: SearchResult = {
        type: "url",
        displayName: "https://opencode.ai",
        path: "https://opencode.ai",
        url: "https://opencode.ai",
        browser: "edge",
      };
      const normalApp: SearchResult = {
        type: "app",
        displayName: "OpenCode 文档",
        path: "C:\\OpenCode 文档.lnk",
        app: { name: "OpenCode 文档" },
      };

      expect(
        compareSearchResults(ruleUrl, normalApp, {
          query: "opencode",
        })
      ).toBeLessThan(0);
      // 未标记 browser 的普通 URL 不受影响
      const plainUrl: SearchResult = {
        type: "url",
        displayName: "https://opencode.ai",
        path: "https://opencode.ai",
        url: "https://opencode.ai",
      };
      expect(
        compareSearchResults(plainUrl, normalApp, {
          query: "opencode",
        })
      ).toBeGreaterThan(0);
    });
  });

  describe("pickSelectionIndicesByOpenHistory", () => {
    const make = (
      type: SearchResult["type"],
      path: string
    ): SearchResult => ({
      type,
      displayName: path,
      path,
    });

    it("只在可见纵向项中选中历史，忽略截断外的 Everything 命中", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const horizontal = [make("app", "C:\\Excel.exe")];
      const vertical = Array.from({ length: 40 }, (_, i) =>
        make("everything", `C:\\docs\\excel-${i}.xlsx`)
      );
      const openHistory = {
        "C:\\docs\\excel-35.xlsx": nowSec,
        "C:\\Excel.exe": nowSec - 100,
      };

      const sel = pickSelectionIndicesByOpenHistoryFromVertical(
        horizontal,
        vertical,
        openHistory
      );

      // 深度历史不在默认可见范围内，应回退到横向最近（Excel.exe）
      expect(sel.selectedHorizontalIndex).toBe(0);
      expect(sel.selectedVerticalIndex).toBeNull();
    });

    it("可见范围内的纵向历史仍可被选中", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const horizontal: SearchResult[] = [];
      const vertical = Array.from({ length: 20 }, (_, i) =>
        make("everything", `C:\\docs\\excel-${i}.xlsx`)
      );
      const openHistory = {
        [`C:\\docs\\excel-3.xlsx`]: nowSec,
      };

      const visible = buildDefaultVisibleVerticalItems(vertical);
      const sel = pickSelectionIndicesByOpenHistory(
        horizontal,
        visible,
        openHistory
      );

      expect(sel.selectedHorizontalIndex).toBeNull();
      expect(sel.selectedVerticalIndex).toBe(3);
      expect(sel.selectedVerticalIndex).toBeLessThan(EVERYTHING_DEFAULT_LIMIT);
    });

    it("无历史时默认选中首个横向", () => {
      const horizontal = [make("app", "C:\\Excel.exe")];
      const vertical = [make("everything", "C:\\a.xlsx")];
      const sel = pickSelectionIndicesByOpenHistoryFromVertical(
        horizontal,
        vertical,
        {}
      );
      expect(sel.selectedHorizontalIndex).toBe(0);
      expect(sel.selectedVerticalIndex).toBeNull();
    });
  });

  describe("pickSelectionIndicesWithPin", () => {
    const make = (
      type: SearchResult["type"],
      path: string
    ): SearchResult => ({
      type,
      displayName: path,
      path,
    });

    it("锁定横向项时保持该行选中", () => {
      const horizontal = [make("app", "C:\\A.exe"), make("app", "C:\\B.exe")];
      const vertical = [make("file", "C:\\doc.txt")];
      const pinnedKeyRef = { current: getResultKey(horizontal[1]) };

      const sel = pickSelectionIndicesWithPin(horizontal, vertical, {}, pinnedKeyRef);

      expect(sel.selectedHorizontalIndex).toBe(1);
      expect(sel.selectedVerticalIndex).toBeNull();
    });

    it("锁定纵向项时保持该行选中", () => {
      const horizontal = [make("app", "C:\\A.exe")];
      const vertical = [make("file", "C:\\a.txt"), make("everything", "C:\\b.pdf")];
      const pinnedKeyRef = { current: getResultKey(vertical[1]) };

      const sel = pickSelectionIndicesWithPin(horizontal, vertical, {}, pinnedKeyRef);

      expect(sel.selectedHorizontalIndex).toBeNull();
      expect(sel.selectedVerticalIndex).toBe(1);
    });

    it("锁定项不存在时回退到 openHistory 选中", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const horizontal = [make("app", "C:\\A.exe"), make("app", "C:\\B.exe")];
      const openHistory = { "C:\\B.exe": nowSec };
      const pinnedKeyRef = { current: "app:c:/gone.exe" };

      const sel = pickSelectionIndicesWithPin(horizontal, [], openHistory, pinnedKeyRef);

      expect(sel.selectedHorizontalIndex).toBe(1);
      expect(sel.selectedVerticalIndex).toBeNull();
    });

    it("未锁定时按 openHistory 选中", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const horizontal = [make("app", "C:\\A.exe"), make("app", "C:\\B.exe")];
      const openHistory = { "C:\\B.exe": nowSec };

      const sel = pickSelectionIndicesWithPin(horizontal, [], openHistory, {
        current: null,
      });

      expect(sel.selectedHorizontalIndex).toBe(1);
    });
  });
});

