"""按连接取引擎实例。实例要跨请求保留:锁、当前加载的权重、是否预热过都记在它身上。

地址、采样步数或情绪强度改了就换一个新实例(旧实例记住的状态对新配置没有意义)。
"""

from app.models import TtsConnection
from app.tts.base import TTSEngine, TTSError
from app.tts.gpt_sovits import GptSovitsEngine
from app.tts.indextts import IndexTtsEngine

# 用户试听(2026-09-25):情绪强度高的好。服务端会先把向量归一化(合计压到 0.8 以内),
# 所以 1.0 并不会太过头
DEFAULT_EMO_ALPHA = 1.0

_engines: dict[str, tuple[tuple, TTSEngine]] = {}


def emo_alpha_of(conn: TtsConnection) -> float:
    """IndexTTS 的情绪强度,存在连接的 options 里;老数据没有就用默认值。"""
    v = (conn.options or {}).get("emo_alpha")
    return float(v) if isinstance(v, (int, float)) else DEFAULT_EMO_ALPHA


def engine_for(conn: TtsConnection) -> TTSEngine:
    sig = (conn.api_type, conn.base_url, conn.sample_steps, emo_alpha_of(conn))
    hit = _engines.get(conn.id)
    if hit is not None and hit[0] == sig:
        return hit[1]
    if conn.api_type == "gpt_sovits":
        engine: TTSEngine = GptSovitsEngine(conn.base_url, conn.sample_steps)
    elif conn.api_type == "indextts":
        engine = IndexTtsEngine(conn.base_url, emo_alpha_of(conn))
    else:
        raise TTSError(400, f"不支持的语音引擎:{conn.api_type}")
    _engines[conn.id] = (sig, engine)
    return engine


def forget_engine(conn_id: str) -> None:
    _engines.pop(conn_id, None)


def reset_engines() -> None:
    """测试用:每个测试从干净的状态开始。"""
    _engines.clear()
