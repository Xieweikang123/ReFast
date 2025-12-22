/**
 * Ollama AI 工具函数
 * 封装与 Ollama API 交互的逻辑
 */

import { flushSync } from "react-dom";

/**
 * Ollama 设置接口
 */
export interface OllamaSettings {
  model: string;
  base_url: string;
}

/**
 * Ollama 回调函数接口
 */
export interface OllamaCallbacks {
  setAiAnswer: (answer: string) => void;
  setShowAiAnswer: (show: boolean) => void;
  setIsAiLoading: (loading: boolean) => void;
}

/**
 * 调用 Ollama API 进行 AI 问答（流式请求）
 * 
 * @param prompt - 用户输入的提示词
 * @param settings - Ollama 设置（模型和基础 URL）
 * @param callbacks - 状态更新回调函数
 */
export async function askOllama(
  prompt: string,
  settings: OllamaSettings,
  callbacks: OllamaCallbacks
): Promise<void> {
  if (!prompt.trim()) {
    return;
  }

  const { setAiAnswer, setShowAiAnswer, setIsAiLoading } = callbacks;

  // 清空之前的 AI 回答，并切换到 AI 回答模式
  setAiAnswer('');
  setShowAiAnswer(true);
  setIsAiLoading(true);
  
  let accumulatedAnswer = '';
  let buffer = ''; // 用于处理不完整的行
  
  try {
    const baseUrl = settings.base_url || 'http://localhost:11434';
    const model = settings.model || 'llama2';
    
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
        throw new Error(`Ollama API error: ${generateResponse.statusText}`);
      }

      // 处理 generate API 的流式响应
      const reader = generateResponse.body?.getReader();
      const decoder = new TextDecoder();
      
      if (!reader) {
        throw new Error('无法读取响应流');
      }

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
                  setAiAnswer(accumulatedAnswer);
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

        // 快速处理所有完整的行
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;
          
          try {
            const data = JSON.parse(trimmedLine);
            if (data.response) {
              accumulatedAnswer += data.response;
              // 立即更新 UI，不等待
              flushSync(() => {
                setAiAnswer(accumulatedAnswer);
              });
            }
            if (data.done) {
              setIsAiLoading(false);
              flushSync(() => {
                setAiAnswer(accumulatedAnswer);
              });
              return;
            }
          } catch (e) {
            // 忽略解析错误，继续处理下一行
            console.warn('解析流式数据失败:', e, trimmedLine);
          }
        }
        
        // 立即继续读取下一个 chunk，不阻塞
      }
      
      setIsAiLoading(false);
      setAiAnswer(accumulatedAnswer);
      return;
    }

    // 处理 chat API 的流式响应
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    
    if (!reader) {
      throw new Error('无法读取响应流');
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // 处理剩余的 buffer
        if (buffer.trim()) {
          try {
            const data = JSON.parse(buffer);
            if (data.message?.content) {
              accumulatedAnswer += data.message.content;
              flushSync(() => {
                setAiAnswer(accumulatedAnswer);
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

      // 快速处理所有完整的行
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        
        try {
          const data = JSON.parse(trimmedLine);
          if (data.message?.content) {
            accumulatedAnswer += data.message.content;
            // 立即更新 UI，不等待
            flushSync(() => {
              setAiAnswer(accumulatedAnswer);
            });
          }
          if (data.done) {
            setIsAiLoading(false);
            flushSync(() => {
              setAiAnswer(accumulatedAnswer);
            });
            return;
          }
        } catch (e) {
          // 忽略解析错误，继续处理下一行
          console.warn('解析流式数据失败:', e, trimmedLine);
        }
      }
      
      // 立即继续读取下一个 chunk，不阻塞
    }
    
    setIsAiLoading(false);
    setAiAnswer(accumulatedAnswer);
  } catch (error: any) {
    console.error('调用Ollama API失败:', error);
    setIsAiLoading(false);
    // 显示错误提示
    const errorMessage = error.message || '未知错误';
    const baseUrl = settings.base_url || 'http://localhost:11434';
    const model = settings.model || 'llama2';
    alert(`调用AI失败: ${errorMessage}\n\n请确保:\n1. Ollama服务正在运行\n2. 已安装模型 (例如: ollama pull ${model})\n3. 服务地址为 ${baseUrl}`);
  }
}

