import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { SearchResultArea } from "../SearchResultArea";
import type { SearchResult } from "../../utils/resultUtils";

function renderArea(
  overrides: Partial<ComponentProps<typeof SearchResultArea>> = {}
) {
  const props: ComponentProps<typeof SearchResultArea> = {
    showAiAnswer: false,
    isAiLoading: false,
    aiAnswer: null,
    setAiAnswer: vi.fn(),
    setShowAiAnswer: vi.fn(),
    results: [],
    query: "虚",
    isSearchingEverything: false,
    isEverythingAvailable: true,
    everythingTotalCount: null,
    everythingCurrentCount: 0,
    listRef: { current: null },
    horizontalResults: [],
    selectedHorizontalIndex: null,
    selectedVerticalIndex: null,
    resultStyle: "compact",
    apps: [],
    filteredApps: [],
    launchingAppPath: null,
    pastedImagePath: null,
    pastedImageDataUrl: null,
    openHistory: {},
    urlRemarks: {},
    getPluginIcon: () => <span />,
    handleLaunch: vi.fn(async () => {}),
    handleContextMenu: vi.fn(),
    handleSaveImageToDownloads: vi.fn(async () => {}),
    horizontalScrollContainerRef: { current: null },
    isInteractive: true,
    isSearching: false,
    searchStatus: { primary: "搜索中", items: [] },
    onExpandEverything: vi.fn(),
    visibleVerticalItems: [],
    searchHint: {
      message: "单字未搜索磁盘文件，避免结果过多",
      actionLabel: "搜索 Everything",
      testId: "search-everything-now-button",
      onAction: vi.fn(),
    },
    ...overrides,
  };
  return render(<SearchResultArea {...props} />);
}

describe("SearchResultArea 搜索提示", () => {
  it("显示提示并支持点击手动搜索", async () => {
    const onAction = vi.fn();
    renderArea({
      searchHint: {
        message: "单字未搜索磁盘文件，避免结果过多",
        actionLabel: "搜索 Everything",
        testId: "search-everything-now-button",
        onAction,
      },
    });

    expect(screen.getByText("单字未搜索磁盘文件，避免结果过多")).toBeTruthy();
    await userEvent.click(screen.getByTestId("search-everything-now-button"));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("未开启提示时不渲染按钮", () => {
    renderArea({ searchHint: null });
    expect(screen.queryByTestId("search-everything-now-button")).toBeNull();
  });

  it("有本地结果时仍显示提示", () => {
    const result: SearchResult = {
      type: "app",
      displayName: "Hyper-V",
      path: "C:\\Windows\\System32\\vmconnect.exe",
    };
    renderArea({
      results: [result],
      visibleVerticalItems: [{ kind: "result", result }],
    });
    expect(screen.getByTestId("search-everything-now-button")).toBeTruthy();
  });

  it("网页搜索提示可点仍搜本地", async () => {
    const onAction = vi.fn();
    renderArea({
      query: "g chrome",
      searchHint: {
        message: "已进入网页搜索，本地结果已隐藏",
        actionLabel: "仍搜本地",
        testId: "include-local-with-search-engine-button",
        onAction,
      },
    });
    expect(screen.getByText("已进入网页搜索，本地结果已隐藏")).toBeTruthy();
    await userEvent.click(
      screen.getByTestId("include-local-with-search-engine-button")
    );
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("截断提示放在结果列表末尾", () => {
    const result: SearchResult = {
      type: "everything",
      displayName: "report.pdf",
      path: "C:\\docs\\report.pdf",
    };
    renderArea({
      query: "虚拟",
      results: [result],
      visibleVerticalItems: [{ kind: "result", result }],
      searchHint: {
        message: "磁盘共 303,440 条，启动器只展示前 40",
        actionLabel: "打开完整搜索",
        testId: "open-everything-window-button",
        placement: "bottom",
        onAction: vi.fn(),
      },
    });
    const button = screen.getByTestId("open-everything-window-button");
    const list = document.querySelector(".results-list-scroll");
    expect(list).toBeTruthy();
    expect(list?.contains(button)).toBe(true);
    expect(
      screen.queryByText("磁盘共 303,440 条，启动器只展示前 40")
    ).toBeTruthy();
  });
});
