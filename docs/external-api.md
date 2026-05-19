# DeepBot 外部调用接口

> 本文档供 AI Agent 或自动化程序读取，用于调用 DeepBot 的对外接口。

## 快速参考

```
基础地址: http://<host>:3000
认证方式: 请求头 X-Secret 的值 = 服务端环境变量 JWT_SECRET 的值
响应格式: JSON，通过 success 字段判断成功/失败
特性: 同步接口，请求会阻塞直到 AI 回复完成（最长 5 分钟）
```

---

## 接口 1：发送消息（信息接口）

向指定 Tab 发送一条普通消息，等待 AI 完整回复后返回。若 Tab 不存在，会自动创建。

```
POST /api/external/message
```

### 请求

```json
{
  "tab": "Agent1",
  "content": "你好，请帮我查一下天气",
  "timeout": 300000
}
```

- `tab`（必填）：目标 Tab 名称。匹配规则：去除所有空格后比较，`"Agent1"` 能匹配到名为 `"Agent 1"` 的 Tab。**若不存在则自动创建同名 Tab**。
- `content`（必填）：消息文本。
- `timeout`（可选）：等待超时，单位毫秒，默认 300000（5 分钟）。

### 成功响应

```json
{
  "success": true,
  "tab": "Agent 1",
  "tabCreated": false,
  "reply": "AI 的完整回复文本",
  "messageId": "msg_abc123",
  "totalDuration": 3200,
  "modelId": "gpt-4o"
}
```

- `reply`：AI 回复的完整文本内容。
- `tabCreated`：是否为本次请求自动创建的新 Tab（`true` 表示新建，`false` 表示已有）。

### 失败响应

```json
{
  "success": false,
  "error": "未找到名为 \"Agent1\" 的 Tab"
}
```

---

## 接口 2：发送指令（指令接口）

向指定 Tab 发送一条系统指令，Agent 会执行该指令（如调用工具、执行命令等），完成后返回结果。

与信息接口的区别：消息会自动加上 `[SYSTEM]` 前缀，Agent 将其视为系统级任务。**Tab 必须已存在，不会自动创建。**

```
POST /api/external/command
```

### 请求

```json
{
  "tab": "Agent1",
  "command": "检查磁盘空间并生成报告",
  "timeout": 300000
}
```

- `tab`（必填）：目标 Tab 名称，匹配规则同上。
- `command`（必填）：指令文本。
- `timeout`（可选）：等待超时，单位毫秒，默认 300000（5 分钟）。

### 成功响应

```json
{
  "success": true,
  "tab": "Agent 1",
  "result": "Agent 执行完毕后的完整输出文本",
  "messageId": "msg_def456",
  "totalDuration": 5600,
  "modelId": "gpt-4o"
}
```

- `result`：Agent 执行指令后的完整输出。

### 失败响应

```json
{
  "success": false,
  "error": "等待回复超时（300秒）"
}
```

---

## 调用示例

### curl

```bash
# 信息接口
curl -X POST http://localhost:3000/api/external/message \
  -H 'Content-Type: application/json' \
  -H 'X-Secret: your-jwt-secret' \
  -d '{"tab":"Agent1","content":"你好"}'

# 指令接口
curl -X POST http://localhost:3000/api/external/command \
  -H 'Content-Type: application/json' \
  -H 'X-Secret: your-jwt-secret' \
  -d '{"tab":"Agent1","command":"列出工作目录文件"}'
```

### Python

```python
import requests

BASE_URL = "http://localhost:3000"
SECRET = "your-jwt-secret"
HEADERS = {
    "Content-Type": "application/json",
    "X-Secret": SECRET
}

# 信息接口
resp = requests.post(
    f"{BASE_URL}/api/external/message",
    json={"tab": "Agent1", "content": "你好"},
    headers=HEADERS,
    timeout=310  # HTTP 超时要大于 body 中的 timeout
)
data = resp.json()
if data["success"]:
    print(data["reply"])
else:
    print(f"错误: {data['error']}")

# 指令接口
resp = requests.post(
    f"{BASE_URL}/api/external/command",
    json={"tab": "Agent1", "command": "检查磁盘空间"},
    headers=HEADERS,
    timeout=310
)
data = resp.json()
if data["success"]:
    print(data["result"])
else:
    print(f"错误: {data['error']}")
```

### Node.js

```javascript
const BASE_URL = "http://localhost:3000";
const SECRET = "your-jwt-secret";

// 信息接口
const resp = await fetch(`${BASE_URL}/api/external/message`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Secret": SECRET },
  body: JSON.stringify({ tab: "Agent1", content: "你好" }),
  signal: AbortSignal.timeout(310000),
});
const data = await resp.json();
if (data.success) {
  console.log(data.reply);
} else {
  console.error(data.error);
}
```

---

## 错误码速查

| HTTP 状态码 | error 内容 | 原因 |
|-------------|-----------|------|
| 401 | 缺少 X-Secret 请求头 | 未携带认证头 |
| 403 | Secret 无效 | X-Secret 值不正确 |
| 400 | 缺少 tab 参数 | 请求体缺少 tab 字段 |
| 400 | 缺少 content/command 参数 | 请求体缺少消息内容 |
| 404 | 未找到名为 "xxx" 的 Tab | Tab 名称不存在（仅指令接口，信息接口会自动创建） |
| 500 | 等待回复超时（300秒） | AI 未在超时内完成 |
| 500 | Agent 执行出错 | Agent 运行时异常 |

---

## 重要提醒

1. **HTTP 客户端超时必须大于请求体中的 timeout**。接口默认等待 5 分钟，你的 HTTP 客户端超时应设为 310 秒以上。
2. **Tab 名称匹配去除空格**。发送 `"Agent1"` 会匹配到系统中名为 `"Agent 1"` 的 Tab。
3. **信息接口自动创建 Tab**。若指定的 Tab 不存在，信息接口会自动创建同名 Tab；指令接口不会创建，返回 404。
4. **接口是同步阻塞的**。一次请求对应一次完整的 AI 回复，不需要额外建立 WebSocket 连接。
5. **同一 Tab 的并发请求会排队处理**，不会并行执行。
