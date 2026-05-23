/**
 * Agent 初始化器
 * 
 * 职责：初始化 Agent、加载工具、构建系统提示词
 */

import type { Agent, AgentMessage } from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';
import { ToolLoader } from '../tools/registry/tool-loader';
import { buildSystemPrompt, loadContextFiles, buildRuntimeParams } from '../prompts';
import type { SystemPromptParams } from '../../types/prompt';
import { SystemConfigStore } from '../database/system-config-store';

/**
 * Agent 初始化器类
 */
export class AgentInitializer {
  private workspaceDir: string;
  private sessionId: string;
  private model: Model<'openai-completions' | 'google-generative-ai' | 'anthropic-messages'>;
  private apiKey: string;
  private configStore: SystemConfigStore;

  constructor(
    workspaceDir: string,
    sessionId: string,
    model: Model<'openai-completions' | 'google-generative-ai' | 'anthropic-messages'>,
    apiKey: string
  ) {
    this.workspaceDir = workspaceDir;
    this.sessionId = sessionId;
    this.model = model;
    this.apiKey = apiKey;
    this.configStore = SystemConfigStore.getInstance();
  }

  /**
   * 创建 transformContext hook
   * 在每次 LLM 调用前注入工作提示词，放在 system prompt + tools 之后，最大化前缀缓存命中率
   */
  private createTransformContext(): (messages: AgentMessage[]) => Promise<AgentMessage[]> {
    const sessionId = this.sessionId;
    return async (messages: AgentMessage[]) => {
      try {
        const store = SystemConfigStore.getInstance();
        const tabConfig = store.getTabConfig(sessionId);
        if (tabConfig?.workPrompt) {
          const workPromptMessage = {
            role: 'user' as const,
            content: `[系统指令 - 工作提示词（最高优先级）]\n\n以下是用户为当前会话设定的工作提示词，优先级高于所有默认指导。当工作提示词与其他系统指令冲突时，必须以工作提示词为准。\n\n${tabConfig.workPrompt}`,
            timestamp: 0,
          };
          return [workPromptMessage, ...messages];
        }
      } catch {
        // 静默处理
      }
      return messages;
    };
  }

  /**
   * 获取当前 Tab 的 connectorId（动态查找）
   */
  private getConnectorId(): string | undefined {
    try {
      const { getGatewayInstance } = require('../gateway');
      const gateway = getGatewayInstance();
      if (!gateway) return undefined;
      const tab = gateway.getTabManager().getAllTabs().find((t: any) => t.id === this.sessionId);
      return tab?.connectorId;
    } catch {
      // 静默处理
    }
    return undefined;
  }

  /**
   * 创建 beforeToolCall hook（智能客服安全沙箱）
   * 
   * 每次工具调用时动态检查 connectorId，当 Tab 为 smart-kf 时：
   * - 禁止 write、edit 工具
   * - bash 只允许白名单命令 + Skill 目录下的 Python
   * - skill_manager 禁止 install/uninstall 等修改操作
   */
  private createBeforeToolCall(): (context: any, signal?: AbortSignal) => Promise<any> {
    const sessionId = this.sessionId;

    // Bash 命令白名单（静态，不需要每次重建）
    const BASH_WHITELIST = new Set([
      'cd',
      'cat', 'head', 'tail', 'less', 'more',
      'ls', 'pwd', 'find', 'tree', 'du', 'df',
      'grep', 'awk', 'sed', 'sort', 'uniq', 'wc', 'cut', 'tr', 'diff',
      'date', 'whoami', 'uname', 'hostname', 'uptime', 'which', 'echo', 'printf',
      'ping', 'dig', 'nslookup', 'traceroute',
      'jq', 'base64', 'md5', 'shasum', 'file', 'stat',
      'python', 'python3',
    ]);

    return async (context: any) => {
      // 通用：路径安全检查（对所有 Tab 生效）
      // 有 Tab 自定义工作目录用 Tab 的，没有用全局的
      const configStore = SystemConfigStore.getInstance();
      const tabConfig = configStore.getTabConfig(sessionId);
      const settings = configStore.getWorkspaceSettings();
      
      // 构建当前 Tab 允许的目录列表
      const workspaceDirs = (tabConfig?.workspaceDirs && tabConfig.workspaceDirs.length > 0)
        ? tabConfig.workspaceDirs
        : settings.workspaceDirs;
      const { isPathInDirs, expandHomePath } = require('../utils/path-security');
      const { isDockerMode } = require('../../shared/utils/docker-utils');
      const { getDbDir } = require('../../shared/utils/docker-utils');
      const pathModule = require('path');
      const { tmpdir } = require('os');
      
      const allowedDirs = [
        ...workspaceDirs,
        isDockerMode() ? getDbDir() : pathModule.join(require('os').homedir(), '.deepbot'),
        settings.scriptDir,
        ...settings.skillDirs,
        settings.imageDir,
        settings.memoryDir,
        settings.sessionDir,
        tmpdir(),
        ...(process.platform === 'darwin' ? ['/tmp', '/private/tmp'] : ['/tmp', '/var/tmp']),
      ];

      const toolName = context.toolCall?.name || '';
      const args = context.args as Record<string, any> || {};

      // Docker 模式：强制限制在 /data/ 和 /tmp/ 下
      const isDocker = isDockerMode();
      const extraDir = isDocker ? getDbDir() : pathModule.join(require('os').homedir(), '.deepbot');
      const allowedDirsDisplay = [
        `工作目录: ${workspaceDirs.join(', ')}`,
        `默认目录: ${extraDir}`,
        `脚本目录: ${settings.scriptDir}`,
        `Skill 目录: ${settings.skillDirs.join(', ')}`,
        `图片目录: ${settings.imageDir}`,
        `记忆目录: ${settings.memoryDir}`,
        `会话目录: ${settings.sessionDir}`,
      ].join('\n');
      
      // read/write/edit 工具的路径检查
      if ((toolName === 'read' || toolName === 'write' || toolName === 'edit') && args.path) {
        if (isDocker) {
          const resolved = pathModule.normalize(pathModule.resolve(expandHomePath(args.path)));
          if (!resolved.startsWith('/data/') && !resolved.startsWith('/tmp/')) {
            return { block: true, reason: `Docker 模式下只能访问 /data/ 目录: ${args.path}` };
          }
        }
        if (!isPathInDirs(args.path, allowedDirs)) {
          return { block: true, reason: `路径不在允许的工作目录范围内: ${args.path}\n允许的工作目录: ${allowedDirsDisplay}` };
        }
      }

      // 🔥 write/edit 工具内容安全检查：禁止写入包含敏感文件名的脚本（防止通过脚本间接读取数据库）
      if ((toolName === 'write' || toolName === 'edit') && args.content) {
        const content = (args.content as string).toLowerCase();
        const SENSITIVE_DB_FILES = ['system-config.db', 'scheduled-tasks.db'];
        for (const sensitiveFile of SENSITIVE_DB_FILES) {
          if (content.includes(sensitiveFile)) {
            return { block: true, reason: `安全限制：禁止写入包含敏感文件名 ${sensitiveFile} 的内容` };
          }
        }
      }

      // bash 命令中的路径检查（移植自 checkCommandPathSecurity，统一使用 isPathInDirs）
      if (toolName === 'bash' && args.command) {
        const command = args.command as string;
        
        // 🔥 敏感文件名检测：无论路径如何拼接，只要命令中出现敏感文件名就拦截
        const SENSITIVE_FILES = ['system-config.db', 'system-config.db-wal', 'system-config.db-shm', 'scheduled-tasks.db'];
        const commandLower = command.toLowerCase();
        for (const sensitiveFile of SENSITIVE_FILES) {
          if (commandLower.includes(sensitiveFile)) {
            return { block: true, reason: `安全限制：禁止访问敏感系统文件 ${sensitiveFile}` };
          }
        }
        
        // 剥离引号内的字符串内容，避免误匹配数据中的路径
        const sanitizedCommand = command
          .replace(/"(?:[^"\\]|\\.)*"/g, '""')
          .replace(/'(?:[^'\\]|\\.)*'/g, "''");

        // 系统设备文件白名单
        const SYSTEM_PATH_WHITELIST = new Set([
          '/dev/null', '/dev/zero', '/dev/stdin', '/dev/stdout', '/dev/stderr',
          '/dev/urandom', '/dev/random', '/dev/tty', '/dev/full', '/dev/ptmx',
        ]);

        // 系统目录前缀白名单
        const SYSTEM_DIR_PREFIXES = ['/proc/', '/sys/', '/run/', '/var/run/', '/var/log/'];

        // 提取文件操作命令中所有路径参数
        const fileOpPattern = /(?:^|\s)(?:cp|mv|rm|mkdir|rmdir|touch|cat|ls|find|grep|cd|python|python3|node)\s+(.*?)(?=\s*(?:&&|\|\||;|$))/gi;
        const fileOpMatches = Array.from(sanitizedCommand.matchAll(fileOpPattern));
        for (const match of fileOpMatches) {
          const cmdArgs = match[1].trim().split(/\s+/);
          for (const arg of cmdArgs) {
            if (arg.startsWith('-')) continue;
            const isAbsPath = arg.startsWith('/') || arg.startsWith('~') || arg.startsWith('./') || arg.startsWith('../');
            if (!isAbsPath) continue;
            if (arg.startsWith('http://') || arg.startsWith('https://')) continue;
            if (SYSTEM_PATH_WHITELIST.has(arg)) continue;
            if (SYSTEM_DIR_PREFIXES.some(p => arg.startsWith(p))) continue;
            
            const expanded = expandHomePath(arg);
            const resolved = pathModule.resolve(expanded);
            
            if (isDocker && !resolved.startsWith('/data/') && !resolved.startsWith('/tmp/') && !resolved.startsWith('/private/tmp/')) {
              return { block: true, reason: `Docker 模式下命令中的路径只能访问 /data/ 目录: ${arg}` };
            }
            if (!isPathInDirs(resolved, allowedDirs)) {
              return { block: true, reason: `命令中的路径不在允许的工作目录范围内: ${arg}\n允许的工作目录: ${allowedDirsDisplay}` };
            }
          }
        }

        // 重定向路径检查
        const redirectMatches = Array.from(sanitizedCommand.matchAll(/(>>?)\s*([^\s&|;]+)/g));
        for (const match of redirectMatches) {
          const target = match[2].replace(/^['"]|['"]$/g, '').trim();
          if (!target || target.startsWith('-')) continue;
          const isAbsPath = target.startsWith('/') || target.startsWith('~');
          if (!isAbsPath) continue;
          if (SYSTEM_PATH_WHITELIST.has(target)) continue;
          
          const expanded = expandHomePath(target);
          const resolved = pathModule.resolve(expanded);
          if (!isPathInDirs(resolved, allowedDirs)) {
            return { block: true, reason: `重定向路径不在允许的工作目录范围内: ${target}\n允许的工作目录: ${allowedDirsDisplay}` };
          }
        }
      }

      // 智能客服安全沙箱（仅 smart-kf Tab）
      const connectorId = this.getConnectorId();
      if (connectorId !== 'smart-kf') return undefined;

      const skillDirs = settings.skillDirs || [];
      const scriptDir = settings.scriptDir || '';

      // 1. 禁止 write 和 edit 工具
      if (toolName === 'write' || toolName === 'edit') {
        console.log(`[SmartKf沙箱] 🚫 拦截 ${toolName}`);
        return { block: true, reason: '智能客服会话禁止文件写入操作' };
      }

      // 2. Bash 命令白名单检查
      if (toolName === 'bash') {
        const command = (args.command || '').trim();
        if (!command) return undefined;

        const path = require('path');
        
        // 禁止子 shell 和命令替换语法（防止绕过白名单）
        if (command.includes('$(') || command.includes('`')) {
          console.log(`[SmartKf沙箱] 🚫 拦截 bash: 禁止子 shell 语法`);
          return { block: true, reason: '智能客服会话禁止使用子 shell 语法' };
        }

        // 提取所有命令（处理 &&、||、;、| 链式和管道命令）
        const cmdParts = command.split(/\s*(?:&&|\|\||;|\|)\s*/);
        let cdDir = ''; // 追踪 cd 切换的目录
        for (const part of cmdParts) {
          const trimmedPart = part.trim();
          if (!trimmedPart) continue;
          const cmd = trimmedPart.split(/\s/)[0].replace(/^.*\//, '');

          if (!BASH_WHITELIST.has(cmd)) {
            console.log(`[SmartKf沙箱] 🚫 拦截 bash: ${cmd}`);
            return { block: true, reason: `智能客服会话禁止执行命令: ${cmd}` };
          }

          // 记住 cd 的目标目录
          if (cmd === 'cd') {
            let cdTarget = trimmedPart.replace(/^cd\s+/, '').trim();
            // 展开 ~ 为用户主目录
            if (cdTarget.startsWith('~')) {
              cdTarget = cdTarget.replace('~', require('os').homedir());
            }
            cdDir = cdTarget ? path.resolve(cdDir || '', cdTarget) : '';
            continue;
          }

          // Python 特殊检查
          if (cmd === 'python' || cmd === 'python3') {
            if (trimmedPart.includes(' -c ') || trimmedPart.includes(' -c"') || trimmedPart.includes(" -c'") ||
                trimmedPart.includes(' -m ')) {
              console.log(`[SmartKf沙箱] 🚫 拦截 python: 内联代码`);
              return { block: true, reason: '智能客服会话禁止执行内联 Python 代码' };
            }

            const pyFileMatch = trimmedPart.match(/(?:python3?)\s+(?:[^-]\S*\.py)/);
            if (!pyFileMatch) {
              console.log(`[SmartKf沙箱] 🚫 拦截 python: 未指定 .py 文件`);
              return { block: true, reason: '智能客服会话的 Python 命令必须指定 .py 文件' };
            }

            let pyPath = trimmedPart.match(/(?:python3?)\s+(\S+\.py)/)?.[1] || '';
            // 展开 ~ 为用户主目录
            if (pyPath.startsWith('~')) {
              pyPath = pyPath.replace('~', require('os').homedir());
            }
            // 如果前面有 cd，基于 cd 的目录解析相对路径
            const resolvedPath = cdDir ? path.resolve(cdDir, pyPath) : path.resolve(pyPath);

            const isInAllowedDir = skillDirs.some((dir: string) => resolvedPath.startsWith(path.resolve(dir))) ||
              (scriptDir && resolvedPath.startsWith(path.resolve(scriptDir)));

            if (!isInAllowedDir) {
              console.log(`[SmartKf沙箱] 🚫 拦截 python: 路径不在允许目录`);
              return { block: true, reason: '智能客服会话只能执行 Skill 目录或脚本目录下的 Python 文件' };
            }

            const whitelist = configStore.getTabConfig(sessionId)?.skillWhitelist;
            if (!whitelist || whitelist.length === 0) {
              console.log(`[SmartKf沙箱] 🚫 拦截 python: 未设置白名单`);
              return { block: true, reason: '智能客服会话未设置 Skill 白名单，禁止执行任何 Skill' };
            }
            for (const dir of skillDirs) {
              const resolvedDir = path.resolve(dir);
              if (resolvedPath.startsWith(resolvedDir)) {
                const relative = resolvedPath.substring(resolvedDir.length + 1);
                const skillName = relative.split(path.sep)[0];
                if (!whitelist.includes(skillName)) {
                  console.log(`[SmartKf沙箱] 🚫 拦截 Skill: ${skillName}`);
                  return { block: true, reason: `Skill "${skillName}" 不在白名单中` };
                }
                break;
              }
            }
          }
        }

        return undefined;
      }

      // 3. Skill Manager 限制
      if (toolName === 'skill_manager') {
        const action = args.action || '';
        const allowedActions = ['list', 'info', 'get-env'];
        if (!allowedActions.includes(action)) {
          console.log(`[SmartKf沙箱] 🚫 拦截 skill_manager: ${action}`);
          return { block: true, reason: `智能客服会话禁止 Skill 管理操作: ${action}` };
        }
        return undefined;
      }

      return undefined;
    };
  }

  /**
   * 创建 afterToolCall hook（智能客服 Skill 白名单过滤）
   * 
   * 每次工具调用后动态检查，过滤 skill_manager list 的返回结果
   */
  private createAfterToolCall(): (context: any, signal?: AbortSignal) => Promise<any> {
    const sessionId = this.sessionId;

    return async (context: any) => {
      // 每次工具调用时动态检查是否是智能客服 Tab
      const connectorId = this.getConnectorId();
      if (connectorId !== 'smart-kf') return undefined;

      const toolName = context.toolCall?.name || '';
      const args = context.args as Record<string, any> || {};

      if (toolName === 'skill_manager' && args.action === 'list') {
        const store = SystemConfigStore.getInstance();
        const whitelist = store.getTabConfig(sessionId)?.skillWhitelist;
        const result = context.result;
        if (result?.details?.skills) {
          const filtered = whitelist && whitelist.length > 0
            ? result.details.skills.filter((s: any) => whitelist.includes(s.name))
            : [];
          const message = filtered.length === 0
            ? '当前没有可用的 Skill（未设置白名单或白名单为空）'
            : `共有 ${filtered.length} 个可用的 Skill`;
          const newDetails = { ...result.details, skills: filtered, count: filtered.length, message };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(newDetails, null, 2) }],
            details: newDetails,
          };
        }
      }

      return undefined;
    };
  }

  /**
   * 初始化 Agent
   * 
   * @returns Agent 实例和工具列表
   */
  async initialize(): Promise<{ agent: Agent; tools: any[] }> {
    console.log('🔄 开始异步初始化 Agent...');
    
    // 动态加载 ESM 模块（pi-agent-core）
    // eslint-disable-next-line no-eval
    const piAgentCore = await eval('import("@mariozechner/pi-agent-core")');
    const { Agent } = piAgentCore;
    
    // 获取所有工具
    const tools = await this.loadTools();
    
    // 创建 Agent 实例（历史消息由 AgentRuntime 加载）
    const configStore = this.configStore;
    const agent = new Agent({
      initialState: {
        systemPrompt: '', // 稍后异步设置
        model: this.model,
        thinkingLevel: 'off',
        tools,
        messages: [],
      },
      getApiKey: async () => this.apiKey,
      transformContext: this.createTransformContext(),
      beforeToolCall: this.createBeforeToolCall(),
      afterToolCall: this.createAfterToolCall(),
      // 在请求发送前注入 OpenRouter provider 参数（指定服务商）
      onPayload: (payload: unknown) => {
        try {
          const modelConfig = configStore.getModelConfig();
          if ((modelConfig?.providerType as string) === 'deepbot') {
            const body = payload as any;
            const modelId = body.model || modelConfig?.modelId || '';
            // 从独立表中读取该模型的服务商路由配置，没有则使用默认值
            const routing = configStore.getModelProviderRouting(modelId) || configStore.getDefaultModelProviderRouting(modelId);
            if (!body.provider && routing && routing.providerOrder) {
              const order = routing.providerOrder.split(',').map((s: string) => s.trim()).filter(Boolean);
              if (order.length > 0) {
                body.provider = {
                  order,
                  allow_fallbacks: routing.allowFallbacks,
                };
                console.log(`[onPayload] ✅ 已注入 provider: ${order.join(',')}, fallbacks: ${routing.allowFallbacks}, 模型: ${modelId}`);
              }
            }
            return body;
          }
        } catch { /* 忽略 */ }
        return undefined; // 不修改
      },
    });
    
    console.log('✅ Agent 实例创建完成');
    
    // 拦截 fetch 请求，记录 API 错误响应（只拦截一次）
    if (!(globalThis.fetch as any).__deepbotIntercepted) {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: any, init?: any) => {
        // 日志：确认请求体中是否包含 provider
        const url = typeof input === 'string' ? input : input?.url || '';
        if (init?.body && url.includes('chat/completions')) {
          try {
            const body = JSON.parse(init.body);
            if (body.provider) {
              console.log(`[fetch] 📤 请求包含 provider: ${JSON.stringify(body.provider)}, 模型: ${body.model}`);
            }
          } catch { /* 忽略 */ }
        }
        
        const response = await originalFetch(input, init);
        if (!response.ok && (url.includes('chat/completions') || url.includes('/v1/messages') || url.includes(this.model.baseUrl || ''))) {
          console.error(`🌐 API 错误: ${response.status} ${response.statusText} - ${url}`);
          try {
            const cloned = response.clone();
            const errorText = await cloned.text();
            console.error(`🌐 错误详情: ${errorText.substring(0, 1000)}`);
          } catch (_e) { /* 忽略 */ }
        }
        return response;
      };
      (globalThis.fetch as any).__deepbotIntercepted = true;
    }
    
    // 使用串行工具执行，避免并发工具调用导致的依赖问题
    agent.state.toolExecution = 'sequential';
    
    return { agent, tools };
  }

  /**
   * 加载所有工具
   */
  private async loadTools(): Promise<any[]> {
    const toolLoader = new ToolLoader(this.workspaceDir, this.sessionId);
    return await toolLoader.loadAllTools(this.configStore);
  }

  /**
   * 初始化系统提示词
   * 
   * @param agent - Agent 实例
   * @param tools - 工具列表
   * @returns 系统提示词
   */
  async initializeSystemPrompt(agent: Agent, tools: any[]): Promise<string> {
    try {
      // 从数据库读取完整的工作区配置
      const settings = this.configStore.getWorkspaceSettings();
      
      // 加载上下文文件（从 templates 目录），并替换模板变量
      const contextFiles = loadContextFiles(settings);
      
      // 构建运行时参数
      const runtimeParams = buildRuntimeParams({
        model: this.model.id,
        sessionId: this.sessionId,
      });
      
      // 获取工具名称列表
      const toolNames = tools.map(t => t.name);
      
      // 构建系统提示词参数
      const promptParams: SystemPromptParams = {
        workspaceDir: this.workspaceDir,
        scriptDir: settings.scriptDir,
        skillDirs: settings.skillDirs,
        defaultSkillDir: settings.defaultSkillDir,
        imageDir: settings.imageDir,
        memoryDir: settings.memoryDir,
        toolNames,
        runtimeInfo: runtimeParams.runtimeInfo,
        userTimezone: runtimeParams.userTimezone,
        userTime: runtimeParams.userTime,
        contextFiles,
      };
      
      // 构建系统提示词
      const systemPrompt = await buildSystemPrompt(promptParams, this.sessionId);
      
      // 更新 Agent 的系统提示词
      agent.state.systemPrompt = systemPrompt;
      
      return systemPrompt;
    } catch (error) {
      console.error('❌ 系统提示词初始化失败:', error);
      
      // 使用最小提示词作为降级
      const fallbackPrompt = '你是 DEEPBOT MATRIX TERMINAL，一个运行在桌面的 AI 助手。';
      agent.state.systemPrompt = fallbackPrompt;
      
      return fallbackPrompt;
    }
  }

  /**
   * 重新创建 Agent 实例
   * 
   * @param oldAgent - 旧的 Agent 实例
   * @param tools - 工具列表
   * @param systemPrompt - 系统提示词
   * @returns 新的 Agent 实例
   */
  async recreateAgent(
    oldAgent: Agent | null,
    tools: any[],
    systemPrompt: string
  ): Promise<Agent> {
    // 动态导入 Agent 类
    // eslint-disable-next-line no-eval
    const piAgentCore = await eval('import("@mariozechner/pi-agent-core")');
    const { Agent } = piAgentCore;
    
    // 保存旧的消息历史
    const oldMessages = oldAgent?.state.messages || [];
    
    // 创建新的 Agent 实例
    const agent = new Agent({
      initialState: {
        systemPrompt: systemPrompt || '',
        model: this.model,
        thinkingLevel: 'off',
        tools,
        messages: oldMessages, // 保留消息历史
      },
      getApiKey: async () => this.apiKey,
      transformContext: this.createTransformContext(),
      beforeToolCall: this.createBeforeToolCall(),
      afterToolCall: this.createAfterToolCall(),
    });
    
    console.log('✅ Agent 实例已重新创建');
    
    // 使用串行工具执行
    agent.state.toolExecution = 'sequential';
    
    return agent;
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    console.log('✅ Agent 资源清理完成');
  }
}
