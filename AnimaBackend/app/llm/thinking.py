"""思考深浅:连接上的一个设置,发请求时翻译成请求参数。

None = 什么都不传,跟服务默认(DeepSeek、Kimi、GLM 默认都会思考)。
off = 关掉思考;low / high / max = 想得短 / 默认那么多 / 尽量多。这三档 DeepSeek、
Kimi K3、GLM-5.3 都认(2026-09-26 实测 DeepSeek 官方和 Kimi Code;GLM 套餐过期了,
只看到它对「关」的回复)。

不按地址猜哪家支持什么:同一家的不同型号也不一样 —— GLM-5.3 关不掉思考,
Kimi K3 关掉后换成 K2.8 Preview 回答。服务不认时会报错,错误原样给人看,改回「默认」就好。
设计见 docs/superpowers/specs/2026-09-26-connection-thinking-design.md
"""

from typing import Any, Literal

ThinkingLevel = Literal["off", "low", "high", "max"]


def openai_params(level: str | None) -> dict[str, Any]:
    """chat.completions.create 多带的参数。
    关:thinking.type = disabled(DeepSeek / Kimi / GLM 的写法;SDK 里没有这个参数,放 extra_body);
    深浅:reasoning_effort。只传它时思考照样开着(实测 DeepSeek),不用再带 thinking.type = enabled
    —— OpenAI 官方不认 thinking,多带反而报错。"""
    if level is None:
        return {}
    if level == "off":
        return {"extra_body": {"thinking": {"type": "disabled"}}}
    return {"reasoning_effort": level}


def anthropic_params(level: str | None) -> dict[str, Any]:
    """messages.create 多带的参数。关:thinking.type = disabled;深浅:output_config.effort(实测 Kimi Code)。"""
    if level is None:
        return {}
    if level == "off":
        return {"extra_body": {"thinking": {"type": "disabled"}}}
    return {"extra_body": {"output_config": {"effort": level}}}
