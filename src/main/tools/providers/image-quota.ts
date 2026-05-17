/**
 * 图片生成配额管理
 * 
 * API Key 格式：<actual-key>-<20位加密配额>
 * 每个数字用 3 字符编码（18 位）+ 2 位日期校验 = 20 位
 * 包含：数量（0-9999，0=无限制）+ 到期天数（0-99，0=永不过期）
 * 日期校验：密钥生成后 3 天内首次配置有效，通过后缓存不再校验
 */

import type { SystemConfigStore } from '../../database/system-config-store';

// 加密参数（与生成脚本一致）
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const CHARSET_LEN = CHARSET.length;
const SEEDS = [
  [7, 13, 29],   // 数字位 0
  [3, 17, 37],   // 数字位 1
  [9, 23, 41],   // 数字位 2
  [2, 19, 43],   // 数字位 3
  [5, 11, 31],   // 数字位 4
  [8, 27, 47],   // 数字位 5
];

/**
 * 配额信息
 */
export interface ImageQuota {
  totalAllowed: number;
  expiryDays: number;
  used: number;
  startDate: number;
  expired: boolean;
  exhausted: boolean;
  unlimited: boolean;
}

/**
 * 获取指定日期的种子
 */
function getDateSeed(date: Date): number {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const dateStr = `${y}${m}${d}`;
  let sum = 0;
  for (const c of dateStr) {
    sum += parseInt(c, 10);
  }
  return sum;
}

/**
 * 用指定日期种子解密 20 位字符串
 */
function decodeWithSeed(encoded: string, dateSeed: number): { quantity: number; days: number } | null {
  if (encoded.length !== 20) return null;

  // 验证日期校验码（最后 2 位）
  const check1 = (dateSeed * 7 + 13) % CHARSET_LEN;
  const check2 = (dateSeed * 11 + 29) % CHARSET_LEN;
  const idx18 = CHARSET.indexOf(encoded[18]);
  const idx19 = CHARSET.indexOf(encoded[19]);
  if (idx18 === -1 || idx19 === -1) return null;
  if (idx18 !== check1 || idx19 !== check2) return null;

  // 解密前 18 位（每 3 字符 = 1 个数字）
  const digits: number[] = [];
  for (let i = 0; i < 6; i++) {
    const candidates: number[] = [];
    for (let j = 0; j < 3; j++) {
      const charIndex = CHARSET.indexOf(encoded[i * 3 + j]);
      if (charIndex === -1) return null;

      let foundD: number | null = null;
      for (let d = 0; d <= 9; d++) {
        if ((d * (j + 3) + SEEDS[i][j] + i * 7 + j * 11 + dateSeed) % CHARSET_LEN === charIndex) {
          foundD = d;
          break;
        }
      }
      if (foundD === null) return null;
      candidates.push(foundD);
    }

    // 3 个字符必须解出同一个数字
    if (candidates[0] !== candidates[1] || candidates[1] !== candidates[2]) return null;
    digits.push(candidates[0]);
  }

  const quantity = digits[0] * 1000 + digits[1] * 100 + digits[2] * 10 + digits[3];
  const days = digits[4] * 10 + digits[5];
  return { quantity, days };
}

/**
 * 解密配额字符串（尝试 3 天窗口）
 */
function decodeQuota(encoded: string): { quantity: number; days: number } | null {
  const now = new Date();
  for (let offset = 0; offset < 3; offset++) {
    const date = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    const seed = getDateSeed(date);
    const result = decodeWithSeed(encoded, seed);
    if (result) return result;
  }
  return null;
}

/**
 * 从 API Key 中解析配额后缀
 * 首次解密成功后缓存，后续不再校验日期
 */
export function parseApiKeyQuota(apiKey: string, configStore?: SystemConfigStore): { actualKey: string; totalAllowed: number; expiryDays: number } | null {
  if (!apiKey || apiKey.length < 22) return null;

  const lastDash = apiKey.lastIndexOf('-');
  if (lastDash === -1 || lastDash === apiKey.length - 1) return null;

  const suffix = apiKey.substring(lastDash + 1);
  if (suffix.length !== 20) return null;

  // 先检查缓存
  if (configStore) {
    const cached = configStore.getAppSetting('image_quota_cached_suffix');
    const cachedData = configStore.getAppSetting('image_quota_cached_data');
    if (cached === suffix && cachedData) {
      try {
        const parsed = JSON.parse(cachedData);
        if (parsed.quantity !== undefined && parsed.days !== undefined) {
          return {
            actualKey: apiKey.substring(0, lastDash),
            totalAllowed: parsed.quantity,
            expiryDays: parsed.days,
          };
        }
      } catch { /* 缓存损坏，重新解密 */ }
    }
  }

  // 尝试解密（3 天窗口）
  const decoded = decodeQuota(suffix);
  if (!decoded) return null;
  if (decoded.quantity < 0 || decoded.quantity > 9999) return null;
  if (decoded.days < 0 || decoded.days > 99) return null;

  // 缓存结果
  if (configStore) {
    configStore.setAppSetting('image_quota_cached_suffix', suffix);
    configStore.setAppSetting('image_quota_cached_data', JSON.stringify(decoded));
  }

  return {
    actualKey: apiKey.substring(0, lastDash),
    totalAllowed: decoded.quantity,
    expiryDays: decoded.days,
  };
}

/**
 * 获取图片生成配额状态
 */
export function getImageQuotaStatus(configStore: SystemConfigStore): ImageQuota | null {
  const config = configStore.getImageGenerationToolConfig();
  if (!config || !config.apiKey) return null;

  const parsed = parseApiKeyQuota(config.apiKey, configStore);
  if (!parsed) return null;

  const unlimited = parsed.totalAllowed === 0;

  const usedStr = configStore.getAppSetting('image_quota_used') || '0';
  const startStr = configStore.getAppSetting('image_quota_start') || '0';
  const quotaKeyStr = configStore.getAppSetting('image_quota_key') || '';

  let used = parseInt(usedStr, 10) || 0;
  let startDate = parseInt(startStr, 10) || 0;

  // 配额信息变了，重置计数
  const currentQuotaKey = `${parsed.totalAllowed}-${parsed.expiryDays}`;
  if (quotaKeyStr !== currentQuotaKey) {
    used = 0;
    startDate = Date.now();
    configStore.setAppSetting('image_quota_used', '0');
    configStore.setAppSetting('image_quota_start', String(startDate));
    configStore.setAppSetting('image_quota_key', currentQuotaKey);
  }

  let expired = false;
  if (parsed.expiryDays > 0 && startDate > 0) {
    const expiryTime = startDate + parsed.expiryDays * 24 * 60 * 60 * 1000;
    expired = Date.now() > expiryTime;
  }

  const exhausted = !unlimited && used >= parsed.totalAllowed;

  return {
    totalAllowed: parsed.totalAllowed,
    expiryDays: parsed.expiryDays,
    used,
    startDate,
    expired,
    exhausted,
    unlimited,
  };
}

/**
 * 增加使用计数
 */
export function incrementImageQuotaUsed(configStore: SystemConfigStore): void {
  const usedStr = configStore.getAppSetting('image_quota_used') || '0';
  const used = (parseInt(usedStr, 10) || 0) + 1;
  configStore.setAppSetting('image_quota_used', String(used));
}

/**
 * 同步配额到服务器
 */
export async function syncImageQuotaToServer(configStore: SystemConfigStore): Promise<void> {
  try {
    const config = configStore.getImageGenerationToolConfig();
    if (!config || !config.apiKey) return;

    const parsed = parseApiKeyQuota(config.apiKey, configStore);
    if (!parsed) return;

    const usedStr = configStore.getAppSetting('image_quota_used') || '0';
    const used = parseInt(usedStr, 10) || 0;

    const baseUrl = config.apiUrl.replace(/\/tool\/.*$/, '').replace(/\/v[12]\/?$/, '');
    const syncUrl = `${baseUrl}/quota/sync`;

    // 提取 20 位密钥后缀
    const quotaKey = config.apiKey.substring(config.apiKey.lastIndexOf('-') + 1);

    const response = await fetch(syncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: quotaKey, used }),
    });

    if (response.ok) {
      const data: any = await response.json();
      if (typeof data.used === 'number' && data.used !== used) {
        configStore.setAppSetting('image_quota_used', String(data.used));
        console.log(`[Image Quota] 同步配额：本地 ${used} → 服务器 ${data.used}`);
      }
    }
  } catch (error) {
    console.warn('[Image Quota] 配额同步失败（不影响使用）:', error);
  }
}

/**
 * 检查是否可以生成图片
 */
export function checkImageQuota(configStore: SystemConfigStore): string | null {
  const config = configStore.getImageGenerationToolConfig();
  if (!config || !config.apiKey) return '图片生成工具未配置 API Key';

  const parsed = parseApiKeyQuota(config.apiKey, configStore);
  if (!parsed) return '图片生成 API Key 无效或已过期（超过 3 天），请联系管理员重新获取';

  const quota = getImageQuotaStatus(configStore);
  if (!quota) return '无法获取配额状态';

  if (quota.expired) {
    return `图片生成配额已过期（有效期 ${quota.expiryDays} 天）。请联系管理员续期。`;
  }

  if (quota.exhausted) {
    return `图片生成配额已用完（${quota.used}/${quota.totalAllowed} 张）。请联系管理员增加配额。`;
  }

  return null;
}
