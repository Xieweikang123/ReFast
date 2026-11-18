import { describe, it, expect } from "vitest";
import {
  markdownToEditorHtml,
  editorRootToMarkdown,
  escapeHtml,
  extractImageSrcsFromHtml,
  isPersistableImageSrc,
  UNSAVED_IMAGE_PLACEHOLDER,
} from "../memoWysiwygUtils";

describe("memoWysiwygUtils", () => {
  it("转义 HTML", () => {
    expect(escapeHtml(`a<b>&"c`)).toBe("a&lt;b&gt;&amp;&quot;c");
  });

  it("纯文本 markdown → html → markdown 往返", () => {
    const md = "第一行\n第二行";
    const html = markdownToEditorHtml(md);
    const root = document.createElement("div");
    root.innerHTML = html;
    expect(editorRootToMarkdown(root)).toBe(md);
  });

  it("含图 markdown 往返保留相对路径", () => {
    const md = "开头\n![白板](images/a.png)\n结尾";
    const html = markdownToEditorHtml(md);
    expect(html).toContain('data-memo-src="images/a.png"');
    const root = document.createElement("div");
    root.innerHTML = html;
    expect(editorRootToMarkdown(root)).toBe(md);
  });

  it("空内容给出可编辑占位", () => {
    const html = markdownToEditorHtml("");
    expect(html).toContain("<div>");
  });

  it("从 HTML 提取 img src", () => {
    const html =
      '<p>hi</p><img src="https://ex.com/a.png"><img src="data:image/png;base64,aa"><img>';
    expect(extractImageSrcsFromHtml(html)).toEqual([
      "https://ex.com/a.png",
      "data:image/png;base64,aa",
    ]);
    expect(extractImageSrcsFromHtml("no images")).toEqual([]);
    expect(extractImageSrcsFromHtml("")).toEqual([]);
  });

  it("识别可落盘的图片地址", () => {
    expect(isPersistableImageSrc("https://a.com/x.png")).toBe(true);
    expect(isPersistableImageSrc("http://a.com/x.png")).toBe(true);
    expect(isPersistableImageSrc("data:image/png;base64,xx")).toBe(true);
    expect(isPersistableImageSrc("blob:http://localhost/1")).toBe(true);
    expect(isPersistableImageSrc("images/a.png")).toBe(false);
    expect(isPersistableImageSrc("file:///C:/a.png")).toBe(false);
  });

  it("无 data-memo-src 的 img 序列化为可见占位而非静默丢弃", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div>前</div><div><img src="https://ex.com/a.png" alt="外链"></div><div>后</div>';
    const md = editorRootToMarkdown(root);
    expect(md).toContain(UNSAVED_IMAGE_PLACEHOLDER);
    expect(md).not.toContain("https://ex.com");
    expect(md).toContain("前");
    expect(md).toContain("后");
  });
});
