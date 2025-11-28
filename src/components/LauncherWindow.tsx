import { useState, useEffect, useRef } from "react";
import { tauriApi } from "../api/tauri";
import type { AppInfo, FileHistoryItem } from "../types";
import { getCurrentWindow } from "@tauri-apps/api/window";

type SearchResult = {
  type: "app" | "file";
  app?: AppInfo;
  file?: FileHistoryItem;
  displayName: string;
  path: string;
};

export function LauncherWindow() {
  const [query, setQuery] = useState("");
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [filteredApps, setFilteredApps] = useState<AppInfo[]>([]);
  const [fileHistory, setFileHistory] = useState<FileHistoryItem[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<FileHistoryItem[]>([]);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Focus input when window becomes visible
  useEffect(() => {
    const window = getCurrentWindow();
    
    // Ensure window has no decorations
    window.setDecorations(false).catch(console.error);
    
    // Global keyboard listener for Escape key
    const handleGlobalKeyDown = async (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.keyCode === 27) {
        e.preventDefault();
        e.stopPropagation();
        try {
          await tauriApi.hideLauncher();
          setQuery("");
          setSelectedIndex(0);
        } catch (error) {
          console.error("Failed to hide window:", error);
        }
      }
    };
    
    // Use document with capture phase to catch Esc key early
    document.addEventListener("keydown", handleGlobalKeyDown, true);
    
    const unlisten = window.onFocusChanged(({ payload: focused }) => {
      if (focused && inputRef.current) {
        setTimeout(() => {
          inputRef.current?.focus();
        }, 100);
      }
    });

    // Also focus on mount
    setTimeout(() => {
      inputRef.current?.focus();
    }, 100);

    return () => {
      document.removeEventListener("keydown", handleGlobalKeyDown, true);
      unlisten.then((fn) => fn());
    };
  }, []);

  // Search applications and file history when query changes
  useEffect(() => {
    if (query.trim() === "") {
      setFilteredApps([]);
      setFilteredFiles([]);
      setResults([]);
      setSelectedIndex(0);
    } else {
      searchApplications(query);
      searchFileHistory(query);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Combine apps and files into results when they change
  useEffect(() => {
    const combinedResults: SearchResult[] = [
      ...filteredApps.map((app) => ({
        type: "app" as const,
        app,
        displayName: app.name,
        path: app.path,
      })),
      ...filteredFiles.map((file) => ({
        type: "file" as const,
        file,
        displayName: file.name,
        path: file.path,
      })),
    ];
    setResults(combinedResults.slice(0, 10)); // Limit to 10 results
    setSelectedIndex(0);
  }, [filteredApps, filteredFiles]);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current && selectedIndex >= 0 && results.length > 0) {
      const items = listRef.current.children;
      if (items[selectedIndex]) {
        items[selectedIndex].scrollIntoView({
          block: "nearest",
          behavior: "smooth",
        });
      }
    }
  }, [selectedIndex, results.length]);

  const loadApplications = async () => {
    try {
      setIsLoading(true);
      await new Promise<void>((resolve) => {
        setTimeout(async () => {
          try {
            const allApps = await tauriApi.scanApplications();
            setApps(allApps);
            setFilteredApps(allApps.slice(0, 10));
          } catch (error) {
            console.error("Failed to load applications:", error);
            setApps([]);
            setFilteredApps([]);
          } finally {
            setIsLoading(false);
            resolve();
          }
        }, 0);
      });
    } catch (error) {
      console.error("Failed to load applications:", error);
      setApps([]);
      setFilteredApps([]);
      setIsLoading(false);
    }
  };

  const searchApplications = async (searchQuery: string) => {
    try {
      // If apps not loaded yet, load them first
      if (apps.length === 0 && !isLoading) {
        await loadApplications();
      }
      
      const results = await tauriApi.searchApplications(searchQuery);
      setFilteredApps(results);
    } catch (error) {
      console.error("Failed to search applications:", error);
    }
  };

  const searchFileHistory = async (searchQuery: string) => {
    try {
      const results = await tauriApi.searchFileHistory(searchQuery);
      setFilteredFiles(results);
    } catch (error) {
      console.error("Failed to search file history:", error);
    }
  };

  const handleLaunch = async (result: SearchResult) => {
    try {
      if (result.type === "app" && result.app) {
        await tauriApi.launchApplication(result.app);
      } else if (result.type === "file" && result.file) {
        await tauriApi.launchFile(result.file.path);
      }
      // Hide launcher window after launch
      await tauriApi.hideLauncher();
      setQuery("");
      setSelectedIndex(0);
    } catch (error) {
      console.error("Failed to launch:", error);
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const clipboardTypes = Array.from(e.clipboardData.types);
    console.log("Clipboard types:", clipboardTypes);
    
    // Check if clipboard contains files (when copying folders/files in Windows)
    if (clipboardTypes.includes("Files")) {
      e.preventDefault();
      e.stopPropagation();
      
      const files = e.clipboardData.files;
      console.log("Files in clipboard:", files.length);
      
      if (files.length > 0) {
        // Get the first file/folder path
        // Note: In browser, we can't directly get the full path from File object
        // We need to use Tauri's clipboard API or handle it differently
        // For now, let's try to get the path from the file name and use a backend command
        
        // Try to get text representation if available
        let pathText = "";
        try {
          // Some browsers/clipboard implementations might have text representation
          pathText = e.clipboardData.getData("text/uri-list") || 
                     e.clipboardData.getData("text") ||
                     e.clipboardData.getData("text/plain");
        } catch (err) {
          console.log("Could not get text from clipboard:", err);
        }
        
        // If we have a file, we need to get its path from backend
        // Since browser File API doesn't expose full path, we'll need to use Tauri
        // Try to get path from Tauri clipboard API (Windows only)
        if (!pathText) {
          console.log("Getting path from Tauri clipboard API");
          try {
            const clipboardPath = await tauriApi.getClipboardFilePath();
            if (clipboardPath) {
              console.log("Got path from clipboard API:", clipboardPath);
              await processPastedPath(clipboardPath);
              return;
            }
          } catch (error) {
            console.error("Failed to get clipboard file path:", error);
          }
        }
        
        if (pathText) {
          console.log("Processing path from clipboard files:", pathText);
          await processPastedPath(pathText);
        } else {
          console.log("Could not get file path from clipboard");
        }
      }
      return;
    }
    
    // Try to get text from clipboard - Windows may use different formats
    let pastedText = e.clipboardData.getData("text");
    
    // If no text, try text/plain format
    if (!pastedText) {
      pastedText = e.clipboardData.getData("text/plain");
    }
    
    // Handle Windows file paths that might have quotes or be on multiple lines
    if (pastedText) {
      // Remove quotes if present
      pastedText = pastedText.replace(/^["']|["']$/g, '');
      // Take first line if multiple lines
      pastedText = pastedText.split('\n')[0].split('\r')[0];
    }
    
    console.log("Pasted text:", pastedText);
    
    // Check if pasted text looks like a file path
    const isPath = pastedText && pastedText.trim().length > 0 && (
      pastedText.includes("\\") || 
      pastedText.includes("/") || 
      pastedText.match(/^[A-Za-z]:/)
    );
    
    if (isPath) {
      e.preventDefault();
      e.stopPropagation();
      await processPastedPath(pastedText.trim());
    } else {
      console.log("Pasted text doesn't look like a path, allowing default paste behavior");
    }
  };

  const processPastedPath = async (trimmedPath: string) => {
    console.log("Processing path:", trimmedPath);
    
    // Always set the query first so user sees something
    setQuery(trimmedPath);
    
    try {
      // Check if path exists (file or folder)
      console.log("Checking if path exists...");
      const pathItem = await tauriApi.checkPathExists(trimmedPath);
      console.log("Path check result:", pathItem);
      
      if (pathItem) {
        // Path exists, add to history first
        try {
          console.log("Adding to history...");
          await tauriApi.addFileToHistory(trimmedPath);
          // Reload file history to get updated item with use_count
          const searchResults = await tauriApi.searchFileHistory(trimmedPath);
          console.log("Search results:", searchResults);
          if (searchResults.length > 0) {
            setFilteredFiles(searchResults);
          } else {
            // If not found in search, use the item we got from check
            console.log("Using pathItem from check");
            setFilteredFiles([pathItem]);
          }
        } catch (error) {
          // Ignore errors when adding to history, still show the result
          console.error("Failed to add file to history:", error);
          setFilteredFiles([pathItem]);
        }
      } else {
        // Path doesn't exist, search will still run via query change
        console.log("Path doesn't exist, but query is set for search");
      }
    } catch (error) {
      console.error("Failed to check path:", error);
      // Query is already set, search will still run
    }
  };

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (e.key === "Escape" || e.keyCode === 27) {
      e.preventDefault();
      e.stopPropagation();
      try {
        await tauriApi.hideLauncher();
        setQuery("");
        setSelectedIndex(0);
      } catch (error) {
        console.error("Failed to hide window:", error);
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        prev < results.length - 1 ? prev + 1 : prev
      );
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : 0));
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (results[selectedIndex]) {
        await handleLaunch(results[selectedIndex]);
      }
      return;
    }
  };

  return (
    <div 
      className="flex flex-col h-full items-center justify-center bg-transparent"
      tabIndex={-1}
      onKeyDown={async (e) => {
        if (e.key === "Escape" || e.keyCode === 27) {
          e.preventDefault();
          e.stopPropagation();
          try {
            await tauriApi.hideLauncher();
            setQuery("");
            setSelectedIndex(0);
          } catch (error) {
            console.error("Failed to hide window:", error);
          }
        }
      }}
    >
      {/* Main Search Container - utools style */}
      <div className="w-full max-w-2xl mx-auto px-4">
        <div className="bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden">
          {/* Search Box */}
          <div className="px-6 py-4 border-b border-gray-100">
            <div className="flex items-center gap-3">
              <svg
                className="w-5 h-5 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder="输入应用名称或粘贴文件路径..."
                className="flex-1 text-lg border-none outline-none bg-transparent placeholder-gray-400 text-gray-700"
                autoFocus
              />
            </div>
          </div>

          {/* Results List */}
          {results.length > 0 && (
            <div
              ref={listRef}
              className="max-h-96 overflow-y-auto"
            >
              {results.map((result, index) => (
                <div
                  key={`${result.type}-${result.path}-${index}`}
                  onClick={() => handleLaunch(result)}
                  className={`px-6 py-3 cursor-pointer transition-all ${
                    index === selectedIndex
                      ? "bg-blue-500 text-white"
                      : "hover:bg-gray-50 text-gray-700"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded flex items-center justify-center flex-shrink-0 ${
                      index === selectedIndex ? "bg-blue-400" : "bg-gray-200"
                    }`}>
                      {result.type === "file" ? (
                        <svg
                          className={`w-5 h-5 ${
                            index === selectedIndex ? "text-white" : "text-gray-500"
                          }`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                          />
                        </svg>
                      ) : (
                        <svg
                          className={`w-5 h-5 ${
                            index === selectedIndex ? "text-white" : "text-gray-500"
                          }`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{result.displayName}</div>
                      {result.path && (
                        <div
                          className={`text-sm truncate ${
                            index === selectedIndex ? "text-blue-100" : "text-gray-500"
                          }`}
                        >
                          {result.path}
                        </div>
                      )}
                      {result.type === "file" && result.file && (
                        <div
                          className={`text-xs ${
                            index === selectedIndex ? "text-blue-200" : "text-gray-400"
                          }`}
                        >
                          使用 {result.file.use_count} 次
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Loading or Empty State */}
          {isLoading && (
            <div className="px-6 py-8 text-center text-gray-500">
              <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-gray-400 mb-2"></div>
              <div>正在扫描应用...</div>
            </div>
          )}

          {!isLoading && results.length === 0 && query && (
            <div className="px-6 py-8 text-center text-gray-500">
              未找到匹配的应用或文件
            </div>
          )}

          {!isLoading && results.length === 0 && !query && (
            <div className="px-6 py-8 text-center text-gray-400 text-sm">
              输入关键词搜索应用，或粘贴文件路径
            </div>
          )}

          {/* Footer */}
          {results.length > 0 && (
            <div className="px-6 py-2 border-t border-gray-100 text-xs text-gray-400 flex justify-between bg-gray-50/50">
              <span>{results.length} 个结果</span>
              <span>↑↓ 选择 · Enter 打开 · Esc 关闭</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
