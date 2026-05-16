/**
 * Skill Manager Tool - 主入口
 * 
 * 职责：
 * - 搜索 Skill（从 GitHub）
 * - 安装 Skill（下载到本地）
 * - 列出已安装 Skill
 * - 卸载 Skill
 * - 查看 Skill 详情
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { getErrorMessage } from '../../../shared/utils/error-handler';
import { Type } from '@sinclair/typebox';
import { TOOL_NAMES } from '../tool-names';
import { initDatabase } from './database';
import { searchSkillsOnGitHub } from './search';
import { installSkill } from './install';
import type { ToolPlugin, ToolCreateOptions } from '../registry/tool-interface';
import { listInstalledSkills, uninstallSkill, getSkillInfo, getSkillEnv, setSkillEnv, exportSkills, importSkills } from './manage';
import { parseSkillMetadata } from './utils';
import { getAllSkillPaths } from '../../config/skill-paths';
import * as path from 'path';
import * as fs from 'fs';
import { resetShellPathCache } from '../shell-env';

/**
 * 创建 Skill Manager Tool
 */
export function createSkillManagerTool(): AgentTool {
  // 初始化数据库
  const db = initDatabase();
  
  console.info('[Skill Manager] ✅ Skill Manager Tool 创建完成');
  
  return {
    name: TOOL_NAMES.SKILL_MANAGER,
    label: 'Skill Manager',
    description: `Skill 管理工具，用于搜索、安装、管理 DeepBot Skills。

功能：
- find: 从 ClawHub 查找可安装的 Skill（返回 slug、displayName、description、stars 等），仅用于查找未安装的 Skill，不能用于搜索网络信息
- install: 安装 Skill（从 ClawHub 下载，只需提供 slug）
- list: 列出已安装的 Skill
- uninstall: 卸载 Skill
- info: 查看 Skill 详情
- set-env: 设置 Skill 的环境变量配置（写入 skill 目录的 .env 文件）
- get-env: 获取 Skill 的环境变量配置

使用示例：
- 查找可安装的 Skill: { "action": "find", "query": "PDF" }
- 安装: { "action": "install", "name": "youtube-watcher" }
- 列出: { "action": "list" }
- 卸载: { "action": "uninstall", "name": "pdf-editor" }
- 详情: { "action": "info", "name": "pdf-editor" }
- 设置环境变量: { "action": "set-env", "name": "tavily-search", "env": "TAVILY_API_KEY=tvly-xxx" }
- 获取环境变量: { "action": "get-env", "name": "tavily-search" }`,
    
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('find'),
        Type.Literal('install'),
        Type.Literal('list'),
        Type.Literal('uninstall'),
        Type.Literal('info'),
        Type.Literal('get-env'),
        Type.Literal('set-env'),
        Type.Literal('enable'),
        Type.Literal('disable'),
      ], { description: '操作类型' }),
      query: Type.Optional(Type.String({ description: '查找关键词（find 操作）' })),
      name: Type.Optional(Type.String({ description: 'Skill 名称/slug（install/uninstall/info/get-env/set-env/enable/disable 操作）' })),
      includeDisabled: Type.Optional(Type.Boolean({ description: '是否包含已禁用的 Skill（list 操作，默认 false）' })),
      env: Type.Optional(Type.String({ description: '环境变量内容，格式：KEY=VALUE，每行一个（set-env 操作）' })),
    }),
    
    execute: async (toolCallId, params, signal, onUpdate) => {
      try {
        const { action, query, name, env } = params as any;
        
        let result: any;
        
        switch (action) {
          case 'find':
            if (!query) {
              throw new Error('缺少参数: query');
            }
            {
              const skills = await searchSkillsOnGitHub(query);
              result = {
                skills,
                count: skills.length,
                message: skills.length === 0 
                  ? '没有找到相关的 Skill' 
                  : `找到 ${skills.length} 个相关的 Skill`
              };
            }
            break;
          
          case 'install':
            if (!name) {
              throw new Error('缺少参数: name（skill slug）');
            }
            result = await installSkill(name, db);
            // 安装成功后标记系统提示词需要重建
            invalidateSystemPrompts();
            break;
          
          case 'list':
            {
              // 默认只返回已启用的 Skill；传 includeDisabled: true 获取全部（含禁用）
              const includeDisabled = (params as any).includeDisabled === true;
              const skills = listInstalledSkills(db, includeDisabled ? undefined : { enabled: true });
              result = {
                skills,
                count: skills.length,
                message: skills.length === 0 
                  ? '当前没有安装任何 Skill' 
                  : `共有 ${skills.length} 个已安装的 Skill`
              };
            }
            break;
          
          case 'uninstall':
            if (!name) {
              throw new Error('缺少参数: name');
            }
            uninstallSkill(name, db);
            result = { success: true, message: `Skill "${name}" 已卸载` };
            // 卸载成功后标记系统提示词需要重建
            invalidateSystemPrompts();
            break;
          
          case 'info':
            if (!name) {
              throw new Error('缺少参数: name');
            }
            result = getSkillInfo(name, db);
            break;
          
          case 'get-env':
            if (!name) throw new Error('缺少参数: name');
            result = { name, env: getSkillEnv(name) };
            break;
          
          case 'set-env':
            if (!name) throw new Error('缺少参数: name');
            if (env === undefined) throw new Error('缺少参数: env');
            setSkillEnv(name, env);
            // 自动清除环境变量缓存，下次执行命令时重新加载
            resetShellPathCache();
            result = { success: true, message: `Skill "${name}" 环境变量已保存` };
            break;
          
          case 'enable':
            if (!name) throw new Error('缺少参数: name');
            {
              const stmt = db.prepare('UPDATE skills SET enabled = 1 WHERE name = ?');
              const updateResult = stmt.run(name);
              if (updateResult.changes === 0) {
                throw new Error(`Skill "${name}" 不存在`);
              }
              refreshSkillMetadata(name, db);
              result = { success: true, message: `Skill "${name}" 已启用` };
              invalidateSystemPrompts();
            }
            break;
          
          case 'disable':
            if (!name) throw new Error('缺少参数: name');
            {
              const stmt = db.prepare('UPDATE skills SET enabled = 0 WHERE name = ?');
              const updateResult = stmt.run(name);
              if (updateResult.changes === 0) {
                throw new Error(`Skill "${name}" 不存在`);
              }
              result = { success: true, message: `Skill "${name}" 已禁用` };
              invalidateSystemPrompts();
            }
            break;
          
          case 'export':
            {
              const names = (params as any).names as string[];
              const savePath = (params as any).savePath as string | undefined;
              if (!names || names.length === 0) throw new Error('缺少参数: names');
              const zipPath = await exportSkills(names, savePath);
              result = { success: true, zipPath, savedPath: savePath || zipPath, message: `Exported ${names.length} skill(s)` };
            }
            break;
          
          case 'import':
            {
              const zipPath = (params as any).zipPath as string;
              if (!zipPath) throw new Error('缺少参数: zipPath');
              result = await importSkills(zipPath, db);
              result.success = true;
            }
            break;
          
          default:
            throw new Error(`未知操作: ${action}`);
        }
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
          details: result,
        };
      } catch (error) {
        console.error('[Skill Manager] 执行失败:', error);
        
        return {
          content: [
            {
              type: 'text',
              text: `错误: ${getErrorMessage(error)}`,
            },
          ],
          details: { error: getErrorMessage(error) },
          isError: true,
        };
      }
    },
  };
}

/**
 * 标记系统提示词需要重建（Skill 安装/卸载后调用，下次发消息时自动重新组装）
 */
function invalidateSystemPrompts(): void {
  try {
    const { getGatewayInstance } = require('../../gateway');
    const gateway = getGatewayInstance();
    if (gateway) {
      gateway.invalidateAllSystemPrompts();
    }
  } catch (error) {
    console.warn('[Skill Manager] ⚠️ 标记系统提示词重建失败:', error);
  }
}

/**
 * 重新读取 SKILL.md 并更新数据库中的 metadata（version、description 等）
 * 在 enable 时调用，确保系统提示词使用最新内容
 */
function refreshSkillMetadata(skillName: string, db: any): void {
  try {
    const skillPaths = getAllSkillPaths();
    for (const skillPath of skillPaths) {
      const skillDir = path.join(skillPath, skillName);
      const skillMdPath = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;

      const metadata = parseSkillMetadata(skillDir);
      db.prepare('UPDATE skills SET version = ?, repository = ?, metadata = ? WHERE name = ?').run(
        metadata.version || '1.0.0',
        metadata.repository || '',
        JSON.stringify(metadata),
        skillName
      );
      console.info(`[Skill Manager] 🔄 刷新 Skill 元数据: ${skillName}`);
      return;
    }
  } catch (error) {
    console.warn(`[Skill Manager] ⚠️ 刷新 Skill 元数据失败: ${skillName}`, error);
  }
}


// ── ToolPlugin 接口 ──────────────────────────────────────────────────────────

export const skillManagerToolPlugin: ToolPlugin = {
  metadata: {
    id: 'skill-manager',
    name: 'Skill 管理',
    version: '1.0.0',
    description: '搜索、安装、管理 Skill 扩展能力',
    author: 'DeepBot',
    category: 'system',
    tags: ['skill', 'manager', 'install', 'plugin'],
  },
  create: (_options: ToolCreateOptions) => createSkillManagerTool(),
};
