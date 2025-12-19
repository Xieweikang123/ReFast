import { useState, useEffect, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import { tauriApi } from "../api/tauri";
import type { ClipboardItem } from "../types";

export function ClipboardWindow() {
  const [clipboardItems, setClipboardItems] = useState<ClipboardItem[]>([]);
  const [filteredItems, setFilteredItems] = useState<ClipboardItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [contentTypeFilter, setContentTypeFilter] = useState<"all" | "text" | "image">("all");
  const [selectedItem, setSelectedItem] = useState<ClipboardItem | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [imageDataUrls, setImageDataUrls] = useState<Map<string, string>>(new Map());
  const [showSettings, setShowSettings] = useState(false);
  const [maxItems, setMaxItems] = useState<number>(100);

  const loadClipboardItems = async () => {
    try {
      const items = await tauriApi.getAllClipboardItems();
      setClipboardItems(items);
      setFilteredItems(items);
      
      // 清理不再存在的图片URLs
      const currentImagePaths = new Set(
        items.filter(item => item.content_type === "image").map(item => item.content)
      );
      imageDataUrls.forEach((url, path) => {
        if (!currentImagePaths.has(path)) {
          URL.revokeObjectURL(url);
          imageDataUrls.delete(path);
        }
      });
      setImageDataUrls(new Map(imageDataUrls));
    } catch (error) {
      console.error("Failed to load clipboard items:", error);
    }
  };

  // 懒加载图片数据
  const loadImageData = async (imagePath: string) => {
    if (imageDataUrls.has(imagePath)) {
      return; // 已经加载过了
    }

    try {
      const imageData = await tauriApi.getClipboardImageData(imagePath);
      // 确保 imageData 是 Uint8Array
      const uint8Array = imageData instanceof Uint8Array 
        ? imageData 
        : new Uint8Array(imageData as any);
      const blob = new Blob([uint8Array], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      setImageDataUrls(prev => new Map(prev).set(imagePath, url));
    } catch (error) {
      console.error("Failed to load image:", error);
    }
  };

  useEffect(() => {
    loadClipboardItems();
    loadSettings();
    
    // 清理函数：组件卸载时释放所有 blob URLs
    return () => {
      imageDataUrls.forEach(url => URL.revokeObjectURL(url));
    };
  }, []);

  const loadSettings = async () => {
    try {
      const settings = await tauriApi.getSettings();
      setMaxItems(settings.clipboard_max_items ?? 100);
    } catch (error) {
      console.error("Failed to load settings:", error);
    }
  };

  const saveMaxItems = async (value: number) => {
    try {
      const settings = await tauriApi.getSettings();
      await tauriApi.saveSettings({
        ...settings,
        clipboard_max_items: value,
      });
      setMaxItems(value);
    } catch (error) {
      console.error("Failed to save settings:", error);
    }
  };

  // 当选中图片项时，自动加载图片数据
  useEffect(() => {
    if (selectedItem?.content_type === "image") {
      loadImageData(selectedItem.content);
    }
  }, [selectedItem]);

  // 自动加载列表中前面的图片缩略图（优化用户体验）
  useEffect(() => {
    const imagesToLoad = filteredItems
      .filter(item => item.content_type === "image")
      .slice(0, 10); // 只加载前10个
    
    imagesToLoad.forEach(item => {
      if (!imageDataUrls.has(item.content)) {
        loadImageData(item.content);
      }
    });
  }, [filteredItems]);

  useEffect(() => {
    let filtered = clipboardItems;

    // 按内容类型筛选
    if (contentTypeFilter !== "all") {
      filtered = filtered.filter((item) => item.content_type === contentTypeFilter);
    }

    // 按搜索关键词筛选
    if (searchQuery.trim() !== "") {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((item) =>
        item.content.toLowerCase().includes(query)
      );
    }

    setFilteredItems(filtered);
  }, [searchQuery, contentTypeFilter, clipboardItems]);

  const handleClose = useCallback(async () => {
    const window = getCurrentWindow();
    await window.close();
  }, []);

  const handleCopyToClipboard = async (item: ClipboardItem) => {
    try {
      if (item.content_type === "image") {
        // 复制图片到剪切板
        await tauriApi.copyImageToClipboard(item.content);
      } else {
        // 复制文本到剪切板
        await navigator.clipboard.writeText(item.content);
      }
    } catch (error) {
      console.error("Failed to copy to clipboard:", error);
    }
  };

  const handleEdit = (item: ClipboardItem) => {
    setSelectedItem(item);
    setEditContent(item.content);
    setIsEditing(true);
  };

  const handleSaveEdit = async () => {
    if (!selectedItem) return;
    
    try {
      const updated = await tauriApi.updateClipboardItem(
        selectedItem.id,
        editContent
      );
      setClipboardItems((items) =>
        items.map((item) => (item.id === updated.id ? updated : item))
      );
      setIsEditing(false);
      setSelectedItem(null);
      setEditContent("");
    } catch (error) {
      console.error("Failed to update clipboard item:", error);
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setSelectedItem(null);
    setEditContent("");
  };

  const handleToggleFavorite = async (item: ClipboardItem) => {
    try {
      const updated = await tauriApi.toggleFavoriteClipboardItem(item.id);
      setClipboardItems((items) =>
        items.map((i) => (i.id === updated.id ? updated : i))
      );
    } catch (error) {
      console.error("Failed to toggle favorite:", error);
    }
  };

  const handleDelete = async (item: ClipboardItem) => {
    const confirmed = await confirm(`确定要删除这条剪切板记录吗？`, {
      title: "确认删除",
      kind: "warning",
    });

    if (!confirmed) return;

    try {
      await tauriApi.deleteClipboardItem(item.id);
      setClipboardItems((items) => items.filter((i) => i.id !== item.id));
      if (selectedItem?.id === item.id) {
        setSelectedItem(null);
        setIsEditing(false);
      }
    } catch (error) {
      console.error("Failed to delete clipboard item:", error);
    }
  };

  const handleClearHistory = async () => {
    const confirmed = await confirm(
      "确定要清空所有非收藏的剪切板历史吗？此操作不可恢复。",
      {
        title: "确认清空",
        kind: "warning",
      }
    );

    if (!confirmed) return;

    try {
      await tauriApi.clearClipboardHistory();
      await loadClipboardItems();
      setSelectedItem(null);
      setIsEditing(false);
    } catch (error) {
      console.error("Failed to clear clipboard history:", error);
    }
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}天前`;
    } else if (hours > 0) {
      return `${hours}小时前`;
    } else if (minutes > 0) {
      return `${minutes}分钟前`;
    } else {
      return "刚刚";
    }
  };

  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.keyCode === 27) {
        e.preventDefault();
        e.stopPropagation();
        
        if (isEditing) {
          handleCancelEdit();
        } else if (selectedItem) {
          setSelectedItem(null);
        } else {
          await handleClose();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isEditing, selectedItem, handleClose]);

  return (
    <div className="h-screen w-screen flex bg-gray-50">
      {/* Left Panel - List */}
      <div className="w-2/5 border-r border-gray-200 bg-white flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-gray-800">剪切板历史</h2>
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded transition-colors"
              title="设置"
            >
              ⚙️
            </button>
          </div>
          
          {/* Search Box */}
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索剪切板内容..."
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          />
        </div>

        {/* Filter Buttons */}
        <div className="p-3 border-b border-gray-200 flex gap-2">
          <button
            onClick={() => setContentTypeFilter("all")}
            className={`flex-1 px-3 py-1.5 text-sm rounded transition-colors border ${
              contentTypeFilter === "all"
                ? "bg-blue-500 text-white border-blue-500"
                : "text-gray-600 hover:bg-gray-50 border-gray-200"
            }`}
          >
            全部
          </button>
          <button
            onClick={() => setContentTypeFilter("text")}
            className={`flex-1 px-3 py-1.5 text-sm rounded transition-colors border ${
              contentTypeFilter === "text"
                ? "bg-blue-500 text-white border-blue-500"
                : "text-gray-600 hover:bg-gray-50 border-gray-200"
            }`}
          >
            文字
          </button>
          <button
            onClick={() => setContentTypeFilter("image")}
            className={`flex-1 px-3 py-1.5 text-sm rounded transition-colors border ${
              contentTypeFilter === "image"
                ? "bg-blue-500 text-white border-blue-500"
                : "text-gray-600 hover:bg-gray-50 border-gray-200"
            }`}
          >
            图片
          </button>
        </div>

        {/* Settings Panel */}
        {showSettings && (
          <div className="p-3 border-b border-gray-200 bg-gray-50">
            <div className="mb-2">
              <label className="block text-xs font-medium text-gray-700 mb-1">
                最大保存数量
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  max="10000"
                  value={maxItems}
                  onChange={(e) => {
                    const value = parseInt(e.target.value, 10) || 0;
                    setMaxItems(value);
                  }}
                  onBlur={(e) => {
                    const value = parseInt(e.target.value, 10) || 0;
                    saveMaxItems(value);
                  }}
                  className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-xs text-gray-500">条</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                超过此数量时自动删除最旧记录（0=不限制，收藏不受影响）
              </p>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="p-3 border-b border-gray-200 flex gap-2">
          <button
            onClick={loadClipboardItems}
            className="flex-1 px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-50 rounded transition-colors border border-blue-200"
          >
            刷新
          </button>
          <button
            onClick={handleClearHistory}
            className="flex-1 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded transition-colors border border-red-200"
          >
            清空历史
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {filteredItems.length === 0 ? (
            <div className="p-4 text-sm text-gray-500 text-center">
              {searchQuery
                ? "没有找到匹配的内容"
                : contentTypeFilter === "all"
                ? "还没有剪切板历史"
                : contentTypeFilter === "text"
                ? "没有文字类型的记录"
                : "没有图片类型的记录"}
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {filteredItems.map((item) => (
                <div
                  key={item.id}
                  onClick={() => setSelectedItem(item)}
                  className={`p-3 cursor-pointer transition-colors hover:bg-gray-50 ${
                    selectedItem?.id === item.id ? "bg-blue-50" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="text-xs text-gray-500">
                        {formatDate(item.created_at)}
                      </span>
                      {item.is_favorite && (
                        <span className="text-yellow-500 text-sm" title="收藏">
                          ★
                        </span>
                      )}
                    </div>
                    <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600 flex-shrink-0">
                      {item.content_type}
                    </span>
                  </div>
                  {item.content_type === "image" ? (
                    <div className="flex items-center gap-2">
                      {imageDataUrls.has(item.content) ? (
                        <img 
                          src={imageDataUrls.get(item.content)} 
                          alt="clipboard" 
                          className="w-10 h-10 object-cover rounded"
                        />
                      ) : (
                        <div 
                          className="w-10 h-10 bg-gray-100 rounded flex items-center justify-center text-gray-400 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            loadImageData(item.content);
                          }}
                        >
                          📷
                        </div>
                      )}
                      <span className="text-sm text-gray-600">图片</span>
                    </div>
                  ) : (
                    <div className="text-sm text-gray-800 truncate">
                      {item.content || "(空内容)"}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right Panel - Detail */}
      <div className="flex-1 flex flex-col bg-white min-w-0 overflow-hidden">
        {selectedItem ? (
          <>
            {/* Detail Header */}
            <div className="p-4 border-b border-gray-200 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h3 className="text-lg font-semibold text-gray-800">
                  {isEditing ? "编辑内容" : "详细内容"}
                </h3>
                <span className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-600">
                  {selectedItem.content_type}
                </span>
              </div>
              <div className="flex gap-2">
                {isEditing ? (
                  <>
                    <button
                      onClick={handleSaveEdit}
                      className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
                    >
                      保存
                    </button>
                    <button
                      onClick={handleCancelEdit}
                      className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded transition-colors"
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    {selectedItem.content_type === "text" && (
                      <button
                        onClick={() => handleEdit(selectedItem)}
                        className="px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-50 rounded transition-colors"
                      >
                        编辑
                      </button>
                    )}
                    <button
                      onClick={() => handleToggleFavorite(selectedItem)}
                      className={`px-3 py-1.5 text-sm rounded transition-colors ${
                        selectedItem.is_favorite
                          ? "text-yellow-600 hover:bg-yellow-50"
                          : "text-gray-600 hover:bg-gray-100"
                      }`}
                    >
                      {selectedItem.is_favorite ? "取消收藏" : "收藏"}
                    </button>
                    <button
                      onClick={() => handleCopyToClipboard(selectedItem)}
                      className="px-3 py-1.5 text-sm text-green-600 hover:bg-green-50 rounded transition-colors"
                    >
                      复制
                    </button>
                    <button
                      onClick={() => handleDelete(selectedItem)}
                      className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded transition-colors"
                    >
                      删除
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Detail Content */}
            <div className="flex-1 overflow-y-auto p-4 min-h-0">
              {isEditing ? (
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  className="w-full h-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none font-mono text-sm"
                  placeholder="输入内容..."
                />
              ) : (
                <div className="w-full">
                  <div className="mb-3 text-xs text-gray-500 flex-shrink-0">
                    创建时间: {new Date(selectedItem.created_at * 1000).toLocaleString()}
                  </div>
                  {selectedItem.content_type === "image" ? (
                    <div className="flex items-center justify-center min-h-[calc(100%-2rem)]">
                      {imageDataUrls.has(selectedItem.content) ? (
                        <img 
                          src={imageDataUrls.get(selectedItem.content)} 
                          alt="clipboard" 
                          className="max-w-full max-h-full object-contain rounded-lg shadow-lg"
                        />
                      ) : (
                        <div className="text-gray-400">加载图片中...</div>
                      )}
                    </div>
                  ) : (
                    <div className="bg-gray-50 rounded-lg p-3">
                      <pre className="whitespace-pre-wrap break-words font-mono text-sm text-gray-800 m-0">
                        {selectedItem.content || "(空内容)"}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            <div className="text-center">
              <div className="text-4xl mb-2">📋</div>
              <div className="text-sm">选择一条剪切板记录查看详情</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
