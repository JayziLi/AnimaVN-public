# 连接上的「思考」深浅

状态：已实现（2026-09-26）

## 目标

DeepSeek（`deepseek-v4-pro`）每条回复要先思考很久，视觉小说里正文要等思考完才开始出。9/24–26 的 164 条回复里，思考中位数 23 秒，最慢的一成要 46–62 秒。用户要能让它少想或者不想。

## 已定的决定

| 项 | 决定 |
|---|---|
| 放在哪 | API 连接上，和「流式」开关放在一起；不放预设。SillyTavern 放在预设里，是因为它的预设连模型一起存着；我们的模型存在连接上，思考深浅是模型的属性，跟着连接走。切到别的连接时，DeepSeek 的设置不会被带过去 |
| 档位 | 默认（什么都不传，跟服务走）/ 关 / 低 / 高 / 最大。存成 `null` / `off` / `low` / `high` / `max` |
| 不按地址猜 | 所有连接给同一套选项（Mock 连接不显示）。同一家的不同型号能力不一样：GLM-5.3 关不掉思考，Kimi K3 关掉后换成 K2.8 Preview 回答。服务不认时，它的报错原样显示，改回「默认」就好 |
| 预设里的采样参数 | 不做。温度、回复长度、频率惩罚等导入时存着，但发请求时照旧不带，用服务默认值（用户定的） |
| Anthropic 格式的 `max_tokens` | 不动，仍是 1024。实测 Kimi 选「最大」时照样出正文 |

## 怎么翻译成请求参数（`AnimaBackend/app/llm/thinking.py`）

| 档位 | OpenAI 格式 | Anthropic 格式 |
|---|---|---|
| 默认 | 不带 | 不带 |
| 关 | `thinking: {"type": "disabled"}` | `thinking: {"type": "disabled"}` |
| 低 / 高 / 最大 | `reasoning_effort: low / high / max` | `output_config: {"effort": low / high / max}` |

- OpenAI 格式只传 `reasoning_effort`、不带 `thinking.type = enabled`：DeepSeek 只传它时思考照样开着；OpenAI 官方不认 `thinking`，多带会报错。
- `thinking`、`output_config` 放在 SDK 的 `extra_body` 里；流式和非流式（包括连接页的「发送测试消息」）都带。

## 实测（2026-09-26，短提示词）

| 服务 | 结果 |
|---|---|
| DeepSeek 官方，OpenAI 格式 | 四种设法都认。关掉后正文 1.1 秒开始出；走程序的「测试消息」：默认 5.8 秒、关 2.1 秒、低 3.9 秒、高 4.6 秒 |
| Kimi Code（`k3`），Anthropic 格式 | 都认。关：没有思考；low 思考 24 字；max 思考 1773 字 |
| GLM（`glm-5.3`），Anthropic 格式 | 套餐过期，测不了深浅；「关」返回 400「该模型始终思考，不支持关闭思考；请使用 low、high 或 max」 |

短提示词上各档差别不大，真实聊天上下文长、差得更多，要在游戏里对比。

## 数据

- `api_connections.thinking`：`VARCHAR(16)`，可空，空 = 默认。老库跑 `AnimaBackend/scripts/migrate_connection_thinking_column.py`（可以重复跑；本机的库 2026-09-26 已经跑过）
- 接口：`POST /api/connections`、`PUT /api/connections/{id}` 收 `thinking`（`PUT` 传 `null` = 改回默认，不传 = 不变，别的值 422）；列表和详情返回 `thinking`
