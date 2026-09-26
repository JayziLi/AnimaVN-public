"""下载情绪识别模型:bge-small-zh-v1.5 的 int8 ONNX 版(MIT,Xenova 转换)。

    python scripts/download_emotion_model.py [--dir 目录]

默认放到 AnimaBackend/models/bge-small-zh-v1.5(不进 git)。先从 Hugging Face 下,
失败换 hf-mirror.com;下完校验 SHA-256,先写 .part 再改名。已经有且哈希对的跳过。
不 import app —— 只用 httpx,Docker 构建时也能单独跑。
"""

import argparse
import hashlib
from pathlib import Path

import httpx

REPO = "Xenova/bge-small-zh-v1.5"
HOSTS = ("https://huggingface.co", "https://hf-mirror.com")
# 本地文件名 → (仓库里的路径, SHA-256)。文件名要和 app/emotion/encoder.py 里的一致
FILES = {
    "model_quantized.onnx": (
        "onnx/model_quantized.onnx",
        "15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc",
    ),
    "tokenizer.json": (
        "tokenizer.json",
        "48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26",
    ),
}
DEFAULT_DIR = Path(__file__).resolve().parent.parent / "models" / "bge-small-zh-v1.5"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(remote: str, dest: Path, digest: str) -> None:
    errors = []
    for host in HOSTS:
        url = f"{host}/{REPO}/resolve/main/{remote}"
        part = dest.with_name(dest.name + ".part")
        try:
            with httpx.stream("GET", url, follow_redirects=True, timeout=60) as r:
                r.raise_for_status()
                with part.open("wb") as f:
                    for chunk in r.iter_bytes(1 << 16):
                        f.write(chunk)
            if sha256(part) != digest:
                raise ValueError("SHA-256 对不上")
            part.replace(dest)
            print(f"下载好了 {dest.name}(来自 {host})")
            return
        except Exception as e:  # 网络、HTTP 状态、哈希,都换下一个源再试
            errors.append(f"  {url}: {e}")
            part.unlink(missing_ok=True)
    raise SystemExit(f"{dest.name} 下载失败:\n" + "\n".join(errors))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="下载情绪识别模型(bge-small-zh-v1.5 int8)")
    parser.add_argument("--dir", default=str(DEFAULT_DIR), help="放到哪个目录")
    args = parser.parse_args(argv)
    target = Path(args.dir)
    target.mkdir(parents=True, exist_ok=True)
    for name, (remote, digest) in FILES.items():
        dest = target / name
        if dest.is_file() and sha256(dest) == digest:
            print(f"已经有了 {name}")
            continue
        fetch(remote, dest, digest)
    print(f"情绪识别模型在 {target}")


if __name__ == "__main__":
    main()
