# 客户端配置

本站是 OpenAI 兼容网关，所以**任何支持「自定义 OpenAI 接口」的客户端都能接**。
需要填的通常只有两项：

| 配置项 | 填什么 |
|---|---|
| **API Base / Base URL** | `https://<本站域名>/v1`（有的客户端只填域名，不带 `/v1`） |
| **API Key** | 你在「API 密钥」页创建的 `sk-` 开头的密钥 |

> 接入地址与密钥都能在控制台的 **API 密钥** 页面直接复制，不用手打。

## 常见客户端

### Codex / OpenAI Responses 系

这类客户端使用 `/v1/responses` 协议，把 `base_url` 指向本站即可：

```toml
# ~/.codex/config.toml
model_provider = "wellwei"

[model_providers.wellwei]
name = "Wellwei"
base_url = "https://<本站域名>/v1"
wire_api = "responses"
env_key = "WELLWEI_API_KEY"
```

然后设置环境变量 `WELLWEI_API_KEY=sk-你的密钥`。

### Chatbox / Cherry Studio / LobeChat 等

在设置里选择「自定义 OpenAI 兼容服务」或「OpenAI API」，填写：

- **API 地址**：`https://<本站域名>/v1`
- **API 密钥**：你的密钥
- **模型**：手动输入模型名（见模型广场）

添加模型时，模型名照抄模型广场里的名字即可，例如 `deepseek-v4.1-flash`、`glm-5.3`。

### Claude Code / Anthropic SDK

走 `/v1/messages` 协议，把 `ANTHROPIC_BASE_URL` 指向本站：

```bash
export ANTHROPIC_BASE_URL="https://<本站域名>"
export ANTHROPIC_AUTH_TOKEN="sk-你的密钥"
```

## 注意事项

### 输出上限不要设得太小

部分 GPT 系模型要求输出上限 **至少 16**，小于这个值上游会直接拒绝。建议**省略**
`max_tokens` / `max_completion_tokens`，或给一个足够大的值（如 4096）。

### 流式与非流式都支持

`"stream": true` 的 SSE 流式响应完整支持，客户端有流式开关时按需打开即可。

### 模型名不要写死

上游供给会变，模型清单以 **模型广场** 为准。客户端里可以多配几个模型，
某个模型不可用时换一个即可——网关本身也会在多个上游线路之间自动回落。
