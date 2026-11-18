import { describe, it, expect, beforeEach } from "vitest";
import {
  detectInstantTools,
  evaluateMathExpression,
  convertUnit,
  md5,
  sha1,
  sha256,
  resetGuidCacheForTests,
} from "../instantToolsUtils";
import { computeCombinedResults } from "../combineResultsUtils";
import type { CombineResultsOptions } from "../combineResultsUtils";

function baseOptions(
  overrides: Partial<CombineResultsOptions> = {}
): CombineResultsOptions {
  return {
    query: "",
    aiAnswer: null,
    filteredApps: [],
    filteredFiles: [],
    filteredMemos: [],
    systemFolders: [],
    everythingResults: [],
    filteredPlugins: [],
    detectedUrls: [],
    detectedEmails: [],
    detectedJson: null,
    directPathResult: null,
    openHistory: {},
    urlRemarks: {},
    searchEngines: [],
    apps: [],
    extractedFileIconsRef: { current: new Map() },
    ...overrides,
  };
}

describe("instantToolsUtils", () => {
  beforeEach(() => {
    resetGuidCacheForTests();
  });

  describe("evaluateMathExpression", () => {
    it("计算 1+2*3 = 7", () => {
      expect(evaluateMathExpression("1+2*3")).toBe("7");
    });

    it("支持括号与除法", () => {
      expect(evaluateMathExpression("(10-3)/2")).toBe("3.5");
    });

    it("非法表达式不产出", () => {
      expect(evaluateMathExpression("hello")).toBeNull();
      expect(evaluateMathExpression("1")).toBeNull();
      expect(evaluateMathExpression("abc + def")).toBeNull();
    });
  });

  describe("convertUnit", () => {
    it("100km to mi", () => {
      const r = convertUnit("100km to mi");
      expect(r).not.toBeNull();
      expect(Number(r!.value)).toBeCloseTo(62.137, 2);
    });

    it("32F to C", () => {
      const r = convertUnit("32F to C");
      expect(r).not.toBeNull();
      expect(Number(r!.value)).toBeCloseTo(0, 5);
    });
  });

  describe("hash", () => {
    it("md5 固定摘要", () => {
      expect(md5("hello")).toBe("5d41402abc4b2a76b9719d911017c592");
    });

    it("sha1 固定摘要", () => {
      expect(sha1("hello")).toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
    });

    it("sha256 固定摘要", () => {
      expect(sha256("hello")).toBe(
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
      );
    });

    it("detectInstantTools 识别 md5 前缀", () => {
      const hits = detectInstantTools("md5 hello");
      expect(hits).toHaveLength(1);
      expect(hits[0].kind).toBe("hash");
      expect(hits[0].value).toBe("5d41402abc4b2a76b9719d911017c592");
    });
  });

  describe("guid", () => {
    it("同 query 稳定", () => {
      const a = detectInstantTools("guid");
      const b = detectInstantTools("guid");
      expect(a).toHaveLength(1);
      expect(a[0].kind).toBe("guid");
      expect(a[0].value).toBe(b[0].value);
      expect(a[0].value).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it("换 query 再回 guid 会变", () => {
      const first = detectInstantTools("guid")[0].value;
      detectInstantTools("hello");
      const again = detectInstantTools("guid")[0].value;
      expect(again).not.toBe(first);
    });
  });

  describe("detectInstantTools 优先级", () => {
    it("数学表达式产出 calc", () => {
      const hits = detectInstantTools("1+2*3");
      expect(hits[0]?.kind).toBe("calc");
      expect(hits[0]?.value).toBe("7");
      expect(hits[0]?.displayName).toBe("= 7");
    });

    it("单位换算优先于可能被误判的表达式", () => {
      const hits = detectInstantTools("100 km to mi");
      expect(hits[0]?.kind).toBe("unit");
    });
  });

  describe("combine 接入", () => {
    it("数学查询时结果含 instant 且靠前", () => {
      const results = computeCombinedResults(
        baseOptions({
          query: "1+2*3",
          filteredApps: [
            { name: "计算器", path: "C:\\Windows\\System32\\calc.exe" },
          ],
        })
      );
      const instant = results.find((r) => r.type === "instant");
      expect(instant).toBeDefined();
      expect(instant!.instantKind).toBe("calc");
      expect(instant!.instantValue).toBe("7");
      expect(results[0].type).toBe("instant");
    });
  });
});
