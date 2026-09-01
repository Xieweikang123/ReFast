import { describe, it, expect, beforeEach } from "vitest";
import {
  parseSearchFilter,
  hasSearchKeyword,
  shouldSearchSource,
  resultMatchesScope,
  isShortEverythingKeyword,
  shouldAutoSearchEverything,
  shouldShowEverythingSkippedHint,
} from "../searchFilterUtils";
import {
  getEffectiveSearchKeyword,
  resolveSearchHintKind,
  shouldShowEverythingTruncatedHint,
  shouldShowEverythingUnavailableHint,
  shouldShowSearchEngineLocalHiddenHint,
} from "../searchHintUtils";
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

describe("Everything 短词门槛", () => {
  it("中文单字视为短词，两字不是", () => {
    expect(isShortEverythingKeyword("虚")).toBe(true);
    expect(isShortEverythingKeyword("虚拟")).toBe(false);
    expect(isShortEverythingKeyword("a")).toBe(true);
    expect(isShortEverythingKeyword("ab")).toBe(false);
  });

  it("未点过时单字不自动搜 Everything，点过后放行", () => {
    expect(shouldAutoSearchEverything("虚")).toBe(false);
    expect(shouldAutoSearchEverything("虚", "虚")).toBe(true);
    expect(shouldAutoSearchEverything("虚拟")).toBe(true);
    expect(shouldAutoSearchEverything("虚", "虚拟")).toBe(false);
  });

  it("Everything 可用且为单字时显示提示", () => {
    expect(
      shouldShowEverythingSkippedHint({
        query: "虚",
        isEverythingAvailable: true,
        isSearchingEverything: false,
      })
    ).toBe(true);
    expect(
      shouldShowEverythingSkippedHint({
        query: "虚拟",
        isEverythingAvailable: true,
        isSearchingEverything: false,
      })
    ).toBe(false);
    expect(
      shouldShowEverythingSkippedHint({
        query: "虚",
        isEverythingAvailable: true,
        isSearchingEverything: false,
        forceKeyword: "虚",
      })
    ).toBe(false);
    expect(
      shouldShowEverythingSkippedHint({
        query: "a chrome",
        isEverythingAvailable: true,
        isSearchingEverything: false,
      })
    ).toBe(false);
    expect(
      shouldShowEverythingSkippedHint({
        query: "e 虚",
        isEverythingAvailable: true,
        isSearchingEverything: false,
      })
    ).toBe(true);
    expect(
      shouldShowEverythingSkippedHint({
        query: "虚",
        isEverythingAvailable: false,
        isSearchingEverything: false,
      })
    ).toBe(false);
    expect(
      shouldShowEverythingSkippedHint({
        query: "虚",
        isEverythingAvailable: true,
        isSearchingEverything: true,
      })
    ).toBe(false);
  });
});

describe("搜索提示优先级", () => {
  const engines = [
    { prefix: "g ", url: "https://google.com/search?q={query}", name: "Google" },
  ];

  it("搜索引擎前缀优先于其它提示", () => {
    expect(
      resolveSearchHintKind({
        query: "g chrome",
        searchEngines: engines,
        includeLocalWithSearchEngine: false,
        isEverythingAvailable: false,
        isSearchingEverything: false,
        everythingTotalCount: 9000,
      })
    ).toBe("engine-local-hidden");
  });

  it("点过仍搜本地后不再提示网页搜索", () => {
    expect(
      shouldShowSearchEngineLocalHiddenHint({
        query: "g chrome",
        searchEngines: engines,
        includeLocalWithSearchEngine: true,
      })
    ).toBe(false);
  });

  it("Everything 未运行且关键词够长时提示", () => {
    expect(
      resolveSearchHintKind({
        query: "虚拟",
        searchEngines: [],
        includeLocalWithSearchEngine: false,
        isEverythingAvailable: false,
        isSearchingEverything: false,
        everythingTotalCount: null,
      })
    ).toBe("everything-unavailable");
    expect(
      shouldShowEverythingUnavailableHint({
        query: "虚",
        isEverythingAvailable: false,
      })
    ).toBe(false);
  });

  it("磁盘命中超过合并上限时提示截断", () => {
    expect(
      shouldShowEverythingTruncatedHint({ everythingTotalCount: 40 })
    ).toBe(false);
    expect(
      shouldShowEverythingTruncatedHint({ everythingTotalCount: 41 })
    ).toBe(true);
    expect(
      resolveSearchHintKind({
        query: "虚拟",
        searchEngines: [],
        includeLocalWithSearchEngine: false,
        isEverythingAvailable: true,
        isSearchingEverything: false,
        everythingTotalCount: 8000,
      })
    ).toBe("everything-truncated");
  });

  it("有效搜索关键词去掉搜索引擎前缀", () => {
    expect(getEffectiveSearchKeyword("g chrome", engines)).toBe("chrome");
    expect(getEffectiveSearchKeyword("虚拟", engines)).toBe("虚拟");
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
