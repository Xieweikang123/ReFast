import { describe, it, expect } from "vitest";
import {
  stripMemoImages,
  getMemoContentPreview,
  extractMemoImageRefs,
  firstMemoImageRef,
  removeMemoImageRef,
  hasMemoSubstance,
  filterMemosByQuery,
} from "../memoPreviewUtils";

describe("memoPreviewUtils", () => {
  it("纯文本原样预览", () => {
    expect(getMemoContentPreview("hello world")).toBe("hello world");
  });

  it("图片替换为标记", () => {
    expect(stripMemoImages("前 ![a](images/1.png) 后")).toBe("前 [图片] 后");
  });

  it("多图与混排", () => {
    expect(
      getMemoContentPreview("开会\n\n![x](images/a.png)\n结论 ![y](images/b.jpg)")
    ).toBe("开会 [图片] 结论 [图片]");
  });

  it("仅图片时显示标记", () => {
    expect(getMemoContentPreview("![x](images/a.png)")).toBe("[图片]");
  });

  it("截断超长正文", () => {
    const long = "字".repeat(100);
    const preview = getMemoContentPreview(long, 10);
    expect(preview).toBe(`${"字".repeat(10)}...`);
  });

  it("空内容", () => {
    expect(getMemoContentPreview("")).toBe("(无内容)");
    expect(getMemoContentPreview(null)).toBe("(无内容)");
  });

  it("提取与移除图片引用", () => {
    const content = "a ![x](images/a.png)\nb ![y](images/b.jpg)";
    expect(extractMemoImageRefs(content)).toEqual([
      "images/a.png",
      "images/b.jpg",
    ]);
    expect(firstMemoImageRef(content)).toBe("images/a.png");
    expect(removeMemoImageRef(content, "images/a.png")).toBe(
      "a b ![y](images/b.jpg)"
    );
  });

  it("有图或文字算有实质内容", () => {
    expect(hasMemoSubstance("", "")).toBe(false);
    expect(hasMemoSubstance("t", "")).toBe(true);
    expect(hasMemoSubstance("", "hello")).toBe(true);
    expect(hasMemoSubstance("", "![x](images/a.png)")).toBe(true);
  });

  it("按标题或正文过滤", () => {
    const memos = [
      { title: "会议纪要", content: "讨论 Q3 目标" },
      { title: "购物", content: "牛奶 鸡蛋" },
      { title: "", content: "仅有正文 Hello" },
    ];
    expect(filterMemosByQuery(memos, "").length).toBe(3);
    expect(filterMemosByQuery(memos, "会议").map((m) => m.title)).toEqual([
      "会议纪要",
    ]);
    expect(filterMemosByQuery(memos, "牛奶").map((m) => m.title)).toEqual([
      "购物",
    ]);
    expect(filterMemosByQuery(memos, "hello").map((m) => m.content)).toEqual([
      "仅有正文 Hello",
    ]);
    expect(filterMemosByQuery(memos, "不存在")).toEqual([]);
  });
});
