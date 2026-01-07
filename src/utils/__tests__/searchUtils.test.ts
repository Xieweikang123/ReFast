import { describe, it, expect, vi } from "vitest";
import {
  detectSearchIntent,
  buildSearchUrl,
  getSearchResultItem,
  searchApplicationsFrontend,
  searchFileHistoryFrontend,
} from "../searchUtils";
import type { SearchEngineConfig, AppInfo, FileHistoryItem } from "../../types";

// Mock tauriApi
vi.mock("../../api/tauri", () => ({
  tauriApi: {
    searchApplications: vi.fn(),
    scanApplications: vi.fn(),
  },
}));

describe("searchUtils", () => {
  describe("detectSearchIntent", () => {
    it("应该检测搜索引擎前缀", () => {
      const engines: SearchEngineConfig[] = [
        { name: "Google", prefix: "g ", url: "https://google.com/search?q={query}" },
        { name: "百度", prefix: "b ", url: "https://baidu.com/s?wd={query}" },
      ];

      const result = detectSearchIntent("g test query", engines);
      expect(result).not.toBeNull();
      expect(result?.engine.name).toBe("Google");
      expect(result?.keyword).toBe("test query");
    });

    it("应该优先匹配更长的前缀", () => {
      const engines: SearchEngineConfig[] = [
        { name: "Short", prefix: "s ", url: "https://short.com?q={query}" },
        { name: "Long", prefix: "search ", url: "https://long.com?q={query}" },
      ];

      const result = detectSearchIntent("search test", engines);
      expect(result).not.toBeNull();
      expect(result?.engine.name).toBe("Long");
    });

    it("应该返回 null 当没有匹配时", () => {
      const engines: SearchEngineConfig[] = [
        { name: "Google", prefix: "g ", url: "https://google.com/search?q={query}" },
      ];

      expect(detectSearchIntent("no match", engines)).toBeNull();
    });

    it("应该返回 null 当查询为空时", () => {
      const engines: SearchEngineConfig[] = [
        { name: "Google", prefix: "g ", url: "https://google.com/search?q={query}" },
      ];

      expect(detectSearchIntent("", engines)).toBeNull();
      expect(detectSearchIntent("   ", engines)).toBeNull();
    });
  });

  describe("buildSearchUrl", () => {
    it("应该替换 URL 模板中的 {query}", () => {
      const url = buildSearchUrl("https://google.com/search?q={query}", "test query");
      expect(url).toBe("https://google.com/search?q=test%20query");
    });

    it("应该编码特殊字符", () => {
      const url = buildSearchUrl("https://google.com/search?q={query}", "test & query");
      expect(url).toContain("test%20%26%20query");
    });

    it("应该处理多个 {query} 占位符", () => {
      const url = buildSearchUrl("https://example.com?q={query}&lang={query}", "test");
      expect(url).toBe("https://example.com?q=test&lang=test");
    });
  });

  describe("getSearchResultItem", () => {
    it("应该生成搜索结果项", () => {
      const engine: SearchEngineConfig = {
        name: "Google",
        prefix: "g ",
        url: "https://google.com/search?q={query}",
      };

      const result = getSearchResultItem(engine, "test query");
      expect(result.type).toBe("search");
      expect(result.displayName).toContain("Google");
      expect(result.displayName).toContain("test query");
      expect(result.path).toBe("https://google.com/search?q=test%20query");
    });
  });

  describe("searchApplicationsFrontend", () => {
    const mockApps: AppInfo[] = [
      { name: "微信", path: "C:\\WeChat.exe", name_pinyin: "weixin", name_pinyin_initials: "wx" },
      { name: "QQ", path: "C:\\QQ.exe" },
      { name: "Chrome", path: "C:\\Chrome.exe" },
      { name: "Visual Studio Code", path: "C:\\VSCode.exe" },
    ];

    it("应该返回前10个应用当查询为空时", async () => {
      const results = await searchApplicationsFrontend("", mockApps);
      expect(results.length).toBeLessThanOrEqual(10);
    });

    it("应该精确匹配应用名称", async () => {
      const results = await searchApplicationsFrontend("微信", mockApps);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe("微信");
    });

    it("应该支持拼音搜索", async () => {
      const results = await searchApplicationsFrontend("weixin", mockApps);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe("微信");
    });

    it("应该支持拼音首字母搜索", async () => {
      const results = await searchApplicationsFrontend("wx", mockApps);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe("微信");
    });

    it("应该支持部分匹配", async () => {
      const results = await searchApplicationsFrontend("Chrome", mockApps);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toContain("Chrome");
    });

    it("应该按相关性排序", async () => {
      const results = await searchApplicationsFrontend("QQ", mockApps);
      expect(results[0].name).toBe("QQ");
    });

    it("应该限制返回结果数量", async () => {
      const manyApps = Array.from({ length: 100 }, (_, i) => ({
        name: `App${i}`,
        path: `C:\\App${i}.exe`,
      }));
      const results = await searchApplicationsFrontend("App", manyApps);
      expect(results.length).toBeLessThanOrEqual(50);
    });
  });

  describe("searchFileHistoryFrontend", () => {
    const mockFileHistory: FileHistoryItem[] = [
      {
        name: "test.txt",
        path: "C:\\test.txt",
        last_used: Math.floor(Date.now() / 1000) - 100,
        use_count: 5,
      },
      {
        name: "document.pdf",
        path: "C:\\documents\\document.pdf",
        last_used: Math.floor(Date.now() / 1000) - 200,
        use_count: 3,
      },
      {
        name: "image.png",
        path: "C:\\images\\image.png",
        last_used: Math.floor(Date.now() / 1000) - 300,
        use_count: 1,
      },
    ];

    it("应该返回所有文件当查询为空时", async () => {
      const results = await searchFileHistoryFrontend("", mockFileHistory);
      expect(results.length).toBeGreaterThan(0);
    });

    it("应该按最后使用时间排序当查询为空时", async () => {
      const results = await searchFileHistoryFrontend("", mockFileHistory);
      expect(results[0].last_used).toBeGreaterThanOrEqual(results[1].last_used);
    });

    it("应该精确匹配文件名", async () => {
      const results = await searchFileHistoryFrontend("test", mockFileHistory);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toContain("test");
    });

    it("应该支持路径匹配", async () => {
      const results = await searchFileHistoryFrontend("documents", mockFileHistory);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toContain("documents");
    });

    it("应该按分数排序", async () => {
      const results = await searchFileHistoryFrontend("test", mockFileHistory);
      // 完全匹配应该排在前面
      expect(results[0].name).toBe("test.txt");
    });

    it("应该限制返回结果数量", async () => {
      const manyFiles = Array.from({ length: 200 }, (_, i) => ({
        name: `file${i}.txt`,
        path: `C:\\file${i}.txt`,
        last_used: Math.floor(Date.now() / 1000) - i,
        use_count: 1,
      }));
      const results = await searchFileHistoryFrontend("file", manyFiles);
      expect(results.length).toBeLessThanOrEqual(100);
    });
  });
});

