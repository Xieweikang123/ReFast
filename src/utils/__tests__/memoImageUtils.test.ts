import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extensionFromMime,
  parseDataUrlImage,
  findUnsavedMemoImages,
} from "../memoImageUtils";
import { UNSAVED_IMAGE_PLACEHOLDER } from "../memoWysiwygUtils";

vi.mock("../../api/tauri", () => import("../../__mocks__/tauri"));

describe("memoImageUtils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extensionFromMime 映射常见类型", () => {
    expect(extensionFromMime("image/png")).toBe("png");
    expect(extensionFromMime("image/jpeg")).toBe("jpg");
    expect(extensionFromMime("image/jpg")).toBe("jpg");
    expect(extensionFromMime("image/webp; charset=binary")).toBe("webp");
    expect(extensionFromMime("image/gif")).toBe("gif");
    expect(extensionFromMime("application/octet-stream")).toBe("png");
  });

  it("parseDataUrlImage 解码 base64", () => {
    // "hi" in base64
    const raw = "aGk=";
    const parsed = parseDataUrlImage(`data:image/png;base64,${raw}`);
    expect(parsed).not.toBeNull();
    expect(parsed!.mime).toBe("image/png");
    expect(Array.from(parsed!.bytes)).toEqual([104, 105]);
  });

  it("parseDataUrlImage 拒绝非法 data URL", () => {
    expect(parseDataUrlImage("data:text/plain;base64,aGk=")).toBeNull();
    expect(parseDataUrlImage("not-a-data-url")).toBeNull();
  });

  it("findUnsavedMemoImages 识别缺 data-memo-src 的图", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <img data-memo-src="images/ok.png" src="blob:x" />
      <img src="https://ex.com/a.png" />
      <img data-memo-src="../evil.png" src="x" />
    `;
    const unsaved = findUnsavedMemoImages(root);
    expect(unsaved).toHaveLength(2);
    expect(unsaved[0].getAttribute("src")).toBe("https://ex.com/a.png");
    expect(unsaved[1].getAttribute("data-memo-src")).toBe("../evil.png");
  });

  it("占位常量与 wysiwyg 一致", () => {
    expect(UNSAVED_IMAGE_PLACEHOLDER).toBe("[未保存的图片]");
  });
});
