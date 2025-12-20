import { useState, useEffect, useCallback } from "react";
import { flushSync } from "react-dom";
import { confirm } from "@tauri-apps/plugin-dialog";
import { tauriApi } from "../api/tauri";
import type { WordRecord } from "../types";
import { formatDateTime } from "../utils/dateUtils";

interface WordbookPanelProps {
  ollamaSettings: { model: string; base_url: string };
  onRefresh?: () => void;
}

export function WordbookPanel({ ollamaSettings, onRefresh }: WordbookPanelProps) {
  // 单词本相关状态
  const [wordRecords, setWordRecords] = useState<WordRecord[]>([]);
  const [wordSearchQuery, setWordSearchQuery] = useState("");
  const [isWordLoading, setIsWordLoading] = useState(false);
  
  // 编辑相关状态
  const [editingRecord, setEditingRecord] = useState<WordRecord | null>(null);
  const [editWord, setEditWord] = useState("");
  const [editTranslation, setEditTranslation] = useState("");
  const [editContext, setEditContext] = useState("");
  const [editPhonetic, setEditPhonetic] = useState("");
  const [editExampleSentence, setEditExampleSentence] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editMasteryLevel, setEditMasteryLevel] = useState(0);
  
  // AI解释相关状态
  const [showAiExplanation, setShowAiExplanation] = useState(false);
  const [aiExplanationWord, setAiExplanationWord] = useState<WordRecord | null>(null);
  const [aiExplanationText, setAiExplanationText] = useState("");
  const [isAiExplanationLoading, setIsAiExplanationLoading] = useState(false);

  // 单词本相关函数
  const loadWordRecords = useCallback(async () => {
    setIsWordLoading(true);
    try {
      const list = await tauriApi.getAllWordRecords();
      setWordRecords(list);
    } catch (error) {
      console.error("Failed to load word records:", error);
    } finally {
      setIsWordLoading(false);
    }
  }, []);

  const handleWordSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      loadWordRecords();
      return;
    }
    setIsWordLoading(true);
    try {
      const results = await tauriApi.searchWordRecords(query.trim());
      setWordRecords(results);
    } catch (error) {
      console.error("Failed to search word records:", error);
    } finally {
      setIsWordLoading(false);
    }
  }, [loadWordRecords]);

  // 防抖搜索
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      handleWordSearch(wordSearchQuery);
    }, 300); // 300ms 防抖延迟

    return () => {
      clearTimeout(timeoutId);
    };
  }, [wordSearchQuery, handleWordSearch]);

  // 切换到单词本标签页时加载数据
  useEffect(() => {
    if (!wordSearchQuery.trim()) {
      loadWordRecords();
    }
  }, [loadWordRecords, wordSearchQuery]);

  const handleEditWord = useCallback((record: WordRecord) => {
    setEditingRecord(record);
    setEditWord(record.word);
    setEditTranslation(record.translation);
    setEditContext(record.context || "");
    setEditPhonetic(record.phonetic || "");
    setEditExampleSentence(record.exampleSentence || "");
    setEditTags(record.tags.join(", "));
    setEditMasteryLevel(record.masteryLevel);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editingRecord) return;

    try {
      const tagsArray = editTags
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);

      const updated = await tauriApi.updateWordRecord(
        editingRecord.id,
        editWord.trim() || null,
        editTranslation.trim() || null,
        editContext.trim() || null,
        editPhonetic.trim() || null,
        editExampleSentence.trim() || null,
        tagsArray.length > 0 ? tagsArray : null,
        editMasteryLevel,
        null,
        null
      );

      setWordRecords((records) =>
        records.map((r) => (r.id === updated.id ? updated : r))
      );
      setEditingRecord(null);
      setEditWord("");
      setEditTranslation("");
      setEditContext("");
      setEditPhonetic("");
      setEditExampleSentence("");
      setEditTags("");
      setEditMasteryLevel(0);
    } catch (error) {
      console.error("Failed to update word record:", error);
      alert("更新失败：" + (error instanceof Error ? error.message : String(error)));
    }
  }, [editingRecord, editWord, editTranslation, editContext, editPhonetic, editExampleSentence, editTags, editMasteryLevel]);

  const handleCancelEdit = useCallback(() => {
    setEditingRecord(null);
    setEditWord("");
    setEditTranslation("");
    setEditContext("");
    setEditPhonetic("");
    setEditExampleSentence("");
    setEditTags("");
    setEditMasteryLevel(0);
  }, []);

  const handleDeleteWord = useCallback(async (id: string, word: string) => {
    const confirmed = await confirm(
      `确定要删除单词 "${word}" 吗？`,
      { title: "确认删除", kind: "warning" }
    );
    if (confirmed) {
      try {
        await tauriApi.deleteWordRecord(id);
        await loadWordRecords();
      } catch (error) {
        console.error("Failed to delete word record:", error);
        alert("删除失败：" + (error instanceof Error ? error.message : String(error)));
      }
    }
  }, [loadWordRecords]);

  // AI解释功能（流式请求）
  const handleAiExplanation = useCallback(async (record: WordRecord) => {
    setAiExplanationWord(record);
    setShowAiExplanation(true);
    setAiExplanationText("");
    setIsAiExplanationLoading(true);

    let accumulatedAnswer = '';
    let buffer = ''; // 用于处理不完整的行

    try {
      const baseUrl = ollamaSettings.base_url || 'http://localhost:11434';
      const model = ollamaSettings.model || 'llama2';
      
      const prompt = `请详细解释英语单词 "${record.word}"（中文翻译：${record.translation}）。请提供：
1. 单词的详细含义和用法
2. 词性（如果是动词，说明及物/不及物）
3. 常见搭配和短语
4. 2-3个实用的例句（中英文对照）
5. 记忆技巧或词根词缀分析（如果有）
请用中文回答，内容要详细且实用。`;

      // 尝试使用 chat API (流式)
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
          stream: true,
        }),
      });

      if (!response.ok) {
        // 如果chat API失败，尝试使用generate API作为后备
        const generateResponse = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: model,
            prompt: prompt,
            stream: true,
          }),
        });

        if (!generateResponse.ok) {
          throw new Error(`Ollama API错误: ${generateResponse.statusText}`);
        }

        // 处理 generate API 的流式响应
        const reader = generateResponse.body?.getReader();
        const decoder = new TextDecoder();
        
        if (!reader) {
          throw new Error('无法读取响应流');
        }

        // 立即开始读取，不等待
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // 处理剩余的 buffer
            if (buffer.trim()) {
              try {
                const data = JSON.parse(buffer);
                if (data.response) {
                  accumulatedAnswer += data.response;
                  flushSync(() => {
                    setAiExplanationText(accumulatedAnswer);
                  });
                }
              } catch (e) {
                console.warn('解析最后的数据失败:', e, buffer);
              }
            }
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;
          const lines = buffer.split('\n');
          
          // 保留最后一个不完整的行
          buffer = lines.pop() || '';

          // 快速处理所有完整的行，累积更新后一次性刷新
          let hasUpdate = false;
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;
            
            try {
              const data = JSON.parse(trimmedLine);
              if (data.response) {
                accumulatedAnswer += data.response;
                hasUpdate = true;
              }
              if (data.done) {
                flushSync(() => {
                  setIsAiExplanationLoading(false);
                  setAiExplanationText(accumulatedAnswer);
                });
                return;
              }
            } catch (e) {
              // 忽略解析错误，继续处理下一行
              console.warn('解析流式数据失败:', e, trimmedLine);
            }
          }
          
          // 如果有更新，立即更新UI（一次性更新，避免多次flushSync）
          if (hasUpdate) {
            flushSync(() => {
              setAiExplanationText(accumulatedAnswer);
            });
          }
        }
        
        flushSync(() => {
          setIsAiExplanationLoading(false);
          setAiExplanationText(accumulatedAnswer);
        });
        return;
      }

      // 处理 chat API 的流式响应
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      
      if (!reader) {
        throw new Error('无法读取响应流');
      }

      // 立即开始读取，不等待
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // 处理剩余的 buffer
          if (buffer.trim()) {
            try {
              const data = JSON.parse(buffer);
              if (data.message?.content) {
                accumulatedAnswer += data.message.content;
              }
            } catch (e) {
              console.warn('解析最后的数据失败:', e, buffer);
            }
          }
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        const lines = buffer.split('\n');
        
        // 保留最后一个不完整的行
        buffer = lines.pop() || '';

        // 快速处理所有完整的行，累积更新后一次性刷新
        let hasUpdate = false;
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;
          
          try {
            const data = JSON.parse(trimmedLine);
            if (data.message?.content) {
              accumulatedAnswer += data.message.content;
              hasUpdate = true;
            }
            if (data.done) {
              flushSync(() => {
                setIsAiExplanationLoading(false);
                setAiExplanationText(accumulatedAnswer);
              });
              return;
            }
          } catch (e) {
            // 忽略解析错误，继续处理下一行
            console.warn('解析流式数据失败:', e, trimmedLine);
          }
        }
        
        // 如果有更新，立即更新UI（一次性更新，避免多次flushSync）
        if (hasUpdate) {
          flushSync(() => {
            setAiExplanationText(accumulatedAnswer);
          });
        }
      }
      
      // 流结束，确保最终状态更新
      flushSync(() => {
        setIsAiExplanationLoading(false);
        setAiExplanationText(accumulatedAnswer);
      });
    } catch (error: any) {
      console.error('AI解释失败:', error);
      flushSync(() => {
        setIsAiExplanationLoading(false);
        setAiExplanationText(`获取AI解释失败: ${error.message || '未知错误'}\n\n请确保：\n1. Ollama服务正在运行\n2. 已安装并配置了正确的模型\n3. 设置中的Ollama配置正确`);
      });
    }
  }, [ollamaSettings]);


  // 暴露刷新函数给父组件
  useEffect(() => {
    if (onRefresh) {
      // 将刷新函数通过ref暴露给父组件
      (onRefresh as any).current = loadWordRecords;
    }
  }, [loadWordRecords, onRefresh]);

  return (
    <>
      {/* 搜索栏 */}
      <div className="p-4 bg-white border-b border-gray-200">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={wordSearchQuery}
            onChange={(e) => setWordSearchQuery(e.target.value)}
            placeholder="搜索单词或翻译..."
            className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {wordSearchQuery && (
            <button
              onClick={() => {
                setWordSearchQuery("");
              }}
              className="px-4 py-2 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
            >
              清除
            </button>
          )}
        </div>
      </div>

      {/* 单词列表 */}
      <div className="flex-1 overflow-y-auto p-4">
        {isWordLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-gray-500">加载中...</div>
          </div>
        ) : wordRecords.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500">
            <div className="text-4xl mb-4">📚</div>
            <div className="text-lg mb-2">暂无单词记录</div>
            <div className="text-sm">在翻译工具中保存单词后，会显示在这里</div>
          </div>
        ) : (
          <div className="space-y-3">
            {wordRecords.map((record) => (
              <div
                key={record.id}
                className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <h3 className="text-lg font-semibold text-gray-800">
                        {record.word}
                      </h3>
                      {record.phonetic && (
                        <span className="text-sm text-gray-500">
                          [{record.phonetic}]
                        </span>
                      )}
                      {record.isFavorite && (
                        <span className="text-yellow-500">⭐</span>
                      )}
                      {record.isMastered && (
                        <span className="text-green-500 text-sm">✓ 已掌握</span>
                      )}
                    </div>
                    <div className="text-gray-700 mb-2">{record.translation}</div>
                    {record.context && (
                      <div className="text-sm text-gray-500 mb-2 italic">
                        {record.context}
                      </div>
                    )}
                    {record.exampleSentence && (
                      <div className="text-sm text-gray-600 mb-2">
                        <span className="font-medium">例句：</span>
                        {record.exampleSentence}
                      </div>
                    )}
                    {record.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-2">
                        {record.tags.map((tag, idx) => (
                          <span
                            key={idx}
                            className="px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-4 text-xs text-gray-400">
                      <span>
                        {record.sourceLang} → {record.targetLang}
                      </span>
                      <span>掌握程度: {record.masteryLevel}/5</span>
                      <span>复习次数: {record.reviewCount}</span>
                      <span>{formatDateTime(record.createdAt)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleAiExplanation(record)}
                      className="px-3 py-1 text-sm text-purple-600 hover:text-purple-800 hover:bg-purple-50 rounded transition-colors"
                      title="AI解释"
                    >
                      AI解释
                    </button>
                    <button
                      onClick={() => handleEditWord(record)}
                      className="px-3 py-1 text-sm text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded transition-colors"
                      title="编辑"
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => handleDeleteWord(record.id, record.word)}
                      className="px-3 py-1 text-sm text-red-600 hover:text-red-800 hover:bg-red-50 rounded transition-colors"
                      title="删除"
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 编辑单词对话框 */}
      {editingRecord && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-[600px] max-w-[90vw] max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold mb-4">编辑单词</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  单词 *
                </label>
                <input
                  type="text"
                  value={editWord}
                  onChange={(e) => setEditWord(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  翻译 *
                </label>
                <input
                  type="text"
                  value={editTranslation}
                  onChange={(e) => setEditTranslation(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  音标
                </label>
                <input
                  type="text"
                  value={editPhonetic}
                  onChange={(e) => setEditPhonetic(e.target.value)}
                  placeholder="例如: [wɜːd]"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  上下文
                </label>
                <textarea
                  value={editContext}
                  onChange={(e) => setEditContext(e.target.value)}
                  placeholder="单词出现的上下文"
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  例句
                </label>
                <textarea
                  value={editExampleSentence}
                  onChange={(e) => setEditExampleSentence(e.target.value)}
                  placeholder="例句"
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  标签（用逗号分隔）
                </label>
                <input
                  type="text"
                  value={editTags}
                  onChange={(e) => setEditTags(e.target.value)}
                  placeholder="例如: 常用, 动词, 商务"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  掌握程度: {editMasteryLevel}/5
                </label>
                <input
                  type="range"
                  min="0"
                  max="5"
                  value={editMasteryLevel}
                  onChange={(e) => setEditMasteryLevel(parseInt(e.target.value))}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-gray-500 mt-1">
                  <span>0</span>
                  <span>1</span>
                  <span>2</span>
                  <span>3</span>
                  <span>4</span>
                  <span>5</span>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={handleCancelEdit}
                className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded transition-colors"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    handleCancelEdit();
                  }
                }}
              >
                取消
              </button>
              <button
                onClick={handleSaveEdit}
                className="px-4 py-2 text-sm bg-blue-500 text-white hover:bg-blue-600 rounded transition-colors"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    handleSaveEdit();
                  }
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI解释对话框 */}
      {showAiExplanation && aiExplanationWord && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-[700px] max-w-[90vw] max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">
                AI解释: <span className="text-blue-600">{aiExplanationWord.word}</span>
              </h2>
              <button
                onClick={() => {
                  setShowAiExplanation(false);
                  setAiExplanationWord(null);
                  setAiExplanationText("");
                }}
                className="text-gray-500 hover:text-gray-700 transition-colors"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto mb-4">
              {isAiExplanationLoading ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-500">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mb-2"></div>
                  <div>AI正在生成解释...</div>
                </div>
              ) : (
                <div className="prose max-w-none">
                  <div className="text-gray-700 whitespace-pre-wrap leading-relaxed">
                    {aiExplanationText || "暂无解释内容"}
                  </div>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-4 border-t border-gray-200">
              <button
                onClick={() => {
                  setShowAiExplanation(false);
                  setAiExplanationWord(null);
                  setAiExplanationText("");
                }}
                className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

