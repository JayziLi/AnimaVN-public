"""IndexTTS 的情绪向量:校验,以及「立绘表情名 → 默认向量」这张表。

向量 8 维,顺序是 IndexTTS 官方定的。每维 0–1.2,合计不超过 1.5 —— 再高会明显影响
音色相似度(见 docs/superpowers/specs/2026-09-24-indextts-engine-design.md)。
"""

EMO_DIMS = ("高兴", "愤怒", "悲伤", "害怕", "厌恶", "忧郁", "惊讶", "平静")
DIM_MAX = 1.2
SUM_MAX = 1.5


def clean_emo_vector(raw: list[float] | None) -> list[float] | None:
    """校验并规整成 3 位小数。全 0 等于不控制,存成 None。不合格抛 ValueError,说明是哪一项。"""
    if raw is None:
        return None
    if len(raw) != len(EMO_DIMS):
        raise ValueError(f"情绪向量要正好 {len(EMO_DIMS)} 个数(现在是 {len(raw)} 个)")
    out: list[float] = []
    for name, value in zip(EMO_DIMS, raw):
        v = float(value)
        # NaN 两边都不成立,也会落到这里
        if not 0 <= v <= DIM_MAX:
            raise ValueError(f"「{name}」要在 0 到 {DIM_MAX} 之间")
        out.append(round(v, 3))
    total = sum(out)
    if total > SUM_MAX + 1e-9:
        raise ValueError(f"情绪向量合计 {total:.2f},不能超过 {SUM_MAX}")
    return out if total > 0 else None


# 表情名 / 别名 → 默认向量(没写的维度是 0;None = 不控制,沿用音色参考的语气)。
# 只是起点,要以用户试听为准
PRESETS: list[tuple[tuple[str, ...], dict[str, float] | None]] = [
    (("平静", "normal", "calm", "neutral", "说话", "talk", "默认"), None),
    (("微笑", "smile"), {"高兴": 0.4, "平静": 0.4}),
    (("开心", "高兴", "happy"), {"高兴": 0.8}),
    (("温柔", "gentle"), {"高兴": 0.3, "平静": 0.5}),
    (("认真", "serious"), {"愤怒": 0.1, "平静": 0.6}),
    (("担心", "worried"), {"害怕": 0.4, "忧郁": 0.3}),
    (("难过", "伤心", "sad"), {"悲伤": 0.8}),
    (("哭", "cry"), {"悲伤": 1.0}),
    (("惊讶", "surprised"), {"惊讶": 0.8}),
    (("慌张", "flustered"), {"害怕": 0.4, "惊讶": 0.4}),
    (("害羞", "脸红", "shy"), {"高兴": 0.3, "害怕": 0.3}),
    (("疑惑", "confused"), {"惊讶": 0.4, "平静": 0.3}),
    (("生气", "angry"), {"愤怒": 0.7}),
    (("害怕", "afraid", "scared"), {"害怕": 0.8}),
    (("厌恶", "嫌弃", "disgusted"), {"厌恶": 0.7}),
    (("忧郁", "失落", "melancholic"), {"忧郁": 0.7}),
]
_BY_NAME = {n.casefold(): dims for names, dims in PRESETS for n in names}

# 没配立绘的卡用的内置基础表情:{{sprites}} 展开成它们,立绘标签也拿它们当候选。
# 每组第一个词是名字,其余是别名;上面的默认向量正好覆盖每一项。
# 前端 frontend/src/debug/plugins/emotions.ts 抄了一份,改这里要一起改(有测试对照)
BUILTIN_EMOTIONS: list[tuple[str, tuple[str, ...]]] = [(names[0], names[1:]) for names, _ in PRESETS]


def dims_to_vector(dims: dict[str, float]) -> list[float]:
    return [dims.get(name, 0.0) for name in EMO_DIMS]


def preset_vector(names: list[str]) -> list[float] | None:
    """立绘表情名在前、别名在后,第一个在表里的为准;都不在表里 → None(不控制)。"""
    for n in names:
        key = n.strip().casefold()
        if key in _BY_NAME:
            dims = _BY_NAME[key]
            return dims_to_vector(dims) if dims else None
    return None
