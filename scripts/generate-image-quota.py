#!/usr/bin/env python3
"""
图片生成配额加密工具

用法：python generate-image-quota.py <数量> <到期天数>

参数：
  数量：0-9999（0 表示无限制）
  到期天数：0-99（0 表示永不过期）

输出：20 位加密字符串（每个数字用 3 字符编码 + 2 位日期校验），附加到 API Key 后面用 - 分隔

示例：
  python generate-image-quota.py 100 30    → 100张，30天有效期
  python generate-image-quota.py 0 0       → 无限制，永不过期
  python generate-image-quota.py 50 7      → 50张，7天有效期

使用方式：将输出的加密字符串用 - 接到 API Key 后面
  例如：sk-xxxxxxxxxxxx-AbCdEfGhJkLmNpQrStUv

注意：生成的密钥需在 3 天内配置到 DeepBot，超过 3 天需重新生成
"""

import sys
from datetime import datetime

# 加密参数（与解密端一致）
CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
CHARSET_LEN = len(CHARSET)
# 每个数字位的 3 个种子
SEEDS = [
    [7, 13, 29],   # 数字位 0
    [3, 17, 37],   # 数字位 1
    [9, 23, 41],   # 数字位 2
    [2, 19, 43],   # 数字位 3
    [5, 11, 31],   # 数字位 4
    [8, 27, 47],   # 数字位 5
]


def get_date_seed(date=None):
    """获取日期种子（YYYYMMDD 各位数字之和）"""
    if date is None:
        date = datetime.now()
    date_str = date.strftime('%Y%m%d')
    return sum(int(c) for c in date_str)


def encode(quantity: int, days: int) -> str:
    """加密数量和天数为 20 位字符串"""
    date_seed = get_date_seed()

    digits = [
        (quantity // 1000) % 10,
        (quantity // 100) % 10,
        (quantity // 10) % 10,
        quantity % 10,
        (days // 10) % 10,
        days % 10,
    ]

    # 每个数字用 3 个字符编码（18 位）
    result = ''
    for i in range(6):
        d = digits[i]
        for j in range(3):
            shifted = (d * (j + 3) + SEEDS[i][j] + i * 7 + j * 11 + date_seed) % CHARSET_LEN
            result += CHARSET[shifted]

    # 2 位日期校验码
    check1 = (date_seed * 7 + 13) % CHARSET_LEN
    check2 = (date_seed * 11 + 29) % CHARSET_LEN
    result += CHARSET[check1]
    result += CHARSET[check2]

    return result


def decode(encoded: str, date_seed: int) -> dict | None:
    """用指定日期种子解密"""
    if len(encoded) != 20:
        return None

    # 验证日期校验码（最后 2 位）
    check1 = (date_seed * 7 + 13) % CHARSET_LEN
    check2 = (date_seed * 11 + 29) % CHARSET_LEN
    if CHARSET.index(encoded[18]) != check1 or CHARSET.index(encoded[19]) != check2:
        return None

    # 解密前 18 位（每 3 个字符 = 1 个数字）
    digits = []
    for i in range(6):
        # 3 个字符都必须指向同一个数字
        candidates = []
        for j in range(3):
            char_index = CHARSET.index(encoded[i * 3 + j])
            if char_index == -1:
                return None
            found_d = None
            for d in range(10):
                if (d * (j + 3) + SEEDS[i][j] + i * 7 + j * 11 + date_seed) % CHARSET_LEN == char_index:
                    found_d = d
                    break
            if found_d is None:
                return None
            candidates.append(found_d)

        # 3 个字符必须解出同一个数字
        if candidates[0] != candidates[1] or candidates[1] != candidates[2]:
            return None
        digits.append(candidates[0])

    quantity = digits[0] * 1000 + digits[1] * 100 + digits[2] * 10 + digits[3]
    days = digits[4] * 10 + digits[5]
    return {'quantity': quantity, 'days': days}


def main():
    if len(sys.argv) < 3 or sys.argv[1] in ('-h', '--help'):
        print('用法：python generate-image-quota.py <数量> <到期天数>')
        print('')
        print('参数：')
        print('  数量：0-9999（0 表示无限制）')
        print('  到期天数：0-99（0 表示永不过期）')
        print('')
        print('示例：')
        print('  python generate-image-quota.py 100 30')
        print('  python generate-image-quota.py 0 0')
        print('')
        print('注意：生成的密钥需在 3 天内配置，超过需重新生成')
        sys.exit(0)

    quantity = int(sys.argv[1])
    days = int(sys.argv[2])

    if quantity < 0 or quantity > 9999:
        print('错误：数量必须在 0-9999 之间（0 表示无限制）')
        sys.exit(1)
    if days < 0 or days > 99:
        print('错误：到期天数必须在 0-99 之间（0 表示永不过期）')
        sys.exit(1)

    encoded = encode(quantity, days)

    # 自检
    date_seed = get_date_seed()
    decoded = decode(encoded, date_seed)
    if not decoded or decoded['quantity'] != quantity or decoded['days'] != days:
        print('错误：加密自检失败！')
        sys.exit(1)

    today = datetime.now().strftime('%Y-%m-%d')
    print('')
    print(f'📊 配额信息：')
    print(f'   数量：{"无限制" if quantity == 0 else f"{quantity} 张"}')
    print(f'   有效期：{"永不过期" if days == 0 else f"{days} 天"}')
    print(f'   生成日期：{today}（密钥 3 天内有效）')
    print('')
    print(f'🔑 加密字符串：{encoded}')
    print('')
    print(f'📋 使用方式：将以下内容附加到 API Key 末尾')
    print(f'   your-api-key-{encoded}')
    print('')


if __name__ == '__main__':
    main()
