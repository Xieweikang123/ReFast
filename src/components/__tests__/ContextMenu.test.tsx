import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { ContextMenu } from "../ContextMenu";
import type { SearchResult } from "../../utils/resultUtils";

const urlResult: SearchResult = {
  type: "url",
  url: "https://example.com",
  displayName: "https://example.com",
  path: "https://example.com",
};

function renderUrlMenu(overrides: Partial<ComponentProps<typeof ContextMenu>> = {}) {
  const onClose = vi.fn();
  const onOpenUrl = vi.fn().mockResolvedValue(undefined);
  const onOpenUrlWithBrowser = vi.fn().mockResolvedValue(undefined);

  render(
    <ContextMenu
      menu={{ x: 12, y: 12, result: urlResult }}
      onClose={onClose}
      onRevealInFolder={vi.fn()}
      onEditMemo={vi.fn()}
      onDeleteMemo={vi.fn()}
      onOpenUrl={onOpenUrl}
      onOpenUrlWithBrowser={onOpenUrlWithBrowser}
      onOpenBrowserRules={vi.fn()}
      onDeleteHistory={vi.fn()}
      onEditRemark={vi.fn()}
      onCopyJson={vi.fn()}
      onCopyAiAnswer={vi.fn()}
      query=""
      selectedMemoId={null}
      onRefreshMemos={vi.fn()}
      onCloseMemoModal={vi.fn()}
      {...overrides}
    />
  );

  return { onClose, onOpenUrl, onOpenUrlWithBrowser };
}

describe("ContextMenu URL 菜单", () => {
  it("应按分组渲染链接操作与浏览器选项", () => {
    renderUrlMenu();

    expect(screen.getByRole("button", { name: "打开链接" })).toBeInTheDocument();
    expect(screen.getByText("用指定浏览器打开")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edge" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chrome" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Firefox" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "修改备注" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除历史记录" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "浏览器路由规则" })).toBeInTheDocument();
  });

  it("点击指定浏览器应传入对应标识", async () => {
    const user = userEvent.setup();
    const { onOpenUrlWithBrowser, onClose } = renderUrlMenu();

    await user.click(screen.getByRole("button", { name: "Chrome" }));

    expect(onOpenUrlWithBrowser).toHaveBeenCalledWith("https://example.com", "chrome");
    expect(onClose).toHaveBeenCalled();
  });
});
