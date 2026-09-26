"""下载脚本:已经有且哈希对就跳过;哈希不对就重下。不联网,fetch 换成假的。"""

import hashlib
import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "download_emotion_model.py"


def load_script():
    spec = importlib.util.spec_from_file_location("download_emotion_model", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_skips_files_with_matching_hash_and_fetches_the_rest(tmp_path, monkeypatch):
    mod = load_script()
    good = b"model bytes"
    monkeypatch.setattr(
        mod,
        "FILES",
        {
            "a.onnx": ("onnx/a.onnx", hashlib.sha256(good).hexdigest()),
            "b.json": ("b.json", hashlib.sha256(b"tok").hexdigest()),
        },
    )
    (tmp_path / "a.onnx").write_bytes(good)
    (tmp_path / "b.json").write_bytes(b"stale")
    fetched = []
    monkeypatch.setattr(mod, "fetch", lambda remote, dest, digest: fetched.append((remote, dest.name)))

    mod.main(["--dir", str(tmp_path)])

    assert fetched == [("b.json", "b.json")]
