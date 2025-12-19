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
  const [tempMaxItems, setTempMaxItems] = useState<number>(100);

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
      const value = settings.clipboard_max_items ?? 100;
      setMaxItems(value);
      setTempMaxItems(value);
    } catch (error) {
      console.error("Failed to load settings:", error);
    }
  };

  const saveMaxItems = async () => {
    try {
      const settings = await tauriApi.getSettings();
      await tauriApi.saveSettings({
        ...settings,
        clipboard_max_items: tempMaxItems,
      });
      setMaxItems(tempMaxItems);
    } catch (error) {
      console.error("Failed to save settings:", error);
    }
  };

  // 当打开设置面板时，同步临时值
  useEffect(() => {
    if (showSettings) {
      setTempMaxItems(maxItems);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSettings]);

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
      // 如果当前选中的item就是被更新的item，同步更新selectedItem
      if (selectedItem?.id === updated.id) {
        setSelectedItem(updated);
      }
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
    <div className="h-screen w-screen flex bg-gradient-to-br from-gray-50 via-white to-gray-50">
      {/* Left Panel - List */}
      <div className="w-2/5 border-r border-gray-200/60 bg-white/80 backdrop-blur-sm flex flex-col shadow-lg">
        {/* Header */}
        <div className="border-b border-gray-200/60 bg-gradient-to-r from-white to-gray-50/50">
          <div className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-md">
                  <span className="text-white text-lg">📋</span>
                </div>
                <h2 className="text-xl font-bold bg-gradient-to-r from-gray-800 to-gray-600 bg-clip-text text-transparent">
                  剪切板历史
                </h2>
              </div>
              <button
                onClick={() => setShowSettings(!showSettings)}
                className={`px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-all duration-200 ${
                  showSettings ? "bg-blue-50 text-blue-600" : ""
                }`}
                title="设置"
              >
                <span className="text-base">⚙️</span>
              </button>
            </div>
            
            {/* Search Box */}
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索剪切板内容..."
                className="w-full px-4 py-2.5 pl-10 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-400 text-sm bg-white/80 shadow-sm transition-all duration-200 placeholder:text-gray-400"
              />
              <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 text-sm">🔍</span>
            </div>
          </div>

          {/* Settings Panel */}
          {showSettings && (
            <div className="px-5 pb-4 border-t border-gray-200/40 bg-gradient-to-br from-blue-50/50 to-indigo-50/30 backdrop-blur-sm">
              <div className="pt-4">
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  最大保存数量
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    max="10000"
                    value={tempMaxItems}
                    onChange={(e) => {
                      const value = parseInt(e.target.value, 10) || 0;
                      setTempMaxItems(value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        saveMaxItems();
                      }
                    }}
                    className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-400 bg-white shadow-sm"
                  />
                  <span className="text-sm text-gray-600 font-medium">条</span>
                  <button
                    onClick={saveMaxItems}
                    disabled={tempMaxItems === maxItems}
                    className="px-3 py-2 text-xs font-medium bg-gradient-to-r from-blue-500 to-indigo-600 text-white rounded-lg hover:from-blue-600 hover:to-indigo-700 transition-all duration-200 shadow-md shadow-blue-500/30 hover:shadow-lg hover:shadow-blue-500/40 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-md whitespace-nowrap"
                  >
                    💾 保存
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-2 leading-relaxed">
                  超过此数量时自动删除最旧记录（0=不限制，收藏不受影响）
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Filter Buttons */}
        <div className="p-3 border-b border-gray-200/60 bg-white/50 flex gap-2">
          <button
            onClick={() => setContentTypeFilter("all")}
            className={`flex-1 px-4 py-2 text-sm font-medium rounded-lg transition-all duration-200 ${
              contentTypeFilter === "all"
                ? "bg-gradient-to-r from-blue-500 to-indigo-600 text-white shadow-md shadow-blue-500/30 scale-105"
                : "text-gray-600 hover:bg-gray-50 border border-gray-200 hover:border-gray-300 hover:shadow-sm"
            }`}
          >
            全部
          </button>
          <button
            onClick={() => setContentTypeFilter("text")}
            className={`flex-1 px-4 py-2 text-sm font-medium rounded-lg transition-all duration-200 ${
              contentTypeFilter === "text"
                ? "bg-gradient-to-r from-blue-500 to-indigo-600 text-white shadow-md shadow-blue-500/30 scale-105"
                : "text-gray-600 hover:bg-gray-50 border border-gray-200 hover:border-gray-300 hover:shadow-sm"
            }`}
          >
            文字
          </button>
          <button
            onClick={() => setContentTypeFilter("image")}
            className={`flex-1 px-4 py-2 text-sm font-medium rounded-lg transition-all duration-200 ${
              contentTypeFilter === "image"
                ? "bg-gradient-to-r from-blue-500 to-indigo-600 text-white shadow-md shadow-blue-500/30 scale-105"
                : "text-gray-600 hover:bg-gray-50 border border-gray-200 hover:border-gray-300 hover:shadow-sm"
            }`}
          >
            图片
          </button>
        </div>

        {/* Actions */}
        <div className="p-3 border-b border-gray-200/60 bg-white/50 flex gap-2">
          <button
            onClick={loadClipboardItems}
            className="flex-1 px-4 py-2 text-sm font-medium text-blue-600 hover:bg-gradient-to-r hover:from-blue-50 hover:to-indigo-50 rounded-lg transition-all duration-200 border border-blue-200 hover:border-blue-300 hover:shadow-sm"
          >
            🔄 刷新
          </button>
          <button
            onClick={handleClearHistory}
            className="flex-1 px-4 py-2 text-sm font-medium text-red-600 hover:bg-gradient-to-r hover:from-red-50 hover:to-pink-50 rounded-lg transition-all duration-200 border border-red-200 hover:border-red-300 hover:shadow-sm"
          >
            🗑️ 清空历史
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-2 bg-gradient-to-b from-white to-gray-50/30">
          {filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <div className="text-6xl mb-4 opacity-50">📋</div>
              <div className="text-base font-medium text-gray-600 mb-1">
                {searchQuery
                  ? "没有找到匹配的内容"
                  : contentTypeFilter === "all"
                  ? "还没有剪切板历史"
                  : contentTypeFilter === "text"
                  ? "没有文字类型的记录"
                  : "没有图片类型的记录"}
              </div>
              {!searchQuery && contentTypeFilter === "all" && (
                <div className="text-sm text-gray-400 mt-2">
                  复制一些内容到这里查看
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {filteredItems.map((item, index) => (
                <div
                  key={item.id}
                  onClick={() => setSelectedItem(item)}
                  className={`group p-3 cursor-pointer transition-all duration-200 rounded-xl border ${
                    selectedItem?.id === item.id
                      ? "bg-gradient-to-r from-blue-50 to-indigo-50 border-blue-300 shadow-md shadow-blue-200/30 scale-[1.02]"
                      : "bg-white/80 border-gray-200/60 hover:border-blue-200/60 hover:bg-gradient-to-r hover:from-gray-50/80 hover:to-blue-50/30 hover:shadow-sm"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="text-xs font-bold text-gray-400 bg-gray-200/60 px-1.5 py-0.5 rounded min-w-[24px] text-center flex-shrink-0">
                        {index + 1}
                      </span>
                      <span className="text-xs font-medium text-gray-500 bg-gray-100/80 px-2 py-0.5 rounded-md">
                        {formatDate(item.created_at)}
                      </span>
                      {item.is_favorite && (
                        <span className="text-yellow-500 text-base drop-shadow-sm" title="收藏">
                          ⭐
                        </span>
                      )}
                    </div>
                    <span className={`text-xs px-2.5 py-1 rounded-md font-medium flex-shrink-0 ${
                      item.content_type === "image"
                        ? "bg-purple-100 text-purple-700"
                        : "bg-blue-100 text-blue-700"
                    }`}>
                      {item.content_type === "image" ? "🖼️ 图片" : "📝 文字"}
                    </span>
                  </div>
                  {item.content_type === "image" ? (
                    <div className="flex items-center gap-3">
                      {imageDataUrls.has(item.content) ? (
                        <img 
                          src={imageDataUrls.get(item.content)} 
                          alt="clipboard" 
                          className="w-12 h-12 object-cover rounded-lg shadow-sm border border-gray-200"
                        />
                      ) : (
                        <div 
                          className="w-12 h-12 bg-gradient-to-br from-gray-100 to-gray-200 rounded-lg flex items-center justify-center text-gray-400 text-xl cursor-pointer hover:from-gray-200 hover:to-gray-300 transition-all duration-200 shadow-sm border border-gray-200"
                          onClick={(e) => {
                            e.stopPropagation();
                            loadImageData(item.content);
                          }}
                          title="点击加载图片"
                        >
                          📷
                        </div>
                      )}
                      <span className="text-sm text-gray-600 font-medium">图片内容</span>
                    </div>
                  ) : (
                    <div className="text-sm text-gray-800 line-clamp-2 leading-relaxed bg-gray-50/50 rounded-md p-2 border border-gray-100">
                      {item.content || <span className="text-gray-400 italic">(空内容)</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right Panel - Detail */}
      <div className="flex-1 flex flex-col bg-gradient-to-br from-white via-gray-50/30 to-white min-w-0 overflow-hidden">
        {selectedItem ? (
          <>
            {/* Detail Header */}
            <div className="p-4 sm:p-5 border-b border-gray-200/60 bg-gradient-to-r from-white to-gray-50/50 backdrop-blur-sm shadow-sm">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
                <div className="flex items-center gap-3 flex-shrink-0 min-w-0">
                  <h3 className="text-base sm:text-lg font-bold bg-gradient-to-r from-gray-800 to-gray-600 bg-clip-text text-transparent whitespace-nowrap">
                    {isEditing ? "✏️ 编辑内容" : "📄 详细内容"}
                  </h3>
                  <span className={`text-xs px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-lg font-medium whitespace-nowrap flex-shrink-0 ${
                    selectedItem.content_type === "image"
                      ? "bg-purple-100 text-purple-700"
                      : "bg-blue-100 text-blue-700"
                  }`}>
                    {selectedItem.content_type === "image" ? "🖼️ 图片" : "📝 文字"}
                  </span>
                </div>
                <div className="flex gap-1.5 flex-wrap min-w-0">
                {isEditing ? (
                  <>
                    <button
                      onClick={handleSaveEdit}
                      className="px-2.5 py-1 text-xs font-medium bg-gradient-to-r from-blue-500 to-indigo-600 text-white rounded-lg hover:from-blue-600 hover:to-indigo-700 transition-all duration-200 shadow-md shadow-blue-500/30 hover:shadow-lg hover:shadow-blue-500/40 whitespace-nowrap flex-shrink-0"
                    >
                      ✓ 保存
                    </button>
                    <button
                      onClick={handleCancelEdit}
                      className="px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-lg transition-all duration-200 border border-gray-200 hover:border-gray-300 whitespace-nowrap flex-shrink-0"
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    {selectedItem.content_type === "text" && (
                    <button
                      onClick={() => handleEdit(selectedItem)}
                      className="px-2.5 py-1 text-xs font-medium text-blue-600 hover:bg-gradient-to-r hover:from-blue-50 hover:to-indigo-50 rounded-lg transition-all duration-200 border border-blue-200 hover:border-blue-300 hover:shadow-sm whitespace-nowrap flex-shrink-0"
                    >
                      ✏️ 编辑
                    </button>
                    )}
                    <button
                      onClick={() => handleToggleFavorite(selectedItem)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-all duration-200 border whitespace-nowrap flex-shrink-0 ${
                        selectedItem.is_favorite
                          ? "text-yellow-700 bg-yellow-50 border-yellow-200 hover:bg-yellow-100 shadow-sm"
                          : "text-gray-600 hover:bg-gray-50 border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      {selectedItem.is_favorite ? "⭐ 取消收藏" : "☆ 收藏"}
                    </button>
                    <button
                      onClick={() => handleCopyToClipboard(selectedItem)}
                      className="px-2.5 py-1 text-xs font-medium text-green-600 hover:bg-gradient-to-r hover:from-green-50 hover:to-emerald-50 rounded-lg transition-all duration-200 border border-green-200 hover:border-green-300 hover:shadow-sm whitespace-nowrap flex-shrink-0"
                    >
                      📋 复制
                    </button>
                    <button
                      onClick={() => handleDelete(selectedItem)}
                      className="px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-gradient-to-r hover:from-red-50 hover:to-pink-50 rounded-lg transition-all duration-200 border border-red-200 hover:border-red-300 hover:shadow-sm whitespace-nowrap flex-shrink-0"
                    >
                      🗑️ 删除
                    </button>
                  </>
                )}
                </div>
              </div>
            </div>

            {/* Detail Content */}
            <div className="flex-1 overflow-y-auto p-6 min-h-0 bg-gradient-to-b from-white to-gray-50/20">
              {isEditing ? (
                <div className="h-full">
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="w-full h-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-400 resize-none font-mono text-sm bg-white shadow-inner transition-all duration-200"
                    placeholder="输入内容..."
                  />
                </div>
              ) : (
                <div className="w-full h-full flex flex-col">
                  <div className="mb-4 px-4 py-2.5 text-sm text-gray-600 bg-gradient-to-r from-gray-50 to-blue-50/50 rounded-lg border border-gray-200/60 flex-shrink-0">
                    <span className="font-medium">🕐 创建时间:</span>{" "}
                    <span className="text-gray-700">
                      {new Date(selectedItem.created_at * 1000).toLocaleString("zh-CN", {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </span>
                  </div>
                  {selectedItem.content_type === "image" ? (
                    <div className="flex-1 flex items-center justify-center min-h-0 bg-gradient-to-br from-gray-50/50 to-blue-50/30 rounded-xl border-2 border-dashed border-gray-200 p-8">
                      {imageDataUrls.has(selectedItem.content) ? (
                        <div className="relative max-w-full max-h-full">
                          <img 
                            src={imageDataUrls.get(selectedItem.content)} 
                            alt="clipboard" 
                            className="max-w-full max-h-full object-contain rounded-xl shadow-2xl border border-gray-200/60"
                          />
                          <div className="absolute inset-0 rounded-xl bg-gradient-to-t from-black/10 to-transparent pointer-events-none"></div>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-3 text-gray-400">
                          <div className="text-5xl animate-pulse">📷</div>
                          <div className="text-base font-medium">加载图片中...</div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex-1 min-h-0 bg-white rounded-xl border-2 border-gray-200/60 shadow-inner overflow-hidden">
                      <div className="h-full overflow-y-auto p-5">
                        <pre className="whitespace-pre-wrap break-words font-mono text-sm text-gray-800 leading-relaxed m-0">
                          {selectedItem.content || (
                            <span className="text-gray-400 italic">(空内容)</span>
                          )}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center bg-gradient-to-br from-gray-50/50 via-blue-50/30 to-purple-50/20">
            <div className="text-center px-8">
              <div className="text-7xl mb-6 opacity-60 animate-bounce">📋</div>
              <div className="text-lg font-semibold text-gray-600 mb-2">
                选择一条剪切板记录查看详情
              </div>
              <div className="text-sm text-gray-400">
                从左侧列表中选择一条记录以查看完整内容
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
