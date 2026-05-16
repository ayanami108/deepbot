/**
 * 图片生成工具
 * 
 * 支持多个图片生成提供商：
 * - Gemini 3 Pro Image (Nano Banana Pro)
 * - Qwen-Image 系列 (qwen-image-2.0-pro, qwen-image-2.0, qwen-image-max, qwen-image-plus)
 */

import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { TOOL_NAMES } from './tool-names';
import { getErrorMessage } from '../../shared/utils/error-handler';
import { ensureDirectoryExists } from '../../shared/utils/fs-utils';
import type { SystemConfigStore } from '../database/system-config-store';
import { generateImageWithGemini } from './providers/gemini-provider';
import { generateImageWithQwen } from './providers/qwen-provider';
import { generateImageWithGptImage2 } from './providers/gpt-image-provider';
import { expandPath } from './providers/image-utils';
import type { ToolPlugin, ToolCreateOptions } from './registry/tool-interface';

// 默认输出目录
const DEFAULT_OUTPUT_DIR = join(homedir(), '.deepbot', 'generated-images');

/**
 * 获取工具配置（完全从数据库读取，不使用默认值）
 * 支持 Tab 级别配置覆盖全局配置
 */
function getToolConfig(configStore: SystemConfigStore, tabImageToolConfig?: { provider?: string; model?: string; apiUrl?: string; apiKey?: string } | null): {
  apiKey: string;
  apiUrl: string;
  model: string;
  provider: 'gemini' | 'qwen' | 'gpt-image';
  defaultOutputDir: string;
} {
  const dbConfig = configStore.getImageGenerationToolConfig();
  
  if (!dbConfig && !tabImageToolConfig) {
    throw new Error('图片生成工具未配置。请在系统设置 > 工具配置中配置 API Key 和地址');
  }
  
  // Tab 级别配置覆盖全局配置
  const effectiveApiKey = (tabImageToolConfig?.apiKey || dbConfig?.apiKey || '').trim();
  const effectiveApiUrl = (tabImageToolConfig?.apiUrl || dbConfig?.apiUrl || '').trim();
  const effectiveModel = (tabImageToolConfig?.model || dbConfig?.model || '').trim();
  const effectiveProvider = tabImageToolConfig?.provider || dbConfig?.provider;
  
  if (!effectiveApiKey) {
    throw new Error('API Key 未配置。请在系统设置 > 工具配置中配置 API Key');
  }
  
  if (!effectiveApiUrl) {
    throw new Error('API 地址未配置。请在系统设置 > 工具配置中配置 API 地址');
  }
  
  if (!effectiveModel) {
    throw new Error('模型未配置。请在系统设置 > 工具配置中选择模型');
  }
  
  // 根据保存的提供商或模型名称判断
  let provider: 'gemini' | 'qwen' | 'gpt-image' = 'gemini';
  if (effectiveProvider === 'qwen' || (!effectiveProvider && effectiveModel.includes('qwen-image'))) {
    provider = 'qwen';
  } else if (effectiveProvider === 'deepbot-gpt' || (!effectiveProvider && effectiveModel.includes('gpt-image'))) {
    provider = 'gpt-image';
  }
  // deepbot 提供商走 gemini 逻辑，无需特殊处理
  
  return {
    apiKey: effectiveApiKey,
    apiUrl: effectiveApiUrl,
    model: effectiveModel,
    provider,
    defaultOutputDir: DEFAULT_OUTPUT_DIR,
  };
}

/**
 * 图片生成参数
 */
const ImageGenerationSchema = Type.Object({
  prompt: Type.String({
    description: '图片生成提示词（中文或英文）',
  }),
  aspectRatio: Type.Optional(Type.Union([
    Type.Literal('1:1', { description: '正方形' }),
    Type.Literal('4:3', { description: '横向标准' }),
    Type.Literal('16:9', { description: '宽屏（默认）' }),
    Type.Literal('9:16', { description: '竖屏' }),
    Type.Literal('3:4', { description: '竖向标准' }),
    Type.Literal('3:2', { description: '横向照片' }),
    Type.Literal('2:3', { description: '竖向照片' }),
    Type.Literal('4:5', { description: '社交媒体竖屏' }),
    Type.Literal('5:4', { description: '社交媒体横屏' }),
    Type.Literal('21:9', { description: '超宽屏' }),
  ])),
  resolution: Type.Optional(Type.Union([
    Type.Literal('1K', { description: '约1024px（默认）' }),
    Type.Literal('2K', { description: '约2048px' }),
  ])),
  referenceImages: Type.Optional(Type.Array(Type.String(), {
    description: '参考图片路径列表（可选，最多5张）。用于风格参考或图片编辑。按顺序使用',
  })),
  outputPath: Type.Optional(Type.String({
    description: '输出文件路径（可选）。默认保存到 ~/.deepbot/generated-images/',
  })),
});

/**
 * 调用对应提供商生成图片
 */
async function generateImage(params: {
  prompt: string;
  aspectRatio?: '1:1' | '4:3' | '16:9' | '9:16' | '3:4' | '3:2' | '2:3' | '4:5' | '5:4' | '21:9';
  resolution?: '1K' | '2K';
  referenceImages?: string[];
  apiKey: string;
  apiUrl: string;
  model: string;
  provider: 'gemini' | 'qwen' | 'gpt-image';
  signal?: AbortSignal;
}): Promise<{ imageData: string; mimeType: string }> {
  if (params.provider === 'qwen') {
    return generateImageWithQwen(params);
  } else if (params.provider === 'gpt-image') {
    return generateImageWithGptImage2(params);
  } else {
    return generateImageWithGemini(params);
  }
}

/**
 * 保存图片到文件
 */
function saveImage(imageData: string, mimeType: string, outputDir: string, outputPath?: string): string {
  // 确定输出路径
  let finalPath: string;
  if (outputPath) {
    // 使用 expandPath 展开 ~ 和 shell 命令
    finalPath = expandPath(outputPath);
  } else {
    // 生成默认文件名
    const timestamp = Date.now();
    const ext = mimeType.split('/')[1] || 'png';
    finalPath = join(outputDir, `generated-${timestamp}.${ext}`);
  }

  // 确保目录存在
  const dir = dirname(finalPath);
  ensureDirectoryExists(dir);

  // 保存图片
  const buffer = Buffer.from(imageData, 'base64');
  writeFileSync(finalPath, buffer);

  return finalPath;
}

/**
 * 创建图片生成工具
 */
export function createImageGenerationTool(configStore: SystemConfigStore, sessionId?: string): AgentTool {
  return {
    name: TOOL_NAMES.IMAGE_GENERATION,
    label: 'Image Generation',
    description: '生成图片。支持文本生成图片、基于参考图片生成（最多5张）。可指定宽高比和分辨率。',
    parameters: ImageGenerationSchema,
    execute: async (_toolCallId: string, args: unknown, signal?: AbortSignal) => {
      try {
        const params = args as {
          prompt: string;
          aspectRatio?: '1:1' | '4:3' | '16:9' | '9:16' | '3:4' | '3:2' | '2:3' | '4:5' | '5:4' | '21:9';
          resolution?: '1K' | '2K';
          referenceImages?: string[];
          outputPath?: string;
        };

        // 检查是否已被取消（执行前）
        if (signal?.aborted) {
          const err = new Error('图片生成操作被取消');
          err.name = 'AbortError';
          throw err;
        }

        if (!params.prompt || !params.prompt.trim()) {
          throw new Error('图片生成需要提供 prompt 参数');
        }

        // 每次执行时实时从数据库读取 Tab 配置，避免闭包缓存旧值
        let tabImageToolConfig: { provider?: string; model?: string; apiUrl?: string; apiKey?: string } | null = null;
        if (sessionId) {
          try {
            const row = configStore.getDb().prepare('SELECT image_tool_config FROM agent_tabs WHERE id = ?').get(sessionId) as any;
            tabImageToolConfig = row?.image_tool_config ? JSON.parse(row.image_tool_config) : null;
          } catch { /* 静默处理 */ }
        }

        // 获取工具配置
        const toolConfig = getToolConfig(configStore, tabImageToolConfig);

        console.log(`[Image Generation] 使用提供商: ${toolConfig.provider}`);
        console.log(`[Image Generation] 模型: ${toolConfig.model}`);

        // 从配置中读取输出目录
        const workspaceSettings = configStore.getWorkspaceSettings();
        const outputDir = workspaceSettings.imageDir || DEFAULT_OUTPUT_DIR;

        console.log('[Image Generation] 开始生成图片...');
        console.log(`   提示词: ${params.prompt}`);
        console.log(`   宽高比: ${params.aspectRatio || '16:9 (默认)'}`);
        console.log(`   分辨率: ${params.resolution || '1K (默认)'}`);
        console.log(`   输出目录: ${outputDir}`);
        
        if (params.referenceImages && params.referenceImages.length > 0) {
          console.log(`   参考图片: ${params.referenceImages.length} 张`);
          params.referenceImages.forEach((img, idx) => {
            console.log(`     ${idx + 1}. ${img}`);
          });
        }

        // 检查是否已被取消（生成前）
        if (signal?.aborted) {
          const err = new Error('图片生成操作被取消');
          err.name = 'AbortError';
          throw err;
        }

        // 生成图片
        const { imageData, mimeType } = await generateImage({
          prompt: params.prompt,
          aspectRatio: params.aspectRatio,
          resolution: params.resolution,
          referenceImages: params.referenceImages,
          apiKey: toolConfig.apiKey,
          apiUrl: toolConfig.apiUrl,
          model: toolConfig.model,
          provider: toolConfig.provider,
          signal,
        });

        // 保存图片（使用配置的输出目录）
        const savedPath = saveImage(imageData, mimeType, outputDir, params.outputPath);
        // Windows 路径转正斜杠，避免 Markdown 渲染时反斜杠被当作转义字符
        const displayPath = savedPath.replace(/\\/g, '/');

        console.log('[Image Generation] ✅ 图片生成成功');
        console.log(`   保存路径: ${savedPath}`);

        return {
          type: 'tool-result',
          details: {
            success: true,
            provider: toolConfig.provider,
            path: displayPath,
            aspectRatio: params.aspectRatio || '16:9',
            resolution: params.resolution || '1K',
            referenceCount: params.referenceImages?.length || 0,
          },
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                provider: toolConfig.provider,
                message: '图片生成成功，显示图片预览时，必须直接使用 path 字段的值作为图片路径，不要添加任何前缀（如 ~ 或 file://），path 已经是完整的绝对路径',
                path: displayPath,
                aspectRatio: params.aspectRatio || '16:9',
                resolution: params.resolution || '1K',
                referenceCount: params.referenceImages?.length || 0,
                size: `${(Buffer.from(imageData, 'base64').length / 1024).toFixed(2)} KB`,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        console.error('[Image Generation] ❌ 操作失败:', error);
        const errorMessage = getErrorMessage(error);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: errorMessage,
                message: '操作失败，请检查参数和网络连接',
              }, null, 2),
            },
          ],
          details: {
            success: false,
            error: errorMessage,
          },
          isError: true,
        };
      }
    },
  };
}


// ── ToolPlugin 接口 ──────────────────────────────────────────────────────────

export const imageGenerationToolPlugin: ToolPlugin = {
  metadata: {
    id: 'image-generation',
    name: '图片生成',
    version: '1.0.0',
    description: '支持多个图片生成提供商（Gemini、Qwen）',
    author: 'DeepBot',
    category: 'ai',
    tags: ['image', 'generation', 'gemini', 'qwen'],
    requiresConfig: true,
  },
  create: (options: ToolCreateOptions) => {
    if (!options.configStore) throw new Error('imageGenerationToolPlugin 需要 configStore');
    return createImageGenerationTool(options.configStore, options.sessionId);
  },
};
