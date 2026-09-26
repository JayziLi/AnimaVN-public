"""bge-small-zh-v1.5(int8 ONNX,MIT)的句向量:取 CLS 向量再归一化。

立绘标签和立绘名都很短,截断到 64 个 token 足够。单线程跑:一次一批十几个短词,
CPU 上两三毫秒,多线程反而抢核。
"""

from collections.abc import Sequence
from pathlib import Path

import numpy as np

MODEL_NAME = "bge-small-zh-v1.5"
MODEL_FILE = "model_quantized.onnx"
TOKENIZER_FILE = "tokenizer.json"


class BgeEncoder:
    name = MODEL_NAME

    def __init__(self, model_dir: Path):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        tokenizer = Tokenizer.from_file(str(model_dir / TOKENIZER_FILE))
        tokenizer.enable_truncation(max_length=64)
        pad_id = tokenizer.token_to_id("[PAD]") or 0
        tokenizer.enable_padding(pad_id=pad_id, pad_token="[PAD]")
        self._tokenizer = tokenizer

        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        self._session = ort.InferenceSession(
            str(model_dir / MODEL_FILE), options, providers=["CPUExecutionProvider"]
        )
        self._input_names = {i.name for i in self._session.get_inputs()}

    def encode(self, texts: Sequence[str]) -> np.ndarray:
        batch = self._tokenizer.encode_batch(list(texts))
        ids = np.array([e.ids for e in batch], dtype=np.int64)
        feeds = {
            "input_ids": ids,
            "attention_mask": np.array([e.attention_mask for e in batch], dtype=np.int64),
        }
        if "token_type_ids" in self._input_names:
            feeds["token_type_ids"] = np.zeros_like(ids)
        hidden = self._session.run(None, feeds)[0]
        cls = hidden[:, 0]
        return cls / np.linalg.norm(cls, axis=1, keepdims=True)
