import { useState, useEffect, useCallback, useRef } from "react";
import { tauriApi } from "../api/tauri";
import { listen } from "@tauri-apps/api/event";
import type { FileHistoryItem } from "../types";
import { formatFullDateTime } from "../utils/dateUtils";

interface ShortcutsConfigProps {
  isOpen?: boolean;
  onClose: () => void;
}

export function ShortcutsConfig({ onClose }: ShortcutsConfigProps) {
  const [fileHistory, setFileHistory] = useState<FileHistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const isLoadingRef = useRef(false);

  const loadFileHistory = useCallback(async () => {
    const startTime = performance.now();
    
    // Prevent concurrent loads using ref
    if (isLoadingRef.current) {
      console.log("[前端] ShortcutsConfig.loadFileHistory: Load already in progress, skipping...");
      return;
    }
    
    try {
      isLoadingRef.current = true;
      setIsLoading(true);
      console.log("[前端] ShortcutsConfig.loadFileHistory: START - Calling getAllFileHistory...");
      const data = await tauriApi.getAllFileHistory();
      const elapsed = performance.now() - startTime;
      console.log(`[前端] ShortcutsConfig.loadFileHistory: SUCCESS - Received ${data.length} items (took ${elapsed.toFixed(2)}ms)`);
      setFileHistory(data);
    } catch (error) {
      const elapsed = performance.now() - startTime;
      console.error(`[前端] ShortcutsConfig.loadFileHistory: ERROR after ${elapsed.toFixed(2)}ms:`, error);
      setFileHistory([]); // Set empty array on error
    } finally {
      isLoadingRef.current = false;
      setIsLoading(false);
      const elapsed = performance.now() - startTime;
      console.log(`[前端] ShortcutsConfig.loadFileHistory: END (total time: ${elapsed.toFixed(2)}ms)`);
    }
  }, []); // No dependencies - stable function

  useEffect(() => {
    let unlistenEvent: (() => void) | null = null;
    const mountTime = performance.now();
    
    // 【关键】组件挂载时，无论如何先主动加载一次数据
    // 这解决了"窗口重建"导致错过事件的问题（竞态条件）
    console.log("[前端] ShortcutsConfig.useEffect: Component mounted, loading data immediately...");
    loadFileHistory();
    
    // 监听后端刷新事件（作为补充，处理"窗口已存在但被重新聚焦"的情况）
    const setupEventListener = async () => {
      const listenerSetupStart = performance.now();
      console.log("[前端] ShortcutsConfig.useEffect: Setting up event listener...");
      try {
        const unlisten = await listen("shortcuts-config:refresh", () => {
          const eventReceivedTime = performance.now();
          console.log(`[前端] ShortcutsConfig.useEffect: Received shortcuts-config:refresh event (${(eventReceivedTime - mountTime).toFixed(2)}ms after mount), reloading data...`);
          // 直接加载，不需要延迟（组件已经挂载好了）
          loadFileHistory();
        });
        unlistenEvent = unlisten;
        const listenerSetupTime = performance.now() - listenerSetupStart;
        console.log(`[前端] ShortcutsConfig.useEffect: Event listener registered successfully (took ${listenerSetupTime.toFixed(2)}ms)`);
      } catch (error) {
        const listenerSetupTime = performance.now() - listenerSetupStart;
        console.error(`[前端] ShortcutsConfig.useEffect: ERROR setting up event listener (took ${listenerSetupTime.toFixed(2)}ms):`, error);
      }
    };
    
    setupEventListener();
    
    // Component cleanup
    return () => {
      console.log("[前端] ShortcutsConfig.useEffect: Component unmounting, cleaning up...");
      if (unlistenEvent) {
        unlistenEvent();
        console.log("[前端] ShortcutsConfig.useEffect: Event listener unregistered");
      }
      isLoadingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  const handleAdd = async () => {
    if (!newName.trim() || !newPath.trim()) {
      alert("请输入名称和路径");
      return;
    }

    try {
      // Add to file history
      await tauriApi.addFileToHistory(newPath.trim());
      // Update name if different from default
      const history = await tauriApi.getAllFileHistory();
      const item = history.find(h => h.path === newPath.trim());
      if (item && item.name !== newName.trim()) {
        await tauriApi.updateFileHistoryName(newPath.trim(), newName.trim());
      }
      setNewName("");
      setNewPath("");
      setShowAddForm(false);
      await loadFileHistory();
    } catch (error) {
      console.error("Failed to add file history:", error);
      alert(`添加失败: ${error}`);
    }
  };

  const handleUpdate = async (path: string) => {
    if (!editName.trim()) {
      alert("请输入名称");
      return;
    }

    try {
      await tauriApi.updateFileHistoryName(path, editName.trim());
      setEditingPath(null);
      setEditName("");
      // Reload after a short delay to ensure backend has saved
      setTimeout(() => {
        loadFileHistory();
      }, 100);
    } catch (error) {
      console.error("Failed to update file history:", error);
      alert(`更新失败: ${error}`);
    }
  };

  const handleDelete = async (path: string) => {
    if (!confirm("确定要删除这个文件历史记录吗？")) {
      return;
    }

    try {
      await tauriApi.deleteFileHistory(path);
      // Reload after a short delay to ensure backend has saved
      setTimeout(() => {
        loadFileHistory();
      }, 100);
    } catch (error) {
      console.error("Failed to delete file history:", error);
      alert(`删除失败: ${error}`);
    }
  };

  const startEdit = (item: FileHistoryItem) => {
    setEditingPath(item.path);
    setEditName(item.name);
  };

  const cancelEdit = () => {
    setEditingPath(null);
    setEditName("");
  };

  const handleExport = async () => {
    try {
      if (fileHistory.length === 0) {
        alert("没有数据可导出");
        return;
      }

      // 生成导出数据
      const exportData = {
        version: "1.0",
        export_date: new Date().toISOString(),
        items: fileHistory.map(item => ({
          name: item.name,
          path: item.path,
          last_used: item.last_used,
          use_count: item.use_count,
        })),
      };

      const jsonContent = JSON.stringify(exportData, null, 2);
      const blob = new Blob([jsonContent], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      
      // 创建下载链接
      const filename = `历史访问_${new Date().toISOString().split('T')[0]}.json`;
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      // 清理 URL 对象
      URL.revokeObjectURL(url);
      
      alert("导出成功！");
    } catch (error) {
      console.error("导出失败:", error);
      alert(`导出失败: ${error}`);
    }
  };

  // ESC 键处理：如果在编辑或添加状态，先取消编辑/表单；否则关闭窗口
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.keyCode === 27) {
        console.log("[前端] ShortcutsConfig: ESC key detected, editingPath:", editingPath, "showAddForm:", showAddForm);
        
        // 如果正在编辑，先取消编辑
        if (editingPath !== null) {
          console.log("[前端] ShortcutsConfig: Cancelling edit mode");
          e.preventDefault();
          e.stopPropagation();
          cancelEdit();
          return;
        }
        
        // 如果正在添加表单，先关闭表单
        if (showAddForm) {
          console.log("[前端] ShortcutsConfig: Closing add form");
          e.preventDefault();
          e.stopPropagation();
          setShowAddForm(false);
          setNewName("");
          setNewPath("");
          return;
        }
        
        // 否则关闭窗口
        console.log("[前端] ShortcutsConfig: Closing window");
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        onClose();
      }
    };

    // 使用捕获阶段，确保能够捕获所有 ESC 键事件
    window.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingPath, showAddForm]);

  return (
    <div
      className="h-full w-full flex flex-col bg-white"
      style={{ minHeight: 0 }}
      tabIndex={-1}
    >
      {/* Header - Fixed */}
      <div className="flex items-center justify-between p-6 border-b border-gray-200 flex-shrink-0">
        <h3 className="text-lg font-semibold text-gray-800">历史访问</h3>
        <button
          onClick={handleExport}
          disabled={isLoading || fileHistory.length === 0}
          className="px-4 py-2 text-sm bg-green-500 text-white rounded hover:bg-green-600 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
          title="导出配置"
        >
          导出
        </button>
      </div>

      {/* Content - Scrollable */}
      <div className="flex-1 overflow-y-auto p-6" style={{ minHeight: 0 }}>
        {isLoading ? (
          <div className="text-center py-8">
            <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-gray-400 mb-2"></div>
            <div className="text-gray-500">加载中...</div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Add New Button */}
            {!showAddForm && (
              <button
                onClick={() => setShowAddForm(true)}
                className="w-full px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
              >
                + 添加文件/文件夹
              </button>
            )}

            {/* Add Form */}
            {showAddForm && (
              <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                <h4 className="font-medium mb-3">添加文件/文件夹</h4>
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      名称 *
                    </label>
                    <input
                      type="text"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="例如：我的文档"
                      className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      路径 *
                    </label>
                    <input
                      type="text"
                      value={newPath}
                      onChange={(e) => setNewPath(e.target.value)}
                      placeholder="例如：C:\\Users\\Username\\Documents"
                      className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleAdd}
                      className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
                    >
                      添加
                    </button>
                    <button
                      onClick={() => {
                        setShowAddForm(false);
                        setNewName("");
                        setNewPath("");
                      }}
                      className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition-colors"
                    >
                      取消
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* File History List */}
            {fileHistory.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                暂无文件历史记录
              </div>
            ) : (
              <div className="space-y-2">
                {fileHistory.map((item) => (
                  <div
                    key={item.path}
                    className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50 transition-colors"
                  >
                    {editingPath === item.path ? (
                      <div className="space-y-3">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            名称 *
                          </label>
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            路径（只读）
                          </label>
                          <input
                            type="text"
                            value={item.path}
                            disabled
                            className="w-full px-3 py-2 border border-gray-300 rounded bg-gray-100 text-gray-600 cursor-not-allowed"
                          />
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleUpdate(item.path)}
                            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
                          >
                            保存
                          </button>
                          <button
                            onClick={cancelEdit}
                            className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition-colors"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-gray-800 truncate">
                            {item.name}
                          </div>
                          <div className="text-sm text-gray-500 truncate mt-1">
                            {item.path}
                          </div>
                          <div className="text-xs text-gray-400 mt-1">
                            使用 {item.use_count} 次 · 最后使用：{formatFullDateTime(item.last_used)}
                          </div>
                        </div>
                        <div className="flex gap-2 ml-4">
                          <button
                            onClick={() => startEdit(item)}
                            className="px-3 py-1 text-sm bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition-colors"
                          >
                            编辑
                          </button>
                          <button
                            onClick={() => handleDelete(item.path)}
                            className="px-3 py-1 text-sm bg-red-500 text-white rounded hover:bg-red-600 transition-colors"
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
