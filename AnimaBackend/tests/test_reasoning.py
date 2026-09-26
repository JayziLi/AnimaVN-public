from app.llm.reasoning import ThinkTagSplitter


def collect(*chunks: str):
    splitter = ThinkTagSplitter()
    body: list[str] = []
    reasoning: list[str] = []
    for chunk in chunks:
        text, thought = splitter.feed(chunk)
        body.append(text)
        reasoning.append(thought)
    text, thought = splitter.flush()
    body.append(text)
    reasoning.append(thought)
    return "".join(body), "".join(reasoning), splitter.used


def test_complete_think_block_is_separated_from_answer():
    body, reasoning, used = collect("<think>分析过程</think>最终回答")

    assert body == "最终回答"
    assert reasoning == "分析过程"
    assert used is True


def test_tags_may_be_split_at_arbitrary_chunk_boundaries():
    body, reasoning, used = collect("<thi", "nk>分", "析</th", "ink>", " 答案")

    assert body == "答案"
    assert reasoning == "分析"
    assert used is True


def test_thinking_alias_is_supported():
    body, reasoning, used = collect("\n<thinking>推理</thinking>结论")

    assert body == "结论"
    assert reasoning == "推理"
    assert used is True


def test_literal_tag_after_real_prose_is_not_treated_as_reasoning():
    body, reasoning, used = collect("正文里提到 <think>标签</think>。")

    assert body == "正文里提到 <think>标签</think>。"
    assert reasoning == ""
    assert used is False


def test_unclosed_think_block_is_flushed_as_reasoning():
    body, reasoning, used = collect("<think>尚未结束")

    assert body == ""
    assert reasoning == "尚未结束"
    assert used is True


def test_plain_text_is_emitted_unchanged_except_leading_whitespace():
    body, reasoning, used = collect("  普通", "回复")

    assert body == "普通回复"
    assert reasoning == ""
    assert used is False


def test_partial_open_tag_at_end_is_returned_as_plain_text_on_flush():
    body, reasoning, used = collect("<thi")

    assert body == "<thi"
    assert reasoning == ""
    assert used is False
