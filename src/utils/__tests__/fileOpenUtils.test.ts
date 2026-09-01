import { describe, it, expect, vi } from "vitest";
import {
  getFileExtension,
  resolveFileOpenHandler,
  syncRelatedFileOpenRules,
  isConfigurableFileExtension,
} from "../fileOpenUtils";

vi.mock("../../api/tauri", () => ({
  tauriApi: {
    launchFile: vi.fn(),
    showMarkdownEditorWindow: vi.fn(),
  },
}));

describe("fileOpenUtils", () => {
  it("getFileExtension 应返回小写扩展名", () => {
    expect(getFileExtension("C:\\docs\\readme.MD")).toBe("md");
    expect(getFileExtension("noext")).toBeNull();
  });

  it("isConfigurableFileExtension 应识别 md/markdown", () => {
    expect(isConfigurableFileExtension("md")).toBe(true);
    expect(isConfigurableFileExtension("markdown")).toBe(true);
    expect(isConfigurableFileExtension("txt")).toBe(false);
    expect(isConfigurableFileExtension(null)).toBe(false);
  });

  it("resolveFileOpenHandler 应按规则返回处理器", () => {
    expect(
      resolveFileOpenHandler("C:\\a.md", { md: "markdown_editor" })
    ).toBe("markdown_editor");
    expect(resolveFileOpenHandler("C:\\a.md", {})).toBe("default");
  });

  it("syncRelatedFileOpenRules 应同步 md 与 markdown", () => {
    const rules = syncRelatedFileOpenRules({}, "md", "markdown_editor");
    expect(rules.md).toBe("markdown_editor");
    expect(rules.markdown).toBe("markdown_editor");
  });
});
