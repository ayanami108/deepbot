/**
 * Token 用量统计模块
 * 
 * 功能：
 * - 估算文本的 token 数（中文字符≈1.5 token，英文4字符≈1 token）
 * - 记录每日 token 用量（按模型累加）
 * - 查询指定日期范围的 token 用量
 */

import type Database from '../../shared/utils/sqlite-adapter';

/**
 * 计算文本的字符数（中文=1，英文/数字/符号=0.5）
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  
  const cjkMatches = text.match(/[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u30FF\uAC00-\uD7AF\uFF00-\uFFEF]/g);
  const cjkChars = cjkMatches ? cjkMatches.length : 0;
  const otherChars = text.length - cjkChars;
  
  return Math.ceil(cjkChars + otherChars * 0.5);
}

/**
 * 获取当前日期字符串（YYYY-MM-DD）
 */
function getTodayDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 记录用量（累加到当天快照）
 */
export function recordTokenUsage(
  db: Database.Database,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  requestCount: number = 1
): void {
  const date = getTodayDate();
  
  db.prepare(`
    INSERT INTO token_usage_daily (date, model_id, input_tokens, output_tokens, request_count)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date, model_id) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      request_count = request_count + excluded.request_count
  `).run(date, modelId, inputTokens, outputTokens, requestCount);
}

/**
 * Token 用量查询结果
 */
export interface TokenUsageRecord {
  date: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
}

/**
 * 查询指定日期范围的 token 用量
 */
export function getTokenUsage(
  db: Database.Database,
  startDate: string,
  endDate: string
): TokenUsageRecord[] {
  const rows = db.prepare(`
    SELECT date, model_id, input_tokens, output_tokens, request_count
    FROM token_usage_daily
    WHERE date >= ? AND date <= ?
    ORDER BY date DESC, model_id ASC
  `).all(startDate, endDate) as any[];
  
  return rows.map(row => ({
    date: row.date,
    modelId: row.model_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    requestCount: row.request_count,
  }));
}
