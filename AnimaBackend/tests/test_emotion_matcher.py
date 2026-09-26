"""EmotionMatcher 的排序和缓存,用假 encoder,不加载真模型。"""

import numpy as np

from app.emotion.matcher import Candidate, EmotionMatcher


class FakeEncoder:
    """每个文本一个固定向量;记下被编码过哪些文本"""

    name = "fake"

    def __init__(self, table: dict[str, list[float]]):
        self.table = table
        self.calls: list[str] = []

    def encode(self, texts):
        self.calls.extend(texts)
        rows = np.array([self.table[t] for t in texts], dtype=np.float32)
        return rows / np.linalg.norm(rows, axis=1, keepdims=True)


TABLE = {
    "有点心疼": [1, 0.2, 0],
    "担心": [1, 0, 0],
    "worried": [0.9, 0.1, 0],
    "微笑": [0, 1, 0],
    "smile": [0, 1, 0.1],
    "生气": [0, 0, 1],
    "小得意": [0.1, 0.9, 0.2],
}


def test_picks_the_most_similar_candidate_and_reports_the_name():
    m = EmotionMatcher(FakeEncoder(TABLE))
    cands = [Candidate("s1", ("微笑", "smile")), Candidate("s2", ("担心", "worried")), Candidate("s3", ("生气",))]
    [r] = m.match(["有点心疼"], cands)
    # s2 的两个名字里 worried 离得更近,报的是它
    assert (r.tag, r.key, r.name) == ("有点心疼", "s2", "worried")
    assert 0.9 < r.score <= 1.0


def test_score_is_the_best_name_of_each_candidate():
    m = EmotionMatcher(FakeEncoder(TABLE))
    # 「小得意」离 smile 比离 微笑 更近一点,但都属于 s1
    [r] = m.match(["小得意"], [Candidate("s3", ("生气",)), Candidate("s1", ("微笑", "smile"))])
    assert (r.key, r.name) == ("s1", "smile")


def test_ties_go_to_the_earlier_candidate():
    table = {"x": [1, 0], "a": [1, 0], "b": [1, 0]}
    m = EmotionMatcher(FakeEncoder(table))
    [r] = m.match(["x"], [Candidate("first", ("a",)), Candidate("second", ("b",))])
    assert r.key == "first"


def test_results_follow_tag_order_and_each_text_is_encoded_once():
    enc = FakeEncoder(TABLE)
    m = EmotionMatcher(enc)
    cands = [Candidate("s1", ("微笑",)), Candidate("s2", ("担心",))]
    out = m.match(["有点心疼", "小得意", "有点心疼"], cands)
    assert [r.key for r in out] == ["s2", "s1", "s2"]
    m.match(["小得意"], cands)
    assert sorted(enc.calls) == sorted(["有点心疼", "小得意", "微笑", "担心"])


def test_cache_evicts_oldest_beyond_limit():
    enc = FakeEncoder({"a": [1, 0], "b": [0, 1], "c": [1, 1]})
    m = EmotionMatcher(enc, cache_size=2)
    m.match(["a"], [Candidate("k", ("b",))])
    m.match(["c"], [Candidate("k", ("b",))])  # 缓存里只剩 b、c
    m.match(["a"], [Candidate("k", ("b",))])
    assert enc.calls.count("a") == 2
    assert enc.calls.count("b") == 1
