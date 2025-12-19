import { useState, useEffect, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { tauriApi } from "../api/tauri";
import { useEscapeKey } from "../hooks/useEscapeKey";

interface ColorFormat {
  hex: string;
  rgb: { r: number; g: number; b: number };
  hsl: { h: number; s: number; l: number };
  hsv: { h: number; s: number; v: number };
  alpha: number; // 0-1
}

interface StoredColor {
  color: string;
  timestamp: number;
}

export function ColorPickerWindow() {
  const [currentColor, setCurrentColor] = useState("#3b82f6");
  const [colorFormat, setColorFormat] = useState<ColorFormat>({
    hex: "#3b82f6",
    rgb: { r: 59, g: 130, b: 246 },
    hsl: { h: 217, s: 91, l: 60 },
    hsv: { h: 217, s: 76, v: 96 },
    alpha: 1,
  });
  const [colorHistory, setColorHistory] = useState<StoredColor[]>([]);
  const [isPickingColor, setIsPickingColor] = useState(false);
  const [copiedFormat, setCopiedFormat] = useState<string | null>(null);

  const currentWindow = getCurrentWindow();

  useEffect(() => {
    currentWindow.setTitle("拾色器");
    loadColorHistory();
  }, [currentWindow]);

  // Esc 键关闭窗口
  const handleClose = useCallback(async () => {
    await currentWindow.close();
  }, [currentWindow]);

  useEscapeKey(handleClose);

  // 加载历史记录
  const loadColorHistory = () => {
    try {
      const stored = localStorage.getItem("color-picker-history");
      if (stored) {
        const history: StoredColor[] = JSON.parse(stored);
        setColorHistory(history.slice(0, 20)); // 最多保存20个
      }
    } catch (error) {
      console.error("Failed to load color history:", error);
    }
  };

  // 保存颜色到历史记录
  const saveColorToHistory = (color: string) => {
    const newColor: StoredColor = {
      color,
      timestamp: Date.now(),
    };
    
    // 去重并添加到开头
    const filtered = colorHistory.filter((c) => c.color.toLowerCase() !== color.toLowerCase());
    const newHistory = [newColor, ...filtered].slice(0, 20);
    
    setColorHistory(newHistory);
    localStorage.setItem("color-picker-history", JSON.stringify(newHistory));
  };

  // HEX 转 RGB
  const hexToRgb = (hex: string): { r: number; g: number; b: number } => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16),
        }
      : { r: 0, g: 0, b: 0 };
  };

  // RGB 转 HSL
  const rgbToHsl = (r: number, g: number, b: number): { h: number; s: number; l: number } => {
    r /= 255;
    g /= 255;
    b /= 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;

    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

      switch (max) {
        case r:
          h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
          break;
        case g:
          h = ((b - r) / d + 2) / 6;
          break;
        case b:
          h = ((r - g) / d + 4) / 6;
          break;
      }
    }

    return {
      h: Math.round(h * 360),
      s: Math.round(s * 100),
      l: Math.round(l * 100),
    };
  };

  // RGB 转 HSV
  const rgbToHsv = (r: number, g: number, b: number): { h: number; s: number; v: number } => {
    r /= 255;
    g /= 255;
    b /= 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    const s = max === 0 ? 0 : d / max;
    const v = max;

    if (max !== min) {
      switch (max) {
        case r:
          h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
          break;
        case g:
          h = ((b - r) / d + 2) / 6;
          break;
        case b:
          h = ((r - g) / d + 4) / 6;
          break;
      }
    }

    return {
      h: Math.round(h * 360),
      s: Math.round(s * 100),
      v: Math.round(v * 100),
    };
  };

  // 更新颜色格式
  const updateColorFormats = (hex: string, alpha?: number) => {
    const rgb = hexToRgb(hex);
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    const newAlpha = alpha !== undefined ? alpha : colorFormat.alpha;

    setColorFormat({ hex, rgb, hsl, hsv, alpha: newAlpha });
    setCurrentColor(hex);
    saveColorToHistory(hex);
  };

  // 更新透明度
  const updateAlpha = (alpha: number) => {
    setColorFormat({ ...colorFormat, alpha });
  };

  // 处理颜色输入变化
  const handleColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateColorFormats(e.target.value);
  };

  // 处理 HEX 输入
  const handleHexInput = (value: string) => {
    // 确保以 # 开头
    if (!value.startsWith("#")) {
      value = "#" + value;
    }
    
    // 验证 HEX 格式
    if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
      updateColorFormats(value);
    }
  };

  // RGB 转 HEX
  const rgbToHex = (r: number, g: number, b: number): string => {
    const toHex = (n: number) => {
      const hex = Math.max(0, Math.min(255, Math.round(n))).toString(16);
      return hex.length === 1 ? "0" + hex : hex;
    };
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  };

  // 处理 RGB 输入
  const handleRgbChange = (channel: "r" | "g" | "b", value: number) => {
    const newRgb = { ...colorFormat.rgb, [channel]: value };
    const hex = rgbToHex(newRgb.r, newRgb.g, newRgb.b);
    updateColorFormats(hex);
  };

  // 处理 HSL 输入 - 保留以便将来使用
  // 如果需要，可以重新添加 hslToRgb 函数
  // const handleHslChange = (channel: "h" | "s" | "l", value: number) => {
  //   const hslToRgb = (h: number, s: number, l: number) => { ... };
  //   const newHsl = { ...colorFormat.hsl, [channel]: value };
  //   const rgb = hslToRgb(newHsl.h, newHsl.s, newHsl.l);
  //   const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
  //   updateColorFormats(hex);
  // };

  // 屏幕取色
  const handlePickFromScreen = async () => {
    try {
      setIsPickingColor(true);
      
      // 立即隐藏窗口，让用户看到下面的内容（减少卡顿感）
      await currentWindow.hide();
      
      // 短暂延迟确保窗口已隐藏
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const color = await tauriApi.pickColorFromScreen();
      
      // 取色完成后显示窗口
      await currentWindow.show();
      await currentWindow.setFocus();
      
      if (color) {
        updateColorFormats(color);
      }
    } catch (error) {
      console.error("Failed to pick color from screen:", error);
      // 出错也要恢复窗口
      await currentWindow.show();
      alert("屏幕取色失败，请确保已授予必要的权限");
    } finally {
      setIsPickingColor(false);
    }
  };

  // 复制到剪贴板
  const copyToClipboard = async (text: string, format: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedFormat(format);
      setTimeout(() => setCopiedFormat(null), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <div 
      className={`flex flex-col h-screen bg-gray-50 dark:bg-gray-900 ${
        isPickingColor ? "cursor-crosshair" : ""
      }`}
    >
      {/* 标题栏 */}
      <div
        className="flex items-center justify-between px-4 py-3 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700"
        data-tauri-drag-region
      >
        <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-100">
          拾色器
        </h1>
        <button
          onClick={handlePickFromScreen}
          disabled={isPickingColor}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
            isPickingColor
              ? "bg-gray-300 text-gray-500"
              : "bg-blue-500 text-white hover:bg-blue-600 active:scale-95"
          }`}
          title="从屏幕取色"
        >
          {isPickingColor ? "🎨 取色中..." : "🎨 屏幕取色"}
        </button>
      </div>

      {/* 主内容区 */}
      <div className={`flex-1 overflow-auto p-6 ${isPickingColor ? "cursor-crosshair" : ""}`}>
        <div className="max-w-4xl mx-auto space-y-6">
          {/* 主色块和颜色选择器 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* 当前颜色显示 */}
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-4">
                当前颜色
              </h3>
              <div 
                className="w-full h-48 rounded-lg shadow-inner border-4 border-white dark:border-gray-700 transition-colors relative overflow-hidden"
                style={{
                  background: 'repeating-conic-gradient(#80808040 0% 25%, transparent 0% 50%) 50% / 20px 20px'
                }}
              >
                <div 
                  className="absolute inset-0"
                  style={{ 
                    backgroundColor: `rgba(${colorFormat.rgb.r}, ${colorFormat.rgb.g}, ${colorFormat.rgb.b}, ${colorFormat.alpha})`
                  }}
                />
              </div>
              <div className="mt-4 flex gap-2">
                <input
                  type="color"
                  value={currentColor}
                  onChange={handleColorChange}
                  className="w-16 h-16 rounded-lg cursor-pointer border-2 border-gray-300 dark:border-gray-600"
                />
                <input
                  type="text"
                  value={currentColor}
                  onChange={(e) => handleHexInput(e.target.value)}
                  className="flex-1 px-4 py-2 text-lg font-mono border border-gray-300 dark:border-gray-600 rounded-lg
                           bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100
                           focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="#000000"
                />
              </div>

              {/* 历史记录 */}
              {colorHistory.length > 0 && (
                <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
                  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                    历史记录
                  </h4>
                  <div className="grid grid-cols-8 gap-2">
                    {colorHistory.map((item, i) => (
                      <button
                        key={i}
                        onClick={() => updateColorFormats(item.color)}
                        className="aspect-square rounded-lg border-2 border-gray-300 dark:border-gray-600 hover:scale-110 transition-transform cursor-pointer"
                        style={{ backgroundColor: item.color }}
                        title={item.color}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 颜色格式 */}
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-4">
                颜色格式
              </h3>
              <div className="space-y-3">
                {/* HEX */}
                <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">HEX</div>
                    <div className="font-mono text-sm text-gray-900 dark:text-gray-100">
                      {colorFormat.hex.toUpperCase()}
                    </div>
                  </div>
                  <button
                    onClick={() => copyToClipboard(colorFormat.hex.toUpperCase(), "hex")}
                    className="px-3 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
                  >
                    {copiedFormat === "hex" ? "✓ 已复制" : "复制"}
                  </button>
                </div>

                {/* RGB */}
                <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">RGB</div>
                    <div className="font-mono text-sm text-gray-900 dark:text-gray-100">
                      rgb({colorFormat.rgb.r}, {colorFormat.rgb.g}, {colorFormat.rgb.b})
                    </div>
                  </div>
                  <button
                    onClick={() =>
                      copyToClipboard(
                        `rgb(${colorFormat.rgb.r}, ${colorFormat.rgb.g}, ${colorFormat.rgb.b})`,
                        "rgb"
                      )
                    }
                    className="px-3 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
                  >
                    {copiedFormat === "rgb" ? "✓ 已复制" : "复制"}
                  </button>
                </div>

                {/* HSL */}
                <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">HSL</div>
                    <div className="font-mono text-sm text-gray-900 dark:text-gray-100">
                      hsl({colorFormat.hsl.h}°, {colorFormat.hsl.s}%, {colorFormat.hsl.l}%)
                    </div>
                  </div>
                  <button
                    onClick={() =>
                      copyToClipboard(
                        `hsl(${colorFormat.hsl.h}, ${colorFormat.hsl.s}%, ${colorFormat.hsl.l}%)`,
                        "hsl"
                      )
                    }
                    className="px-3 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
                  >
                    {copiedFormat === "hsl" ? "✓ 已复制" : "复制"}
                  </button>
                </div>

                {/* HSV */}
                <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">HSV</div>
                    <div className="font-mono text-sm text-gray-900 dark:text-gray-100">
                      hsv({colorFormat.hsv.h}°, {colorFormat.hsv.s}%, {colorFormat.hsv.v}%)
                    </div>
                  </div>
                  <button
                    onClick={() =>
                      copyToClipboard(
                        `hsv(${colorFormat.hsv.h}, ${colorFormat.hsv.s}%, ${colorFormat.hsv.v}%)`,
                        "hsv"
                      )
                    }
                    className="px-3 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
                  >
                    {copiedFormat === "hsv" ? "✓ 已复制" : "复制"}
                  </button>
                </div>

                {/* RGBA */}
                <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">RGBA</div>
                    <div className="font-mono text-sm text-gray-900 dark:text-gray-100">
                      rgba({colorFormat.rgb.r}, {colorFormat.rgb.g}, {colorFormat.rgb.b}, {colorFormat.alpha.toFixed(2)})
                    </div>
                  </div>
                  <button
                    onClick={() =>
                      copyToClipboard(
                        `rgba(${colorFormat.rgb.r}, ${colorFormat.rgb.g}, ${colorFormat.rgb.b}, ${colorFormat.alpha.toFixed(2)})`,
                        "rgba"
                      )
                    }
                    className="px-3 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
                  >
                    {copiedFormat === "rgba" ? "✓ 已复制" : "复制"}
                  </button>
                </div>

                {/* HSLA */}
                <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                  <div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">HSLA</div>
                    <div className="font-mono text-sm text-gray-900 dark:text-gray-100">
                      hsla({colorFormat.hsl.h}°, {colorFormat.hsl.s}%, {colorFormat.hsl.l}%, {colorFormat.alpha.toFixed(2)})
                    </div>
                  </div>
                  <button
                    onClick={() =>
                      copyToClipboard(
                        `hsla(${colorFormat.hsl.h}, ${colorFormat.hsl.s}%, ${colorFormat.hsl.l}%, ${colorFormat.alpha.toFixed(2)})`,
                        "hsla"
                      )
                    }
                    className="px-3 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
                  >
                    {copiedFormat === "hsla" ? "✓ 已复制" : "复制"}
                  </button>
                </div>

                {/* HEX with Alpha */}
                {colorFormat.alpha < 1 && (
                  <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                    <div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">HEX (8位含透明度)</div>
                      <div className="font-mono text-sm text-gray-900 dark:text-gray-100">
                        {colorFormat.hex}{Math.round(colorFormat.alpha * 255).toString(16).padStart(2, '0').toUpperCase()}
                      </div>
                    </div>
                    <button
                      onClick={() =>
                        copyToClipboard(
                          `${colorFormat.hex}${Math.round(colorFormat.alpha * 255).toString(16).padStart(2, '0').toUpperCase()}`,
                          "hexa"
                        )
                      }
                      className="px-3 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
                    >
                      {copiedFormat === "hexa" ? "✓ 已复制" : "复制"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 透明度滑块 */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-4">
              透明度 (Alpha)
            </h3>
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm text-gray-600 dark:text-gray-400">
                      透明度
                    </label>
                    <span className="text-sm font-mono text-gray-900 dark:text-gray-100">
                      {Math.round(colorFormat.alpha * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={colorFormat.alpha * 100}
                    onChange={(e) => updateAlpha(parseInt(e.target.value) / 100)}
                    className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer"
                  />
                </div>
                <div 
                  className="w-16 h-16 rounded-lg border-2 border-gray-300 dark:border-gray-600 relative overflow-hidden"
                  style={{
                    background: 'repeating-conic-gradient(#80808040 0% 25%, transparent 0% 50%) 50% / 10px 10px'
                  }}
                >
                  <div 
                    className="absolute inset-0"
                    style={{ 
                      backgroundColor: `rgba(${colorFormat.rgb.r}, ${colorFormat.rgb.g}, ${colorFormat.rgb.b}, ${colorFormat.alpha})`
                    }}
                  />
                </div>
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
                💡 提示: 屏幕取色只能获取 RGB 值，透明度需手动调节。棋盘格背景用于预览透明效果。
              </div>
            </div>
          </div>

          {/* RGB 滑块 */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-4">
              RGB 调节
            </h3>
            <div className="space-y-4">
              {(["r", "g", "b"] as const).map((channel) => (
                <div key={channel}>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm text-gray-600 dark:text-gray-400 uppercase">
                      {channel}
                    </label>
                    <span className="text-sm font-mono text-gray-900 dark:text-gray-100">
                      {colorFormat.rgb[channel]}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="255"
                    value={colorFormat.rgb[channel]}
                    onChange={(e) => handleRgbChange(channel, parseInt(e.target.value))}
                    className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer"
                    style={{
                      background: `linear-gradient(to right, 
                        ${channel === "r" ? "#000" : currentColor},
                        ${channel === "r" ? "#f00" : currentColor}
                      )`,
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
