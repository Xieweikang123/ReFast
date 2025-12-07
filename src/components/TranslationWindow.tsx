import { useState, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

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

export function TranslationWindow() {
  const [sourceLang, setSourceLang] = useState("auto");
  const [targetLang, setTargetLang] = useState("en");
  const [currentProvider, setCurrentProvider] = useState<TranslationProvider>("baidu");
  const [iframeUrl, setIframeUrl] = useState("");
  const [inputText, setInputText] = useState("");
  const [iframeError, setIframeError] = useState<string | null>(null);
  const [iframeLoading, setIframeLoading] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const loadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepFocusRef = useRef(true); // 是否应该保持焦点

  // 更新 iframe URL
  const updateIframeUrl = (provider: TranslationProvider, from: string, to: string, text?: string) => {
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
  };

  // 初始化 iframe URL
  useEffect(() => {
    updateIframeUrl(currentProvider, sourceLang, targetLang);
  }, [currentProvider, sourceLang, targetLang]);

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
  }, [currentProvider, sourceLang, targetLang]);

  // 当语言或服务改变时，如果有输入文本，更新 URL
  useEffect(() => {
    if (inputText) {
      updateIframeUrl(currentProvider, sourceLang, targetLang, inputText);
    } else {
      updateIframeUrl(currentProvider, sourceLang, targetLang);
    }
  }, [sourceLang, targetLang, currentProvider, inputText]);

  const handleSwapLanguages = () => {
    const tempLang = sourceLang;
    setSourceLang(targetLang === "auto" ? "zh" : targetLang);
    setTargetLang(tempLang === "auto" ? "zh" : tempLang);
  };

  const handleProviderChange = (provider: TranslationProvider) => {
    setCurrentProvider(provider);
    if (inputText) {
      updateIframeUrl(provider, sourceLang, targetLang, inputText);
    } else {
      updateIframeUrl(provider, sourceLang, targetLang);
    }
  };

  const handleRefresh = () => {
    if (iframeRef.current) {
      iframeRef.current.src = iframeRef.current.src;
    }
  };

  // ESC 键关闭窗口
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.keyCode === 27) {
        e.preventDefault();
        e.stopPropagation();
        const window = getCurrentWindow();
        await window.close();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);

  // 持续保持焦点在快速输入框（使用事件监听，无需定时轮询）
  useEffect(() => {
    // 智能聚焦函数：只在需要时聚焦
    const focusInput = () => {
      if (inputRef.current && keepFocusRef.current) {
        const activeElement = document.activeElement;
        // 如果焦点不在输入框上，且不在其他可交互元素上，则聚焦输入框
        if (activeElement !== inputRef.current && 
            activeElement !== document.body &&
            activeElement !== document.documentElement &&
            !activeElement?.closest('button') &&
            !activeElement?.closest('select') &&
            !activeElement?.closest('iframe')) {
          inputRef.current.focus();
        }
      }
    };

    // 初始聚焦
    setTimeout(() => {
      inputRef.current?.focus();
    }, 200);

    // 监听全局焦点变化，当焦点被iframe抢走时重新聚焦
    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      
      // 如果焦点转移到iframe，立即重新聚焦到输入框
      if (target.closest('iframe')) {
        // 使用 requestAnimationFrame 确保在下一帧执行，避免与iframe的聚焦冲突
        requestAnimationFrame(() => {
          if (keepFocusRef.current && inputRef.current) {
            inputRef.current.focus();
          }
        });
      }
    };

    // 监听焦点离开事件
    const handleFocusOut = (e: FocusEvent) => {
      const relatedTarget = e.relatedTarget as HTMLElement;
      // 如果焦点离开输入框，且没有转移到其他可交互元素，则重新聚焦
      if (e.target === inputRef.current) {
        if (!relatedTarget || 
            relatedTarget === document.body ||
            (!relatedTarget.closest('button') && 
             !relatedTarget.closest('select') && 
             !relatedTarget.closest('iframe'))) {
          requestAnimationFrame(() => {
            if (keepFocusRef.current && inputRef.current) {
              inputRef.current.focus();
            }
          });
        }
      }
    };

    // MutationObserver 将在单独的 useEffect 中设置（当 iframe 挂载后）

    // 监听窗口点击事件，当用户点击窗口空白区域时重新聚焦
    const handleWindowClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // 如果点击的不是按钮、选择框、iframe等交互元素，则聚焦到输入框
      if (!target.closest('button') && 
          !target.closest('select') && 
          !target.closest('iframe') &&
          !target.closest('input') &&
          target !== inputRef.current) {
        requestAnimationFrame(() => {
          focusInput();
        });
      }
    };

    // 使用 capture 阶段捕获所有焦点事件
    document.addEventListener('focusin', handleFocusIn, true);
    document.addEventListener('focusout', handleFocusOut, true);
    window.addEventListener('click', handleWindowClick, true);

    return () => {
      document.removeEventListener('focusin', handleFocusIn, true);
      document.removeEventListener('focusout', handleFocusOut, true);
      window.removeEventListener('click', handleWindowClick, true);
    };
  }, []);

  // 使用 MutationObserver 监听 iframe 的加载状态变化
  useEffect(() => {
    if (!iframeRef.current) return;

    const observer = new MutationObserver((mutations) => {
      // 当 iframe src 属性变化时，检查焦点
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
          // iframe src 变化时，延迟重新聚焦（等待iframe加载）
          setTimeout(() => {
            if (keepFocusRef.current && inputRef.current) {
              inputRef.current.focus();
            }
          }, 300);
        }
      });
    });

    // 观察 iframe 元素的变化
    observer.observe(iframeRef.current, {
      attributes: true,
      attributeFilter: ['src']
    });

    return () => {
      observer.disconnect();
    };
  }, [iframeUrl]); // 当 iframeUrl 变化时重新设置观察器

  return (
    <div className="h-screen w-screen flex flex-col bg-gray-50">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 py-3 bg-white border-b border-gray-200 shadow-sm">
        <h1 className="text-lg font-semibold text-gray-800">翻译工具</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            className="px-3 py-1 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
            title="刷新"
          >
            刷新
          </button>
        </div>
      </div>

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
          onChange={(e) => setSourceLang(e.target.value)}
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
          onChange={(e) => setTargetLang(e.target.value)}
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

      {/* 快速输入栏（可选） */}
      <div className="px-4 py-2 bg-gray-50 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onBlur={(e) => {
              // 当输入框失去焦点时，检查是否应该重新聚焦
              const relatedTarget = e.relatedTarget as HTMLElement;
              // 如果焦点转移到其他可交互元素（按钮、选择框等），则不强制聚焦
              if (relatedTarget && (
                relatedTarget.closest('button') ||
                relatedTarget.closest('select') ||
                relatedTarget.closest('input') && relatedTarget !== inputRef.current
              )) {
                return;
              }
              // 延迟重新聚焦，防止iframe或其他元素自动聚焦
              setTimeout(() => {
                if (keepFocusRef.current && inputRef.current) {
                  const activeElement = document.activeElement;
                  // 如果焦点不在其他可交互元素上，则重新聚焦到输入框
                  if (activeElement !== inputRef.current &&
                      !activeElement?.closest('button') &&
                      !activeElement?.closest('select') &&
                      !activeElement?.closest('iframe')) {
                    inputRef.current.focus();
                  }
                }
              }, 50);
            }}
            onFocus={() => {
              // 当输入框获得焦点时，确保保持焦点标志为true
              keepFocusRef.current = true;
            }}
            onKeyDown={async (e) => {
              if (e.key === "Enter" && inputText) {
                updateIframeUrl(currentProvider, sourceLang, targetLang, inputText);
                // 延迟重新聚焦，防止iframe加载后自动跳转焦点
                setTimeout(() => {
                  inputRef.current?.focus();
                }, 100);
              } else if (e.key === "Escape" || e.keyCode === 27) {
                // ESC 键关闭窗口
                e.preventDefault();
                e.stopPropagation();
                const window = await getCurrentWindow();
                await window.close();
              }
            }}
            placeholder="快速输入文本并回车翻译..."
            className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {inputText && (
            <button
              onClick={() => {
                setInputText("");
                updateIframeUrl(currentProvider, sourceLang, targetLang);
              }}
              className="px-2 py-1 text-xs text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
            >
              清空
            </button>
          )}
        </div>
      </div>

      {/* iframe 翻译区域 */}
      <div className="flex-1 relative overflow-hidden">
        {iframeUrl && (
          <>
            <iframe
              ref={iframeRef}
              src={iframeUrl}
              className="w-full h-full border-0"
              title="翻译工具"
              // 尝试移除sandbox限制，看看是否是sandbox导致的问题
              // 对于有道翻译，如果JavaScript检测到在iframe中，可能会阻止加载
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation allow-modals"
              allow="clipboard-read; clipboard-write; fullscreen"
              // 尝试设置referrerpolicy，可能有助于绕过某些检测
              referrerPolicy="no-referrer-when-downgrade"
              onLoad={() => {
                console.log(`[翻译] iframe加载完成: ${currentProvider}`);
                
                // 重新聚焦到快速输入框，防止iframe内的网站自动聚焦
                // 注意：无法通过 postMessage 阻止翻译网站的自动聚焦，因为：
                // 1. 翻译网站不会监听我们的 postMessage
                // 2. 自动聚焦代码在页面加载时已执行，无法阻止
                // 3. 跨域限制使我们无法直接控制 iframe 内的行为
                // 因此只能通过持续监控和主动重新聚焦来保持焦点
                setTimeout(() => {
                  inputRef.current?.focus();
                }, 200);
                
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
    </div>
  );
}
