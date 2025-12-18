import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { tauriApi } from "../api/tauri";

interface ColorFormat {
  hex: string;
  rgb: { r: number; g: number; b: number };
  hsl: { h: number; s: number; l: number };
  hsv: { h: number; s: number; v: number };
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
  });
  const [colorHistory, setColorHistory] = useState<StoredColor[]>([]);
  const [isPickingColor, setIsPickingColor] = useState(false);
  const [copiedFormat, setCopiedFormat] = useState<string | null>(null);

  const currentWindow = getCurrentWindow();

  // 预设颜色调色板
  const presetColors = [
    "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e",
    "#10b981", "#14b8a6", "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1",
    "#8b5cf6", "#a855f7", "#d946ef", "#ec4899", "#f43f5e", "#64748b",
    "#000000", "#ffffff", "#6b7280", "#9ca3af", "#d1d5db", "#f3f4f6",
  ];

  useEffect(() => {
    currentWindow.setTitle("拾色器");
    loadColorHistory();
  }, [currentWindow]);

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
  const updateColorFormats = (hex: string) => {
    const rgb = hexToRgb(hex);
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);

    setColorFormat({ hex, rgb, hsl, hsv });
    setCurrentColor(hex);
    saveColorToHistory(hex);
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

  // HSL 转 RGB
  const hslToRgb = (h: number, s: number, l: number): { r: number; g: number; b: number } => {
    h /= 360;
    s /= 100;
    l /= 100;

    let r, g, b;

    if (s === 0) {
      r = g = b = l;
    } else {
      const hue2rgb = (p: number, q: number, t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };

      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }

    return {
      r: Math.round(r * 255),
      g: Math.round(g * 255),
      b: Math.round(b * 255),
    };
  };

  // 处理 HSL 输入
  const handleHslChange = (channel: "h" | "s" | "l", value: number) => {
    const newHsl = { ...colorFormat.hsl, [channel]: value };
    const rgb = hslToRgb(newHsl.h, newHsl.s, newHsl.l);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    updateColorFormats(hex);
  };

  // 屏幕取色
  const handlePickFromScreen = async () => {
    try {
      setIsPickingColor(true);
      const color = await tauriApi.pickColorFromScreen();
      if (color) {
        updateColorFormats(color);
      }
    } catch (error) {
      console.error("Failed to pick color from screen:", error);
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

  // 生成和谐色
  const generateHarmony = (type: "complementary" | "analogous" | "triadic" | "tetradic") => {
    const { h, s, l } = colorFormat.hsl;
    const colors: string[] = [];

    switch (type) {
      case "complementary":
        colors.push(currentColor);
        colors.push(rgbToHex(...Object.values(hslToRgb((h + 180) % 360, s, l))));
        break;
      case "analogous":
        colors.push(rgbToHex(...Object.values(hslToRgb((h - 30 + 360) % 360, s, l))));
        colors.push(currentColor);
        colors.push(rgbToHex(...Object.values(hslToRgb((h + 30) % 360, s, l))));
        break;
      case "triadic":
        colors.push(currentColor);
        colors.push(rgbToHex(...Object.values(hslToRgb((h + 120) % 360, s, l))));
        colors.push(rgbToHex(...Object.values(hslToRgb((h + 240) % 360, s, l))));
        break;
      case "tetradic":
        colors.push(currentColor);
        colors.push(rgbToHex(...Object.values(hslToRgb((h + 90) % 360, s, l))));
        colors.push(rgbToHex(...Object.values(hslToRgb((h + 180) % 360, s, l))));
        colors.push(rgbToHex(...Object.values(hslToRgb((h + 270) % 360, s, l))));
        break;
    }

    return colors;
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50 dark:bg-gray-900">
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
              ? "bg-gray-300 text-gray-500 cursor-not-allowed"
              : "bg-blue-500 text-white hover:bg-blue-600 active:scale-95"
          }`}
          title="从屏幕取色"
        >
          {isPickingColor ? "🎨 取色中..." : "🎨 屏幕取色"}
        </button>
      </div>

      {/* 主内容区 */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* 主色块和颜色选择器 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* 当前颜色显示 */}
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-4">
                当前颜色
              </h3>
              <div
                className="w-full h-48 rounded-lg shadow-inner border-4 border-white dark:border-gray-700 transition-colors"
                style={{ backgroundColor: currentColor }}
              />
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

          {/* 色彩和谐 */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-4">
              色彩和谐
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[
                { type: "complementary" as const, label: "互补色", desc: "色轮对面的颜色" },
                { type: "analogous" as const, label: "类似色", desc: "相邻的颜色" },
                { type: "triadic" as const, label: "三角色", desc: "等距三角" },
                { type: "tetradic" as const, label: "四角色", desc: "矩形配色" },
              ].map(({ type, label, desc }) => (
                <div key={type} className="p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
                  <div className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {label}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mb-3">{desc}</div>
                  <div className="flex gap-2">
                    {generateHarmony(type).map((color, i) => (
                      <button
                        key={i}
                        onClick={() => updateColorFormats(color)}
                        className="flex-1 h-12 rounded-lg border-2 border-gray-300 dark:border-gray-600 hover:scale-105 transition-transform cursor-pointer"
                        style={{ backgroundColor: color }}
                        title={color}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 预设颜色 */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-4">
              预设颜色
            </h3>
            <div className="grid grid-cols-12 gap-2">
              {presetColors.map((color) => (
                <button
                  key={color}
                  onClick={() => updateColorFormats(color)}
                  className="aspect-square rounded-lg border-2 border-gray-300 dark:border-gray-600 hover:scale-110 transition-transform cursor-pointer"
                  style={{ backgroundColor: color }}
                  title={color}
                />
              ))}
            </div>
          </div>

          {/* 历史记录 */}
          {colorHistory.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6 border border-gray-200 dark:border-gray-700">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-4">
                历史记录
              </h3>
              <div className="grid grid-cols-12 gap-2">
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
      </div>
    </div>
  );
}
