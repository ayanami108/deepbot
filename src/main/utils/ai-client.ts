/**
 * AI 客户端工具
 * 
 * 提供统一的 AI API 调用接口，直接使用 fetch 调用 OpenAI/Gemini 兼容 API
 * 
 * 特性：
 * - 支持 OpenAI 兼容格式和 Google Generative AI 格式
 * - 统一处理 <think> 标签：自动过滤 AI 模型的推理过程
 */

import { getConfig } from '../config';
import { stripThinkTags } from '../../shared/utils/text-utils';

/**
 * AI 消息类型
 */
export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * AI 调用选项
 */
export interface AICallOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  apiKey?: string;
  baseUrl?: string;
  signal?: AbortSignal;
  useFastModel?: boolean;  // 是否使用快速模型（modelId2）
}

/**
 * AI 响应类型
 */
export interface AIResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * 调用 AI 模型（直接 fetch，无中间层）
 * 
 * @param messages - 消息列表
 * @param options - 调用选项
 * @returns AI 响应
 */
export async function callAI(
  messages: AIMessage[],
  options: AICallOptions = {}
): Promise<AIResponse> {
  let config;

  try {
    config = getConfig();
  } catch (error) {
    const errorMsg = '模型未配置，请在系统设置中配置 AI 模型后再使用';
    console.error('[AI Client] ❌', errorMsg);
    throw new Error(errorMsg);
  }

  const {
    temperature = 0.7,
    maxTokens,
    apiKey = config.apiKey,
    baseUrl = config.baseUrl,
    signal,
    useFastModel = false,
  } = options;

  if (signal?.aborted) {
    const err = new Error('AI 调用被取消');
    err.name = 'AbortError';
    throw err;
  }

  if (!apiKey) {
    throw new Error('AI API Key 未配置，请在系统设置中配置 AI 模型');
  }

  // 选择模型 ID（统一使用主模型）
  const modelId = options.model || config.modelId;
  
  // 构造请求 URL
  const apiType = config.apiType || 'openai-completions';
  let url: string;
  let headers: Record<string, string>;
  let body: string;

  if (apiType === 'google-generative-ai') {
    // Gemini 原生格式
    const base = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    url = `${base}/models/${modelId}:generateContent?key=${apiKey}`;
    headers = { 'Content-Type': 'application/json' };
    body = JSON.stringify({
      contents: messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      systemInstruction: messages.find(m => m.role === 'system')
        ? { parts: [{ text: messages.find(m => m.role === 'system')!.content }] }
        : undefined,
      generationConfig: {
        temperature,
        ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
      },
    });
  } else if (apiType === 'anthropic-messages') {
    // Anthropic Messages 格式
    const base = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    // 智能拼接 URL：如果 baseUrl 已经包含 /v1/messages 或 /v1，则不重复添加
    if (base.endsWith('/v1/messages')) {
      url = base;
    } else if (base.endsWith('/v1')) {
      url = `${base}/messages`;
    } else {
      url = `${base}/v1/messages`;
    }
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
    // 提取 system 消息
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role,
      content: m.content,
    }));
    body = JSON.stringify({
      model: modelId,
      messages: nonSystemMessages,
      ...(systemMsg ? { system: systemMsg.content } : {}),
      temperature,
      ...(maxTokens ? { max_tokens: maxTokens } : { max_tokens: 4096 }),
    });
  } else {
    // OpenAI 兼容格式
    const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    url = `${base}/chat/completions`;
    headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
    body = JSON.stringify({
      model: modelId,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    });
  }

  const startTime = Date.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status} ${text}`);
    }

    const result = await response.json() as any;
    const elapsed = Date.now() - startTime;
    console.log(`[AI Client] ✅ 响应耗时: ${elapsed}ms`);

    // 提取文本内容
    let responseText = '';
    if (apiType === 'google-generative-ai') {
      // Gemini 格式
      const candidate = result.candidates?.[0];
      if (candidate?.content?.parts) {
        responseText = candidate.content.parts
          .filter((p: any) => p.text)
          .map((p: any) => p.text)
          .join('');
      }
    } else if (apiType === 'anthropic-messages') {
      // Anthropic Messages 格式
      if (result.content && Array.isArray(result.content)) {
        responseText = result.content
          .filter((block: any) => block.type === 'text')
          .map((block: any) => block.text)
          .join('');
      }
    } else {
      // OpenAI 格式
      responseText = result.choices?.[0]?.message?.content || '';
    }

    if (!responseText || responseText.trim().length === 0) {
      throw new Error('AI 返回空响应');
    }

    // 移除 <think> 标签
    responseText = stripThinkTags(responseText);

    // 提取 usage
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    if (result.usage) {
      if (apiType === 'anthropic-messages') {
        // Anthropic 格式
        usage = {
          promptTokens: result.usage.input_tokens || 0,
          completionTokens: result.usage.output_tokens || 0,
          totalTokens: (result.usage.input_tokens || 0) + (result.usage.output_tokens || 0),
        };
      } else {
        usage = {
          promptTokens: result.usage.prompt_tokens || 0,
          completionTokens: result.usage.completion_tokens || 0,
          totalTokens: result.usage.total_tokens || 0,
        };
      }
    } else if (result.usageMetadata) {
      // Gemini 格式
      usage = {
        promptTokens: result.usageMetadata.promptTokenCount || 0,
        completionTokens: result.usageMetadata.candidatesTokenCount || 0,
        totalTokens: result.usageMetadata.totalTokenCount || 0,
      };
    }

    return { content: responseText.trim(), usage };
  } catch (error) {
    console.error('[AI Client] ❌ AI API 调用失败:', error);

    let errorMessage = 'AI API 调用失败';
    if (error instanceof Error) {
      if (error.name === 'AbortError') throw error;
      if (error.message.includes('401') || error.message.includes('Unauthorized')) {
        errorMessage = 'API Key 无效，请在系统设置中检查配置';
      } else if (error.message.includes('404') || error.message.includes('Not Found')) {
        errorMessage = '模型不存在，请在系统设置中检查模型 ID';
      } else if (error.message.includes('timeout')) {
        errorMessage = 'API 请求超时，请检查网络连接';
      } else {
        errorMessage = `AI API 调用失败: ${error.message}`;
      }
    }

    throw new Error(errorMessage);
  }
}