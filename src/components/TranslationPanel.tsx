import { useState, useEffect, useRef, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { tauriApi } from "../api/tauri";

// 翻译服务提供商
type TranslationProvider = "baidu" | "sogou";

// 翻译服务配置
const TRANSLATION_SERVICES: Record<
  TranslationProvider,
  {
    name: string;
    url: string;
    buildUrl: (from: string, to: string, text?: string) => string;
    description: string;
  }
> = {
  baidu: {
    name: "百度翻译",
    url: "https://fanyi.baidu.com/",
    buildUrl: (from, to, text) => {
      // 百度翻译 URL 参数
      const langMap: Record<string, string> = {
        auto: "auto",
        zh: "zh",
        en: "en",
        ja: "jp",
        ko: "kor",
        fr: "fra",
        de: "de",
        es: "spa",
        ru: "ru",
        pt: "pt",
        it: "it",
        ar: "ara",
        th: "th",
        vi: "vie",
      };
      const fromCode = langMap[from] || from;
      const toCode = langMap[to] || to;
      // 百度翻译使用 fromCode 和 toCode 构建 URL
      let url = `https://fanyi.baidu.com/#${fromCode}/${toCode}/`;
      if (text) {
        url += encodeURIComponent(text);
      }
      return url;
    },
    description: "国内稳定，支持多种语言",
  },
  sogou: {
    name: "搜狗翻译",
    url: "https://fanyi.sogou.com/",
    buildUrl: (from, to, text) => {
      const langMap: Record<string, string> = {
        auto: "auto",
        zh: "zh-CHS",
        en: "en",
        ja: "ja",
        ko: "ko",
        fr: "fr",
        de: "de",
        es: "es",
        ru: "ru",
        pt: "pt",
        it: "it",
        ar: "ar",
        th: "th",
        vi: "vi",
      };
      const fromCode = langMap[from] || from;
      const toCode = langMap[to] || to;
      let url = `https://fanyi.sogou.com/?transfrom=${fromCode}&transto=${toCode}`;
      if (text) {
        url += `&query=${encodeURIComponent(text)}`;
      }
      return url;
    },
    description: "国内服务，速度快",
  },
};

// 支持的语言列表
const LANGUAGES = [
  { code: "auto", name: "自动检测" },
  { code: "zh", name: "中文" },
  { code: "en", name: "英语" },
  { code: "ja", name: "日语" },
  { code: "ko", name: "韩语" },
  { code: "fr", name: "法语" },
  { code: "de", name: "德语" },
  { code: "es", name: "西班牙语" },
  { code: "ru", name: "俄语" },
  { code: "pt", name: "葡萄牙语" },
  { code: "it", name: "意大利语" },
  { code: "ar", name: "阿拉伯语" },
  { code: "th", name: "泰语" },
  { code: "vi", name: "越南语" },
];

interface TranslationPanelProps {
  sourceLang: string;
  targetLang: string;
  onSourceLangChange: (lang: string) => void;
  onTargetLangChange: (lang: string) => void;
  onSaveWord?: (word: string, translation: string, sourceLang: string, targetLang: string) => Promise<void>;
}

export function TranslationPanel({
  sourceLang,
  targetLang,
  onSourceLangChange,
  onTargetLangChange,
  onSaveWord,
}: TranslationPanelProps) {
  const [currentProvider, setCurrentProvider] = useState<TranslationProvider>("baidu");
  const [iframeUrl, setIframeUrl] = useState("");
  const [inputText, setInputText] = useState("");
  const [iframeError, setIframeError] = useState<string | null>(null);
  const [iframeLoading, setIframeLoading] = useState(true);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveTranslation, setSaveTranslation] = useState("");

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const loadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 更新 iframe URL
  const updateIframeUrl = useCallback((provider: TranslationProvider, from: string, to: string, text?: string) => {
    const service = TRANSLATION_SERVICES[provider];
    const url = service.buildUrl(from, to, text);
    console.log(`[翻译] 更新URL: ${provider} - ${url}`);
    setIframeUrl(url);
    setIframeError(null);
    setIframeLoading(true);
    
    // 清除之前的超时
    if (loadingTimeoutRef.current) {
      clearTimeout(loadingTimeoutRef.current);
    }
    
    // 设置超时检测（10秒后如果还没加载完成，可能是被阻止了）
    loadingTimeoutRef.current = setTimeout(() => {
      // 使用函数式更新来获取最新的状态
      setIframeLoading((currentLoading) => {
        if (currentLoading) {
          console.warn(`[翻译] iframe加载超时: ${provider}`);
          setIframeError(`加载超时: ${TRANSLATION_SERVICES[provider].name}`);
        }
        return false;
      });
    }, 10000);
  }, []);

  // 初始化 iframe URL
  useEffect(() => {
    updateIframeUrl(currentProvider, sourceLang, targetLang);
  }, [currentProvider, sourceLang, targetLang, updateIframeUrl]);

  // 组件加载时自动读取剪切板内容并自动翻译
  useEffect(() => {
    let isMounted = true;
    
    const readClipboard = async () => {
      try {
        // 检查是否支持 Clipboard API
        if (navigator.clipboard && navigator.clipboard.readText) {
          const clipboardText = await navigator.clipboard.readText();
          // 如果剪切板有内容且输入框为空，则自动填充并翻译
          if (isMounted && clipboardText && clipboardText.trim()) {
            const trimmedText = clipboardText.trim();
            // 使用函数式更新来检查当前状态
            setInputText((currentText) => {
              // 如果输入框已有内容，则不覆盖（可能是从事件监听器设置的）
              if (currentText && currentText.trim()) {
                return currentText;
              }
              return trimmedText;
            });
            // 自动触发翻译
            updateIframeUrl(currentProvider, sourceLang, targetLang, trimmedText);
          }
        }
      } catch (error) {
        // 静默处理错误（可能是权限问题或剪切板为空）
        console.log("[翻译] 无法读取剪切板内容:", error);
      }
    };

    // 延迟读取，确保窗口已完全加载
    const timer = setTimeout(readClipboard, 300);
    
    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [currentProvider, sourceLang, targetLang, updateIframeUrl]); // 只在组件挂载时执行一次

  // 监听来自启动器的文本设置事件
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupListener = async () => {
      try {
        unlisten = await listen<string>("translation:set-text", (event) => {
          const text = event.payload;
          if (text) {
            setInputText(text);
            // 更新 iframe URL 以包含文本
            updateIframeUrl(currentProvider, sourceLang, targetLang, text);
          }
        });
      } catch (error) {
        console.error("Failed to setup translation event listener:", error);
      }
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [currentProvider, sourceLang, targetLang, updateIframeUrl]);

  // 当语言或服务改变时，如果有输入文本，自动翻译
  useEffect(() => {
    if (inputText) {
      updateIframeUrl(currentProvider, sourceLang, targetLang, inputText);
    } else {
      updateIframeUrl(currentProvider, sourceLang, targetLang);
    }
  }, [sourceLang, targetLang, currentProvider, inputText, updateIframeUrl]);

  const handleSwapLanguages = () => {
    const tempLang = sourceLang;
    onSourceLangChange(targetLang === "auto" ? "zh" : targetLang);
    onTargetLangChange(tempLang === "auto" ? "zh" : tempLang);
  };

  const handleProviderChange = (provider: TranslationProvider) => {
    setCurrentProvider(provider);
    // URL 更新会由 useEffect 自动处理
  };

  const handleRefresh = () => {
    if (iframeRef.current) {
      iframeRef.current.src = iframeRef.current.src;
    }
  };

  const handleSaveWord = () => {
    if (!inputText.trim()) {
      alert("请输入要翻译的单词");
      return;
    }
    setSaveTranslation("");
    setShowSaveDialog(true);
  };

  const handleConfirmSave = async () => {
    if (!inputText.trim() || !saveTranslation.trim()) {
      alert("请输入单词和翻译");
      return;
    }

    try {
      if (onSaveWord) {
        await onSaveWord(
          inputText.trim(),
          saveTranslation.trim(),
          sourceLang === "auto" ? "en" : sourceLang,
          targetLang
        );
      } else {
        // 默认行为：直接调用 API
        await tauriApi.addWordRecord(
          inputText.trim(),
          saveTranslation.trim(),
          sourceLang === "auto" ? "en" : sourceLang,
          targetLang,
          null,
          null,
          null,
          []
        );
      }
      setShowSaveDialog(false);
      setSaveTranslation("");
      alert("保存成功！");
    } catch (error) {
      console.error("保存单词失败:", error);
      alert("保存失败：" + (error instanceof Error ? error.message : String(error)));
    }
  };

  return (
    <>
      {/* 服务选择栏 */}
      <div className="flex items-center gap-2 px-4 py-2 bg-white border-b border-gray-200">
        <div className="flex items-center gap-1">
          {(Object.keys(TRANSLATION_SERVICES) as TranslationProvider[]).map((provider) => (
            <button
              key={provider}
              onClick={() => handleProviderChange(provider)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                currentProvider === provider
                  ? "bg-blue-500 text-white"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              }`}
              title={TRANSLATION_SERVICES[provider].description}
            >
              {TRANSLATION_SERVICES[provider].name}
            </button>
          ))}
        </div>
      </div>

      {/* 语言选择栏 */}
      <div className="flex items-center gap-2 px-4 py-2 bg-white border-b border-gray-200">
        <select
          value={sourceLang}
          onChange={(e) => onSourceLangChange(e.target.value)}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.name}
            </option>
          ))}
        </select>

        <button
          onClick={handleSwapLanguages}
          className="p-1.5 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
          title="交换语言"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
            />
          </svg>
        </button>

        <select
          value={targetLang}
          onChange={(e) => onTargetLangChange(e.target.value)}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {LANGUAGES.filter((lang) => lang.code !== "auto").map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.name}
            </option>
          ))}
        </select>

        <div className="flex-1" />
        <span className="text-xs text-gray-500">
          {TRANSLATION_SERVICES[currentProvider].description}
        </span>
      </div>

      {/* 快速输入栏（已隐藏） */}
      <div className="hidden">
        <input
          ref={inputRef}
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key === "Enter" && inputText) {
              // Enter 键触发翻译
              updateIframeUrl(currentProvider, sourceLang, targetLang, inputText);
            } else if (e.key === "Escape" || e.keyCode === 27) {
              // ESC 键关闭窗口
              e.preventDefault();
              e.stopPropagation();
              const window = getCurrentWindow();
              await window.close();
            }
          }}
        />
      </div>

      {/* iframe 翻译区域 */}
      <div className="flex-1 relative overflow-hidden">
        {iframeUrl && (
          <>
            <iframe
              ref={iframeRef}
              src={iframeUrl}
              className="w-full h-full border-0"
              title="单词助手"
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation allow-modals"
              allow="clipboard-read; clipboard-write; fullscreen"
              referrerPolicy="no-referrer-when-downgrade"
              onLoad={() => {
                console.log(`[翻译] iframe加载完成: ${currentProvider}`);
                
                // 检测iframe是否加载了about:blank（说明被阻止了）
                if (iframeRef.current) {
                  try {
                    const iframe = iframeRef.current;
                    const currentSrc = iframe.src;
                    console.log(`[翻译] iframe当前src: ${currentSrc}`);
                    
                    // 延迟检查，给页面一些时间加载
                    setTimeout(() => {
                      try {
                        const contentWindow = iframe.contentWindow;
                        if (contentWindow) {
                          try {
                            const location = contentWindow.location;
                            const href = location.href;
                            console.log(`[翻译] iframe实际URL: ${href}`);
                            
                            // 如果加载的是about:blank，说明被阻止了
                            if (href === "about:blank" || href.startsWith("about:")) {
                              console.warn(`[翻译] 检测到about:blank，${currentProvider}被JavaScript或安全策略阻止`);
                              setIframeError(`${TRANSLATION_SERVICES[currentProvider].name}无法在iframe中加载`);
                              setIframeLoading(false);
                            } else {
                              // URL正确，尝试检查内容
                              try {
                                const doc = iframe.contentDocument;
                                if (doc) {
                                  const bodyText = doc.body?.innerText || "";
                                  const bodyHTML = doc.body?.innerHTML || "";
                                  console.log(`[翻译] iframe内容长度: ${bodyText.length} 字符, HTML长度: ${bodyHTML.length}`);
                                  
                                  // 如果内容为空或只有很少内容，可能是被阻止了
                                  if (bodyText.trim() === "" && bodyHTML.length < 100) {
                                    console.warn(`[翻译] iframe内容为空，可能被JavaScript阻止`);
                                  }
                                }
                              } catch (docError) {
                                // 跨域无法访问，这是正常的
                                console.log(`[翻译] 无法访问iframe内容（跨域限制，这是正常的）`);
                              }
                            }
                          } catch (e) {
                            // 跨域访问被阻止，这是正常的
                            console.log(`[翻译] 无法访问iframe location（跨域限制，这是正常的）`);
                          }
                        }
                      } catch (e) {
                        console.error(`[翻译] 检查iframe状态时出错:`, e);
                      }
                    }, 1500);
                  } catch (e) {
                    console.error(`[翻译] 访问iframe时出错:`, e);
                  }
                }
                
                setIframeError(null);
                setIframeLoading(false);
                if (loadingTimeoutRef.current) {
                  clearTimeout(loadingTimeoutRef.current);
                  loadingTimeoutRef.current = null;
                }
              }}
              onError={(e) => {
                console.error(`[翻译] iframe加载错误: ${currentProvider}`, e);
                setIframeError(`加载失败: ${TRANSLATION_SERVICES[currentProvider].name}`);
              }}
            />
            {iframeError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-white z-10">
                <div className="max-w-md p-6 bg-white rounded-lg shadow-lg border border-gray-200">
                  <div className="text-red-600 mb-4 text-center font-semibold">{iframeError}</div>
                  <div className="text-sm text-gray-600 mb-4 text-center">
                    该翻译服务可能设置了安全策略，禁止在iframe中加载。
                  </div>
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={handleRefresh}
                      className="w-full px-4 py-2 text-sm bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 transition-colors"
                    >
                      重试
                    </button>
                    <button
                      onClick={() => {
                        setIframeError(null);
                      }}
                      className="w-full px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
                    >
                      关闭提示
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
        {!iframeUrl && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-100">
            <div className="text-gray-500">正在加载翻译服务...</div>
          </div>
        )}
        {iframeLoading && iframeUrl && !iframeError && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-100 bg-opacity-50 pointer-events-none">
            <div className="text-gray-500">正在加载翻译服务...</div>
          </div>
        )}
      </div>

      {/* 保存单词对话框 */}
      {showSaveDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-96 max-w-[90vw]">
            <h2 className="text-lg font-semibold mb-4">保存单词</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  单词
                </label>
                <input
                  type="text"
                  value={inputText}
                  readOnly
                  className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-50"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  翻译 *
                </label>
                <input
                  type="text"
                  value={saveTranslation}
                  onChange={(e) => setSaveTranslation(e.target.value)}
                  placeholder="请输入翻译结果"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleConfirmSave();
                    } else if (e.key === "Escape") {
                      setShowSaveDialog(false);
                    }
                  }}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => {
                  setShowSaveDialog(false);
                  setSaveTranslation("");
                }}
                className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleConfirmSave}
                className="px-4 py-2 text-sm bg-blue-500 text-white hover:bg-blue-600 rounded transition-colors"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

