"""进程里一个情绪匹配器:第一次用到时加载;没装或加载失败就抛 EmotionUnavailable,
下次请求再试(装好模型不用重启后端)。"""

from pathlib import Path
from threading import Lock

from app.config import settings
from app.emotion.encoder import MODEL_FILE, TOKENIZER_FILE, BgeEncoder
from app.emotion.matcher import EmotionMatcher


class EmotionUnavailable(Exception):
    pass


_lock = Lock()
_matcher: EmotionMatcher | None = None


def get_matcher() -> EmotionMatcher:
    global _matcher
    if _matcher is not None:
        return _matcher
    with _lock:
        if _matcher is not None:
            return _matcher
        model_dir = Path(settings.emotion_model_dir)
        if not all((model_dir / f).is_file() for f in (MODEL_FILE, TOKENIZER_FILE)):
            raise EmotionUnavailable(f"情绪识别模型没装:{model_dir}")
        try:
            _matcher = EmotionMatcher(BgeEncoder(model_dir))
        except Exception as e:  # onnxruntime / tokenizers 的报错类型各不相同,原样带回去
            raise EmotionUnavailable(f"情绪识别模型加载失败:{e}") from e
        return _matcher


def reset() -> None:
    """测试用:丢掉已加载的模型,下次按当前配置重新加载"""
    global _matcher
    with _lock:
        _matcher = None
