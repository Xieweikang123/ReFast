import { useState, useEffect, useCallback } from "react";
import { flushSync } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { confirm } from "@tauri-apps/plugin-dialog";
import { tauriApi } from "../api/tauri";
import type { WordRecord } from "../types";
import { formatDateTime } from "../utils/dateUtils";

interface WordbookPanelProps {
  ollamaSettings: { model: string; base_url: string };
  onRefresh?: () => void;
  showAiExplanation?: boolean;
  onShowAiExplanationChange?: (show: boolean) => void;
  onCloseAiExplanation?: { current: (() => void) | null };
  editingRecord?: WordRecord | null;
  onEditingRecordChange?: (record: WordRecord | null) => void;
}

export function WordbookPanel({ 
  ollamaSettings, 
  onRefresh,
  showAiExplanation: externalShowAiExplanation,
  onShowAiExplanationChange,
  onCloseAiExplanation,
  editingRecord: externalEditingRecord,
  onEditingRecordChange,
}: WordbookPanelProps) {
  // 单词助手相关状态
  const [wordRecords, setWordRecords] = useState<WordRecord[]>([]);
  const [allWordRecords, setAllWordRecords] = useState<WordRecord[]>([]); // 保存所有单词记录用于筛选
  const [wordSearchQuery, setWordSearchQuery] = useState("");
  const [masteryFilter, setMasteryFilter] = useState<number | null>(null); // null表示全部，0-5表示具体熟练度
  const [isWordLoading, setIsWordLoading] = useState(false);
  
  // 编辑相关状态（如果父组件提供了状态，使用父组件的；否则使用本地状态）
  const [internalEditingRecord, setInternalEditingRecord] = useState<WordRecord | null>(null);
  const editingRecord = externalEditingRecord !== undefined ? externalEditingRecord : internalEditingRecord;
  const setEditingRecord = useCallback((record: WordRecord | null) => {
    if (onEditingRecordChange) {
      onEditingRecordChange(record);
    } else {
      setInternalEditingRecord(record);
    }
  }, [onEditingRecordChange]);
  const [editWord, setEditWord] = useState("");
  const [editTranslation, setEditTranslation] = useState("");
  const [editContext, setEditContext] = useState("");
  const [editPhonetic, setEditPhonetic] = useState("");
  const [editExampleSentence, setEditExampleSentence] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editMasteryLevel, setEditMasteryLevel] = useState(0);
  
  // AI解释相关状态（如果父组件提供了状态，使用父组件的；否则使用本地状态）
  const [internalShowAiExplanation, setInternalShowAiExplanation] = useState(false);
  const showAiExplanation = externalShowAiExplanation !== undefined ? externalShowAiExplanation : internalShowAiExplanation;
  const setShowAiExplanation = useCallback((show: boolean) => {
    if (onShowAiExplanationChange) {
      onShowAiExplanationChange(show);
    } else {
      setInternalShowAiExplanation(show);
    }
  }, [onShowAiExplanationChange]);
  
  const [aiExplanationWord, setAiExplanationWord] = useState<WordRecord | null>(null);
  const [aiExplanationText, setAiExplanationText] = useState("");
  const [isAiExplanationLoading, setIsAiExplanationLoading] = useState(false);
  const [aiQueryWord, setAiQueryWord] = useState<string>(""); // 用于AI查词的单词
  const [hasAutoSaved, setHasAutoSaved] = useState(false); // 标记是否已自动保存


  // 应用筛选条件
  const applyFilters = useCallback((records: WordRecord[], query: string, mastery: number | null) => {
    let filtered = records;

    // 应用搜索筛选
    if (query.trim()) {
      const lowerQuery = query.trim().toLowerCase();
      filtered = filtered.filter(
        (record) =>
          record.word.toLowerCase().includes(lowerQuery) ||
          record.translation.toLowerCase().includes(lowerQuery)
      );
    }

    // 应用熟练度筛选
    if (mastery !== null) {
      filtered = filtered.filter((record) => record.masteryLevel === mastery);
    }

    setWordRecords(filtered);
  }, []);

  // 单词助手相关函数
  const loadWordRecords = useCallback(async () => {
    setIsWordLoading(true);
    try {
      const list = await tauriApi.getAllWordRecords();
      setAllWordRecords(list);
      applyFilters(list, wordSearchQuery, masteryFilter);
    } catch (error) {
      console.error("Failed to load word records:", error);
    } finally {
      setIsWordLoading(false);
    }
  }, [wordSearchQuery, masteryFilter, applyFilters]);

  const handleWordSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      // 如果没有搜索词，使用所有记录进行筛选
      applyFilters(allWordRecords, "", masteryFilter);
      return;
    }
    setIsWordLoading(true);
    try {
      const results = await tauriApi.searchWordRecords(query.trim());
      setAllWordRecords(results);
      applyFilters(results, query.trim(), masteryFilter);
    } catch (error) {
      console.error("Failed to search word records:", error);
    } finally {
      setIsWordLoading(false);
    }
  }, [allWordRecords, masteryFilter, applyFilters]);

  // 防抖搜索
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      handleWordSearch(wordSearchQuery);
    }, 300); // 300ms 防抖延迟

    return () => {
      clearTimeout(timeoutId);
    };
  }, [wordSearchQuery, handleWordSearch]);

  // 熟练度筛选变化时重新应用筛选
  useEffect(() => {
    applyFilters(allWordRecords, wordSearchQuery, masteryFilter);
  }, [masteryFilter, allWordRecords, wordSearchQuery, applyFilters]);

  // 切换到单词助手标签页时加载数据
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

      setAllWordRecords((records) =>
        records.map((r) => (r.id === updated.id ? updated : r))
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

  // 快速更新熟练度
  const handleQuickUpdateMastery = useCallback(async (id: string, newLevel: number) => {
    if (newLevel < 0 || newLevel > 5) return;
    
    try {
      const updated = await tauriApi.updateWordRecord(
        id,
        null,
        null,
        null,
        null,
        null,
        null,
        newLevel,
        null,
        null
      );
      setAllWordRecords((records) =>
        records.map((r) => (r.id === updated.id ? updated : r))
      );
      setWordRecords((records) =>
        records.map((r) => (r.id === updated.id ? updated : r))
      );
    } catch (error) {
      console.error("Failed to update mastery level:", error);
      alert("更新失败：" + (error instanceof Error ? error.message : String(error)));
    }
  }, []);

  // 关闭AI解释弹窗的统一处理
  const handleCloseAiExplanation = useCallback(() => {
    setShowAiExplanation(false);
    setAiExplanationWord(null);
    setAiQueryWord("");
    setAiExplanationText("");
  }, [setShowAiExplanation]);

  // 将关闭函数暴露给父组件（用于ESC键处理）
  useEffect(() => {
    if (onCloseAiExplanation && showAiExplanation) {
      // 通过ref暴露关闭函数给父组件
      onCloseAiExplanation.current = handleCloseAiExplanation;
      return () => {
        onCloseAiExplanation.current = null;
      };
    }
  }, [showAiExplanation, handleCloseAiExplanation, onCloseAiExplanation]);

  // AI解释功能（流式请求）
  const handleAiExplanation = useCallback(async (record: WordRecord) => {
    setAiExplanationWord(record);
    setShowAiExplanation(true);
    setAiExplanationText("");
    setIsAiExplanationLoading(true);

    let accumulatedAnswer = '';
    let buffer = ''; // 用于处理不完整的行
    let isFirstChunk = true; // 标记是否是第一个 chunk

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
          if (isFirstChunk && !done && value) {
            isFirstChunk = false;
          }
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
              if (data.response && data.response.length > 0) {
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
        if (isFirstChunk && !done && value) {
          isFirstChunk = false;
        }
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
            if (data.message?.content && data.message.content.length > 0) {
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

  // 从AI返回的文本中提取信息
  const parseAiResponse = useCallback((text: string) => {
    // 提取翻译（通常在第一个段落或"含义"部分）
    let translation = "";
    const translationMatch = text.match(/(?:含义|翻译|意思)[：:]\s*([^\n]+)/i) || 
                           text.match(/(?:是|指|表示)[：:]\s*([^\n]+)/i) ||
                           text.match(/^[^。！？\n]{5,50}[。！？]/);
    if (translationMatch) {
      translation = translationMatch[1]?.trim() || translationMatch[0]?.trim() || "";
      // 清理markdown格式
      translation = translation.replace(/\*\*/g, "").replace(/\*/g, "").replace(/`/g, "");
      if (translation.length > 100) {
        translation = translation.substring(0, 100) + "...";
      }
    }
    if (!translation) {
      // 如果没有找到明确的翻译，尝试提取第一段有意义的中文
      const lines = text.split("\n").filter(line => line.trim());
      for (const line of lines) {
        const chineseMatch = line.match(/[\u4e00-\u9fa5]{3,}/);
        if (chineseMatch && !line.includes("请") && !line.includes("提供")) {
          translation = line.replace(/\*\*/g, "").replace(/\*/g, "").replace(/`/g, "").trim();
          if (translation.length > 100) {
            translation = translation.substring(0, 100) + "...";
          }
          break;
        }
      }
    }
    if (!translation) {
      translation = "待完善";
    }

    // 提取音标
    let phonetic = null;
    const phoneticMatch = text.match(/\[([^\]]+)\]/) || text.match(/\/\/([^\/]+)\/\//);
    if (phoneticMatch && phoneticMatch[1].length < 50) {
      phonetic = phoneticMatch[1].trim();
    }

    // 提取例句（尝试找到第一个中英文对照的例句）
    let exampleSentence = null;
    const exampleMatch = text.match(/(?:例句|例子)[：:]\s*([^\n]+)/i) ||
                        text.match(/([A-Z][^。！？\n]{10,100}[。！？])\s*[（(]?[\u4e00-\u9fa5]/);
    if (exampleMatch) {
      exampleSentence = exampleMatch[1]?.trim() || "";
      if (exampleSentence.length > 200) {
        exampleSentence = exampleSentence.substring(0, 200) + "...";
      }
    }

    return { translation, phonetic, exampleSentence };
  }, []);

  // 自动保存单词到单词表
  const autoSaveWord = useCallback(async (word: string, aiText: string) => {
    try {
      // 检查单词是否已存在
      const existingRecords = await tauriApi.getAllWordRecords();
      const exists = existingRecords.some(record => 
        record.word.toLowerCase() === word.toLowerCase()
      );

      if (exists) {
        console.log(`单词 "${word}" 已存在于单词表中，跳过自动保存`);
        return;
      }

      // 解析AI返回的文本
      const { translation, phonetic, exampleSentence } = parseAiResponse(aiText);

      // 保存单词
      await tauriApi.addWordRecord(
        word,
        translation,
        "en", // 默认源语言为英语
        "zh", // 默认目标语言为中文
        aiText.length > 500 ? aiText.substring(0, 500) + "..." : aiText, // 将完整AI解释作为上下文
        phonetic,
        exampleSentence,
        ["AI查词"] // 添加标签
      );

      // 刷新单词列表
      await loadWordRecords();
      setHasAutoSaved(true);
      console.log(`单词 "${word}" 已自动保存到单词表`);
    } catch (error) {
      console.error("自动保存单词失败:", error);
      // 不显示错误提示，静默失败
    }
  }, [parseAiResponse, loadWordRecords]);

  // AI查词功能（流式请求）
  const handleAiQuery = useCallback(async (word: string) => {
    if (!word.trim()) {
      alert("请输入要查询的单词");
      return;
    }

    setAiQueryWord(word.trim());
    setAiExplanationWord(null); // 清空之前的单词记录
    setShowAiExplanation(true);
    setAiExplanationText("");
    setIsAiExplanationLoading(true);
    setHasAutoSaved(false); // 重置自动保存标记

    let accumulatedAnswer = '';
    let buffer = ''; // 用于处理不完整的行
    let isFirstChunk = true; // 标记是否是第一个 chunk

    try {
      const baseUrl = ollamaSettings.base_url || 'http://localhost:11434';
      const model = ollamaSettings.model || 'llama2';
      
      const prompt = `请详细解释英语单词 "${word.trim()}"。请提供：
1. 单词的详细含义和用法
2. 词性（如果是动词，说明及物/不及物）
3. 音标（如果知道）
4. 常见搭配和短语
5. 2-3个实用的例句（中英文对照）
6. 记忆技巧或词根词缀分析（如果有）
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
          if (isFirstChunk && !done && value) {
            isFirstChunk = false;
          }
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
                // AI查词完成，自动保存（generate API done）
                if (accumulatedAnswer && !hasAutoSaved) {
                  autoSaveWord(word.trim(), accumulatedAnswer);
                }
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
        // AI查词完成，自动保存（generate API流结束）
        if (accumulatedAnswer && !hasAutoSaved) {
          autoSaveWord(word.trim(), accumulatedAnswer);
        }
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
        if (isFirstChunk && !done && value) {
          isFirstChunk = false;
        }
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
              // AI查词完成，自动保存（chat API done）
              if (accumulatedAnswer && !hasAutoSaved) {
                autoSaveWord(word.trim(), accumulatedAnswer);
              }
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
      // AI查词完成，自动保存（chat API流结束）
      if (accumulatedAnswer && !hasAutoSaved) {
        autoSaveWord(word.trim(), accumulatedAnswer);
      }
    } catch (error: any) {
      console.error('AI查词失败:', error);
      flushSync(() => {
        setIsAiExplanationLoading(false);
        setAiExplanationText(`获取AI查词结果失败: ${error.message || '未知错误'}\n\n请确保：\n1. Ollama服务正在运行\n2. 已安装并配置了正确的模型\n3. 设置中的Ollama配置正确`);
      });
    }
  }, [ollamaSettings, setShowAiExplanation, autoSaveWord, hasAutoSaved]);

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
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={wordSearchQuery}
              onChange={(e) => setWordSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && wordSearchQuery.trim()) {
                  handleAiQuery(wordSearchQuery.trim());
                }
              }}
              placeholder="搜索单词或翻译..."
              className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {wordSearchQuery.trim() && (
              <button
                onClick={() => handleAiQuery(wordSearchQuery.trim())}
                className="px-4 py-2 text-sm bg-purple-500 text-white hover:bg-purple-600 rounded-md transition-colors"
                title="使用AI查询单词"
              >
                AI查词
              </button>
            )}
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
          {/* 熟练度统计 */}
          {allWordRecords.length > 0 && (
            <div className="mt-3 pt-3 border-t border-gray-200">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="text-xs text-gray-600">
                  <span className="font-medium">总计:</span> {allWordRecords.length} 个单词
                </div>
                <div className="text-xs text-gray-600">
                  <span className="font-medium">已掌握:</span> {allWordRecords.filter((r) => r.isMastered).length}
                </div>
                <div className="text-xs text-gray-600">
                  <span className="font-medium">收藏:</span> {allWordRecords.filter((r) => r.isFavorite).length}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-gray-600 font-medium">熟练度分布:</span>
                  <button
                    onClick={() => setMasteryFilter(null)}
                    className={`text-xs px-2 py-0.5 rounded transition-colors ${
                      masteryFilter === null
                        ? "bg-blue-500 text-white font-medium"
                        : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"
                    }`}
                    title="显示全部"
                  >
                    全部
                  </button>
                  {[0, 1, 2, 3, 4, 5].map((level) => {
                    const count = allWordRecords.filter((r) => r.masteryLevel === level).length;
                    const percentage = allWordRecords.length > 0 ? (count / allWordRecords.length) * 100 : 0;
                    const isSelected = masteryFilter === level;
                    return (
                      <div key={level} className="flex items-center gap-1">
                        <span className="text-xs text-gray-500">{level}/5:</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setMasteryFilter(isSelected ? null : level);
                          }}
                          className={`flex items-center gap-1 text-xs font-medium px-1 py-0.5 rounded transition-colors cursor-pointer ${
                            isSelected
                              ? "bg-blue-500 text-white"
                              : "text-gray-700 hover:text-blue-600 hover:bg-blue-50"
                          }`}
                          title={`点击筛选熟练度为 ${level}/5 的单词`}
                        >
                          <span>{count}</span>
                          <div className="w-12 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                            <div
                              className={`h-full transition-all ${
                                level === 0
                                  ? "bg-gray-400"
                                  : level <= 2
                                  ? "bg-yellow-400"
                                  : level <= 4
                                  ? "bg-blue-400"
                                  : "bg-green-500"
                              }`}
                              style={{ width: `${percentage}%` }}
                            />
                          </div>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
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
            <div className="text-sm">在单词助手中保存单词后，会显示在这里</div>
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
                    <div className="text-gray-700 mb-2 prose prose-sm max-w-none">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          p: ({ children }: any) => <p className="mb-1 last:mb-0">{children}</p>,
                          ul: ({ children }: any) => <ul className="list-disc list-inside mb-1 space-y-0.5">{children}</ul>,
                          ol: ({ children }: any) => <ol className="list-decimal list-inside mb-1 space-y-0.5">{children}</ol>,
                          li: ({ children }: any) => <li className="ml-1">{children}</li>,
                          strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
                          em: ({ children }: any) => <em className="italic">{children}</em>,
                          code: ({ inline, children }: any) => 
                            inline ? (
                              <code className="bg-gray-100 px-1 py-0.5 rounded text-xs font-mono">{children}</code>
                            ) : (
                              <code className="block bg-gray-100 p-2 rounded text-xs font-mono overflow-x-auto mb-1">{children}</code>
                            ),
                        }}
                      >
                        {record.translation}
                      </ReactMarkdown>
                    </div>
                    {record.context && (
                      <div className="text-sm text-gray-500 mb-2 italic prose prose-sm max-w-none">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            p: ({ children }: any) => <p className="mb-1 last:mb-0">{children}</p>,
                            strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
                            em: ({ children }: any) => <em className="italic">{children}</em>,
                          }}
                        >
                          {record.context}
                        </ReactMarkdown>
                      </div>
                    )}
                    {record.exampleSentence && (
                      <div className="text-sm text-gray-600 mb-2 prose prose-sm max-w-none">
                        <span className="font-medium">例句：</span>
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            p: ({ children }: any) => <span className="inline">{children}</span>,
                            strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
                            em: ({ children }: any) => <em className="italic">{children}</em>,
                          }}
                        >
                          {record.exampleSentence}
                        </ReactMarkdown>
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
                      <div className="flex items-center gap-1">
                        <span>掌握程度:</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const newLevel = Math.max(0, record.masteryLevel - 1);
                            handleQuickUpdateMastery(record.id, newLevel);
                          }}
                          className="px-1 py-0.5 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          disabled={record.masteryLevel <= 0}
                          title="减少熟练度"
                        >
                          −
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const levels = [0, 1, 2, 3, 4, 5];
                            const currentIndex = levels.indexOf(record.masteryLevel);
                            const nextIndex = (currentIndex + 1) % levels.length;
                            handleQuickUpdateMastery(record.id, levels[nextIndex]);
                          }}
                          className="px-2 py-0.5 text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors font-medium min-w-[2rem] text-center"
                          title="点击切换熟练度 (0-5)"
                        >
                          {record.masteryLevel}/5
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const newLevel = Math.min(5, record.masteryLevel + 1);
                            handleQuickUpdateMastery(record.id, newLevel);
                          }}
                          className="px-1 py-0.5 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          disabled={record.masteryLevel >= 5}
                          title="增加熟练度"
                        >
                          +
                        </button>
                      </div>
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
      {showAiExplanation && (aiExplanationWord || aiQueryWord) && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-[700px] max-w-[90vw] max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">
                {aiExplanationWord ? "AI解释" : "AI查词"}: <span className="text-blue-600">{aiExplanationWord?.word || aiQueryWord}</span>
              </h2>
              <button
                onClick={handleCloseAiExplanation}
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
              {isAiExplanationLoading && !aiExplanationText ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-500">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mb-2"></div>
                  <div>AI正在生成解释...</div>
                </div>
              ) : (
                <div className="prose max-w-none">
                  {isAiExplanationLoading && (
                    <div className="flex items-center gap-2 mb-2 text-sm text-gray-500">
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                      <span>AI正在生成解释...</span>
                    </div>
                  )}
                  <div className="text-gray-700 leading-relaxed">
                    {aiExplanationText ? (
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          // 自定义样式
                          p: ({ children }: any) => <p className="mb-3 last:mb-0">{children}</p>,
                          h1: ({ children }: any) => <h1 className="text-2xl font-bold mb-3 mt-4 first:mt-0">{children}</h1>,
                          h2: ({ children }: any) => <h2 className="text-xl font-bold mb-2 mt-4 first:mt-0">{children}</h2>,
                          h3: ({ children }: any) => <h3 className="text-lg font-semibold mb-2 mt-3 first:mt-0">{children}</h3>,
                          h4: ({ children }: any) => <h4 className="text-base font-semibold mb-2 mt-3 first:mt-0">{children}</h4>,
                          ul: ({ children }: any) => <ul className="list-disc list-inside mb-3 space-y-1">{children}</ul>,
                          ol: ({ children }: any) => <ol className="list-decimal list-inside mb-3 space-y-1">{children}</ol>,
                          li: ({ children }: any) => <li className="ml-2">{children}</li>,
                          code: ({ inline, children }: any) => 
                            inline ? (
                              <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono">{children}</code>
                            ) : (
                              <code className="block bg-gray-100 p-3 rounded text-sm font-mono overflow-x-auto mb-3">{children}</code>
                            ),
                          pre: ({ children }: any) => <pre className="mb-3">{children}</pre>,
                          blockquote: ({ children }: any) => (
                            <blockquote className="border-l-4 border-gray-300 pl-4 italic my-3">{children}</blockquote>
                          ),
                          table: ({ children }: any) => (
                            <div className="overflow-x-auto mb-3">
                              <table className="min-w-full border border-gray-300">{children}</table>
                            </div>
                          ),
                          thead: ({ children }: any) => <thead className="bg-gray-50">{children}</thead>,
                          tbody: ({ children }: any) => <tbody>{children}</tbody>,
                          tr: ({ children }: any) => <tr className="border-b border-gray-200">{children}</tr>,
                          th: ({ children }: any) => <th className="px-4 py-2 text-left font-semibold">{children}</th>,
                          td: ({ children }: any) => <td className="px-4 py-2">{children}</td>,
                          hr: () => <hr className="my-4 border-gray-300" />,
                          strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
                          em: ({ children }: any) => <em className="italic">{children}</em>,
                        }}
                      >
                        {aiExplanationText}
                      </ReactMarkdown>
                    ) : (
                      <div className="text-gray-400 italic">暂无解释内容</div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-4 border-t border-gray-200">
              <button
                onClick={handleCloseAiExplanation}
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

