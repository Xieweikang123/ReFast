import { describe, it, expect } from "vitest";
import { computeCombinedResults } from "../combineResultsUtils";
import type { CombineResultsOptions } from "../combineResultsUtils";
import type { FileHistoryItem } from "../../types";

function emptyRefs(): CombineResultsOptions["extractedFileIconsRef"] {
  return { current: new Map() };
}

function baseOptions(
  overrides: Partial<CombineResultsOptions> = {}
): CombineResultsOptions {
  return {
    query: "gitlite",
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
    extractedFileIconsRef: emptyRefs(),
    ...overrides,
  };
}

describe("computeCombinedResults 同名去重", () => {
  it("同名 exe 历史存在时仍保留已打开过的文件夹", () => {
    const exe: FileHistoryItem = {
      path: "D:\\project\\GitLite\\src-tauri\\target\\release\\GitLite.exe",
      name: "GitLite.exe",
      last_used: 1_787_705_491,
      use_count: 21,
      is_folder: false,
    };
    const folder: FileHistoryItem = {
      path: "D:\\project\\GitLite",
      name: "GitLite",
      last_used: 1_787_712_163,
      use_count: 6,
      is_folder: true,
    };

    const results = computeCombinedResults(
      baseOptions({
        filteredFiles: [exe, folder],
        openHistory: {
          [exe.path]: exe.last_used,
          [folder.path]: folder.last_used,
        },
      })
    );

    const paths = results.map((r) => r.path.toLowerCase());
    expect(paths).toContain(exe.path.toLowerCase());
    expect(paths).toContain(folder.path.toLowerCase());
    expect(results.some((r) => r.type === "file" && r.path === folder.path)).toBe(
      true
    );
  });

  it("同名应用存在时仍保留 Everything 文件夹，但丢掉同名文档", () => {
    const results = computeCombinedResults(
      baseOptions({
        filteredApps: [
          {
            name: "GitLite",
            path: "C:\\Program Files\\GitLite\\GitLite.exe",
          },
        ],
        everythingResults: [
          {
            path: "D:\\project\\GitLite",
            name: "GitLite",
            is_folder: true,
          },
          {
            path: "D:\\docs\\GitLite",
            name: "GitLite",
            is_folder: false,
          },
        ],
      })
    );

    const paths = results.map((r) => r.path.toLowerCase());
    expect(paths).toContain("d:\\project\\gitlite");
    expect(paths).not.toContain("d:\\docs\\gitlite");
  });
});

describe("computeCombinedResults 搜索引擎前缀", () => {
  const engines = [
    { prefix: "g ", url: "https://google.com/search?q={query}", name: "Google" },
  ];

  it("默认只保留网页搜索结果", () => {
    const results = computeCombinedResults(
      baseOptions({
        query: "g chrome",
        searchEngines: engines,
        filteredApps: [
          { name: "Chrome", path: "C:\\Chrome\\chrome.exe" },
        ],
      })
    );
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("search");
  });

  it("仍搜本地时保留网页搜索并合并应用", () => {
    const results = computeCombinedResults(
      baseOptions({
        query: "g chrome",
        searchEngines: engines,
        includeLocalWithSearchEngine: true,
        filteredApps: [
          { name: "Chrome", path: "C:\\Chrome\\chrome.exe" },
        ],
      })
    );
    expect(results[0].type).toBe("search");
    expect(results.some((r) => r.type === "app")).toBe(true);
  });
});
