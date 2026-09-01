import { describe, it, expect } from "vitest";
import {
  classifyFileKind,
  composeEverythingQuery,
  formatFileSize,
  getExtension,
  highlightSegments,
  pushRecentQuery,
  readRecentQueries,
} from "../everythingSearchWindowUtils";

describe("composeEverythingQuery", () => {
  it("空输入且无路径时应返回空字符串", () => {
    expect(composeEverythingQuery("  ")).toBe("");
  });

  it("应附加大小写和全词匹配前缀", () => {
    expect(
      composeEverythingQuery("report", {
        caseSensitive: true,
        matchWholeWord: true,
      })
    ).toBe("case: ww: report");
  });

  it("用户已写语法时不应重复添加前缀", () => {
    expect(
      composeEverythingQuery("case: ww: foo", {
        caseSensitive: true,
        matchWholeWord: true,
        pathScope: "D:\\docs",
      })
    ).toBe('case: ww: foo path:"D:\\docs"');
  });

  it("仅限定路径时也应生成可搜索查询", () => {
    expect(composeEverythingQuery("", { pathScope: "C:\\Users" })).toBe(
      'path:"C:\\Users"'
    );
  });
});

describe("file helpers", () => {
  it("应按扩展名识别类型", () => {
    expect(classifyFileKind("a.png")).toBe("image");
    expect(classifyFileKind("a.mp4")).toBe("video");
    expect(classifyFileKind("Notes", true)).toBe("folder");
    expect(getExtension("photo.JPEG")).toBe("jpeg");
  });

  it("应格式化文件大小", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
  });

  it("应按关键词拆分高亮段", () => {
    const segments = highlightSegments("MyReport.pdf", "report");
    expect(segments.some((s) => s.match && s.text.toLowerCase() === "report")).toBe(
      true
    );
  });
});

describe("recent queries", () => {
  it("应去重并放到最前", () => {
    expect(pushRecentQuery(["foo", "bar"], "FOO".toLowerCase())).toEqual([
      "foo",
      "bar",
    ]);
    expect(pushRecentQuery(["foo", "bar"], "baz")).toEqual(["baz", "foo", "bar"]);
  });

  it("应安全解析本地存储", () => {
    expect(readRecentQueries('["a","b"]')).toEqual(["a", "b"]);
    expect(readRecentQueries("not-json")).toEqual([]);
  });
});
