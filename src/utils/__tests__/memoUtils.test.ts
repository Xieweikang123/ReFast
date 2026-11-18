import { describe, it, expect } from "vitest";
import {
  buildMemoFileAiPrompt,
  buildMemosRootAiPrompt,
  getMemoPrimaryCopyText,
  getMemoTitleText,
  getMemoContentText,
  isMemoEditDirty,
  joinMemoMdPath,
} from "../memoUtils";

describe("memoUtils", () => {
  it("快速复制优先标题", () => {
    expect(
      getMemoPrimaryCopyText({ title: "41010219951212007X", content: "备注" })
    ).toBe("41010219951212007X");
  });

  it("标题为空时用正文", () => {
    expect(getMemoPrimaryCopyText({ title: "  ", content: "hello" })).toBe(
      "hello"
    );
  });

  it("标题与正文皆空返回空串", () => {
    expect(getMemoPrimaryCopyText({ title: "", content: "" })).toBe("");
  });

  it("分别取标题与正文", () => {
    expect(getMemoTitleText({ title: " a " })).toBe("a");
    expect(getMemoContentText({ content: " b " })).toBe("b");
  });

  it("isMemoEditDirty：相对基线检测改动", () => {
    expect(isMemoEditDirty("", "", "", "")).toBe(false);
    expect(isMemoEditDirty("a", "", "", "")).toBe(true);
    expect(isMemoEditDirty("", "x", "", "")).toBe(true);
    expect(isMemoEditDirty("t", "c", "t", "c")).toBe(false);
    expect(isMemoEditDirty("t2", "c", "t", "c")).toBe(true);
  });
});
