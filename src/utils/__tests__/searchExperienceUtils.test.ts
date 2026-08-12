import { describe, it, expect, beforeEach } from "vitest";
import {
  parseSearchFilter,
  hasSearchKeyword,
  shouldSearchSource,
  resultMatchesScope,
} from "../searchFilterUtils";
import {
  pushQueryHistory,
  getQueryHistory,
  clearQueryHistory,
  QUERY_HISTORY_KEY,
  QUERY_HISTORY_MAX,
} from "../queryHistoryUtils";
import {
  buildVisibleVerticalItems,
  EVERYTHING_DEFAULT_LIMIT,
  SHOW_MORE_EVERYTHING_PATH,
} from "../resultGroupUtils";
import type { SearchResult } from "../resultUtils";

describe("searchFilterUtils", () => {
  it("解析 a/f/p/m/e 前缀", () => {
    expect(parseSearchFilter("a chrome").scope).toBe("app");
    expect(parseSearchFilter("a chrome").keyword).toBe("chrome");
    expect(parseSearchFilter("f report").scope).toBe("file");
    expect(parseSearchFilter("p json").scope).toBe("plugin");
    expect(parseSearchFilter("m todo").scope).toBe("memo");
    expect(parseSearchFilter("e pdf").scope).toBe("everything");
  });

  it("无空格不视为过滤器", () => {
    const parsed = parseSearchFilter("achrome");
    expect(parsed.hasFilter).toBe(false);
    expect(parsed.keyword).toBe("achrome");
  });

  it("纯前缀无关键词", () => {
    const parsed = parseSearchFilter("a ");
    expect(parsed.hasFilter).toBe(true);
    expect(parsed.keyword).toBe("");
    expect(hasSearchKeyword(parsed)).toBe(false);
  });

  it("大小写不敏感匹配前缀", () => {
    expect(parseSearchFilter("A chrome").scope).toBe("app");
  });

  it("shouldSearchSource 按 scope 门控", () => {
    expect(shouldSearchSource("app", "everything")).toBe(false);
    expect(shouldSearchSource("app", "app")).toBe(true);
    expect(shouldSearchSource("file", "everything")).toBe(true);
    expect(shouldSearchSource("everything", "app")).toBe(false);
  });

  it("resultMatchesScope", () => {
    expect(resultMatchesScope("app", "app")).toBe(true);
    expect(resultMatchesScope("everything", "app")).toBe(false);
    expect(resultMatchesScope("everything", "file")).toBe(true);
  });
});

describe("queryHistoryUtils", () => {
  beforeEach(() => {
    clearQueryHistory();
    localStorage.removeItem(QUERY_HISTORY_KEY);
  });

  it("写入并去重置顶", () => {
    pushQueryHistory("foo");
    pushQueryHistory("bar");
    pushQueryHistory("foo");
    expect(getQueryHistory()).toEqual(["foo", "bar"]);
  });

  it("空串不写入", () => {
    pushQueryHistory("   ");
    expect(getQueryHistory()).toEqual([]);
  });

  it("短于最小关键词长度不写入", () => {
    pushQueryHistory("a");
    pushQueryHistory("a x");
    expect(getQueryHistory()).toEqual([]);
  });

  it("带过滤器前缀时按 keyword 长度判断", () => {
    pushQueryHistory("a chrome");
    expect(getQueryHistory()).toEqual(["a chrome"]);
  });

  it("限制最大条数", () => {
    for (let i = 0; i < QUERY_HISTORY_MAX + 10; i++) {
      pushQueryHistory(`q-${i}`);
    }
    expect(getQueryHistory().length).toBe(QUERY_HISTORY_MAX);
    expect(getQueryHistory()[0]).toBe(`q-${QUERY_HISTORY_MAX + 9}`);
  });
});

describe("resultGroupUtils", () => {
  const make = (type: SearchResult["type"], path: string): SearchResult => ({
    type,
    displayName: path,
    path,
  });

  it("扁平可见列表保留排序：最近使用的其他类型结果排在前面", () => {
    const recentUrl: SearchResult = {
      type: "url",
      displayName: "https://recent.example.com",
      path: "https://recent.example.com",
      url: "https://recent.example.com",
    };
    const items = buildVisibleVerticalItems({
      verticalResults: [
        recentUrl,
        make("file", "a.txt"),
        make("everything", "b.txt"),
      ],
      everythingLimit: EVERYTHING_DEFAULT_LIMIT,
    });
    expect(items.map((i) => i.kind)).toEqual(["result", "result", "result"]);
    expect(items[0].kind === "result" && items[0].result).toBe(recentUrl);
  });

  it("Everything 默认限制并生成显示更多", () => {
    const everything = Array.from({ length: 20 }, (_, i) =>
      make("everything", `e-${i}`)
    );
    const items = buildVisibleVerticalItems({
      verticalResults: everything,
      everythingLimit: EVERYTHING_DEFAULT_LIMIT,
    });
    expect(items.filter((i) => i.kind === "result")).toHaveLength(
      EVERYTHING_DEFAULT_LIMIT
    );
    const more = items.find((i) => i.kind === "show_more");
    expect(more).toBeDefined();
    if (more?.kind === "show_more") {
      expect(more.remaining).toBe(5);
      expect(more.path).toBe(SHOW_MORE_EVERYTHING_PATH);
    }
  });

  it("Everything 截断不影响其他类型结果展示", () => {
    const everything = Array.from({ length: 20 }, (_, i) =>
      make("everything", `e-${i}`)
    );
    const items = buildVisibleVerticalItems({
      verticalResults: [...everything, make("file", "a.txt")],
      everythingLimit: EVERYTHING_DEFAULT_LIMIT,
    });
    expect(items.filter((i) => i.kind === "result")).toHaveLength(
      EVERYTHING_DEFAULT_LIMIT + 1
    );
    const more = items.find((i) => i.kind === "show_more");
    expect(more).toBeDefined();
    if (more?.kind === "show_more") {
      expect(more.remaining).toBe(5);
    }
  });
});
