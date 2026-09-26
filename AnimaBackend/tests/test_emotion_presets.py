import re
from pathlib import Path

import pytest

from app.tts.emotion_presets import (
    BUILTIN_EMOTIONS,
    PRESETS,
    clean_emo_vector,
    dims_to_vector,
    preset_vector,
)


def test_preset_vector_by_name_then_alias():
    assert preset_vector(["开心"]) == [0.8, 0, 0, 0, 0, 0, 0, 0]
    assert preset_vector(["Happy"]) == [0.8, 0, 0, 0, 0, 0, 0, 0]
    # 立绘名不在表里,按别名:阿米娅的「红瞳」别名里有 angry
    assert preset_vector(["红瞳", "angry", "生气"]) == [0, 0.7, 0, 0, 0, 0, 0, 0]
    assert preset_vector(["慌张", "flustered", "害羞"]) == [0, 0, 0, 0.4, 0, 0, 0.4, 0]
    # 平静 / 说话 = 不控制;表里没有的(琴柳的「持旗」)也是不控制
    assert preset_vector(["平静", "normal"]) is None
    assert preset_vector(["说话", "talk"]) is None
    assert preset_vector(["持旗", "flag"]) is None


def test_every_preset_passes_validation():
    for _names, dims in PRESETS:
        if dims:
            vec = dims_to_vector(dims)
            assert clean_emo_vector(vec) == vec


FRONTEND_COPY = Path(__file__).resolve().parents[2] / "frontend/src/debug/plugins/emotions.ts"


def test_builtin_emotions_are_the_preset_groups():
    assert [label for label, _ in BUILTIN_EMOTIONS] == [names[0] for names, _ in PRESETS]
    assert BUILTIN_EMOTIONS[2] == ("开心", ("高兴", "happy"))


@pytest.mark.skipif(not FRONTEND_COPY.is_file(), reason="没有前端代码(比如在 Docker 里)")
def test_frontend_copy_matches():
    text = FRONTEND_COPY.read_text(encoding="utf-8")
    rows = re.findall(r"\{ label: '([^']+)', aliases: \[([^\]]*)\] \}", text)
    parsed = [(label, tuple(re.findall(r"'([^']+)'", aliases))) for label, aliases in rows]
    assert parsed == BUILTIN_EMOTIONS
