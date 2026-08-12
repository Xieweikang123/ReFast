/**
 * keyboardUtils 测试
 * 聚焦「选中锁定」：非交互期 Enter 仅启动用户手动选中的行
 */

import { describe, it, expect, vi } from "vitest";
import { handleKeyDown, type HandleKeyDownOptions } from "../keyboardUtils";
import type { SearchResult } from "../resultUtils";
import type { VisibleVerticalItem } from "../resultGroupUtils";

function makeEvent(key: string): React.KeyboardEvent {
  return {
    key,
    keyCode: key === "Enter" ? 13 : 0,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.KeyboardEvent;
}

function makeResult(type: SearchResult["type"], path: string, displayName?: string): SearchResult {
  return { type, displayName: displayName ?? path, path };
}

function buildOptions(overrides: Partial<HandleKeyDownOptions> = {}): HandleKeyDownOptions {
  const horizontalResults: SearchResult[] = [
    makeResult("app", "C:\\AppA.exe", "AppA"),
  ];
  const visibleVerticalItems: VisibleVerticalItem[] = [
    { kind: "result", result: makeResult("file", "C:\\docs\\a.txt", "a.txt") },
    { kind: "result", result: makeResult("file", "C:\\docs\\b.txt", "b.txt") },
  ];
  const pinnedResultRef = { current: null as SearchResult | null };
  const base: HandleKeyDownOptions = {
    e: makeEvent("Enter"),
    inputRef: { current: null },
    isHorizontalNavigationRef: { current: false },
    justJumpedToVerticalRef: { current: false },
    horizontalResultsRef: { current: horizontalResults },
    currentLoadResultsRef: { current: [] },
    queryHistoryIndexRef: { current: -1 },
    isBrowsingQueryHistoryRef: { current: false },
    query: "doc",
    contextMenu: null,
    errorMessage: null,
    isPluginListModalOpen: false,
    isMemoModalOpen: false,
    isRemarkModalOpen: false,
    pastedImageDataUrl: null,
    selectedHorizontalIndex: null,
    selectedVerticalIndex: 1,
    horizontalResults,
    visibleVerticalItems,
    isResultsInteractive: true,
    pinnedResultRef,
    setPinnedResult: vi.fn(),
    setContextMenu: vi.fn(),
    setErrorMessage: vi.fn(),
    setIsPluginListModalOpen: vi.fn(),
    setIsMemoModalOpen: vi.fn(),
    setIsRemarkModalOpen: vi.fn(),
    setEditingRemarkUrl: vi.fn(),
    setRemarkText: vi.fn(),
    setPastedImageDataUrl: vi.fn(),
    setPastedImagePath: vi.fn(),
    setSelectedHorizontalIndex: vi.fn(),
    setSelectedVerticalIndex: vi.fn(),
    setResults: vi.fn(),
    setHorizontalResults: vi.fn(),
    setVerticalResults: vi.fn(),
    setQuery: vi.fn(),
    applyQueryFromHistory: vi.fn(),
    onExpandEverything: vi.fn(),
    hideLauncherAndResetState: vi.fn(async () => {}),
    resetMemoState: vi.fn(),
    handleLaunch: vi.fn(async () => {}),
  };
  return { ...base, ...overrides };
}

describe("handleKeyDown 选中锁定", () => {
  it("非交互期未选中锁定时，Enter 不启动任何结果", async () => {
    const handleLaunch = vi.fn(async () => {});
    const options = buildOptions({
      isResultsInteractive: false,
      pinnedResultRef: { current: null },
      handleLaunch,
    });
    await handleKeyDown(options);
    expect(handleLaunch).not.toHaveBeenCalled();
  });

  it("非交互期选中锁定的行与当前选中一致时，Enter 直接启动", async () => {
    const handleLaunch = vi.fn(async () => {});
    const pinned = visibleItemResult(0);
    const options = buildOptions({
      isResultsInteractive: false,
      selectedVerticalIndex: 0,
      pinnedResultRef: { current: pinned },
      handleLaunch,
    });
    await handleKeyDown(options);
    expect(handleLaunch).toHaveBeenCalledTimes(1);
    expect(handleLaunch).toHaveBeenCalledWith(pinned);
  });

  it("非交互期锁定行与当前选中不一致时，Enter 被阻止", async () => {
    const handleLaunch = vi.fn(async () => {});
    const options = buildOptions({
      isResultsInteractive: false,
      selectedVerticalIndex: 0,
      pinnedResultRef: { current: makeResult("file", "C:\\docs\\other.txt") },
      handleLaunch,
    });
    await handleKeyDown(options);
    expect(handleLaunch).not.toHaveBeenCalled();
  });

  it("交互期正常启动当前选中，无需锁定", async () => {
    const handleLaunch = vi.fn(async () => {});
    const target = visibleItemResult(1);
    const options = buildOptions({
      isResultsInteractive: true,
      pinnedResultRef: { current: null },
      handleLaunch,
    });
    await handleKeyDown(options);
    expect(handleLaunch).toHaveBeenCalledTimes(1);
    expect(handleLaunch).toHaveBeenCalledWith(target);
  });

  it("导航键会记录选中锁定", async () => {
    const setPinnedResult = vi.fn();
    const horizontalResults = [
      makeResult("app", "C:\\AppA.exe", "AppA"),
      makeResult("app", "C:\\AppB.exe", "AppB"),
    ];
    const options = buildOptions({
      e: makeEvent("ArrowLeft"),
      horizontalResults,
      horizontalResultsRef: { current: horizontalResults },
      selectedHorizontalIndex: null,
      selectedVerticalIndex: null,
      isResultsInteractive: true,
      setPinnedResult,
    });
    await handleKeyDown(options);
    // 横向导航到最后一个（ArrowLeft 在无选中时选中最后一个）
    expect(setPinnedResult).toHaveBeenCalledWith(horizontalResults[1]);
  });
});

function visibleItemResult(index: number): SearchResult {
  const file = makeResult("file", "C:\\docs\\a.txt", "a.txt");
  const item: VisibleVerticalItem = { kind: "result", result: file };
  if (index === 0) return item.result;
  return makeResult("file", "C:\\docs\\b.txt", "b.txt");
}
