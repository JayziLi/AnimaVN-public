"""立绘里找脸:视觉小说按脸对齐立绘(每个角色的脸一样大、头在同一高度)。

用的是 nagadomi 的 lbpcascade_animeface(MIT,模型文件在 app/assets/,不到 250KB),
OpenCV 的级联分类器跑一张图几十毫秒。只在上传立绘时跑一次,结果存进 card_sprites.face_scan,
怎么摆由前端按结果算(plugins/spriteLayout.ts)。

OpenCV 5 把级联分类器挪出了主包,所以依赖钉在 4.x。
"""

from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np

CASCADE = Path(__file__).parent / "assets" / "lbpcascade_animeface.xml"

# 大图缩到这个边长再找:脸在立绘里占一成以上,缩小不影响结果,速度快好几倍
MAX_SIDE = 1024


@lru_cache(maxsize=1)
def _detector():
    try:
        import cv2
    except ImportError:
        return None
    # 有核显的机器上 OpenCV 默认会初始化 OpenCL,多占一百多 MB 内存,找脸却不见得更快;
    # 单线程:找脸是偶尔的活,别和同一个进程里的接口抢 CPU(实测单线程和多线程差不多快)
    cv2.ocl.setUseOpenCL(False)
    cv2.setNumThreads(1)
    detector = cv2.CascadeClassifier(str(CASCADE))
    return None if detector.empty() else detector


def available() -> bool:
    return _detector() is not None


def scan(data: bytes) -> dict[str, Any] | None:
    """{"width", "height", "face"},face 是 {"x","y","w","h"}(占整张图的比例)或 None。

    图解不开时宽高也是 None —— 算「看过了」,不会反复重试。
    返回 None 表示这台机器上找不了脸(没装 OpenCV),留给以后补。
    """
    detector = _detector()
    if detector is None:
        return None
    import cv2

    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None:
        return {"width": None, "height": None, "face": None}
    height, width = img.shape[:2]
    # 16 位 PNG:equalizeHist 只收 8 位,透明度也要按 0–255 算
    if img.dtype != np.uint8:
        img = (img / 257).astype(np.uint8)

    gray = _flatten(img)
    shrink = min(1.0, MAX_SIDE / max(width, height))
    if shrink < 1:
        gray = cv2.resize(gray, None, fx=shrink, fy=shrink, interpolation=cv2.INTER_AREA)
    gray = cv2.equalizeHist(gray)

    h, w = gray.shape
    # 太小的框多半是衣服上的图案、手里的玩偶
    smallest = max(24, min(w, h) // 12)
    found = detector.detectMultiScale(
        gray, scaleFactor=1.05, minNeighbors=4, minSize=(smallest, smallest)
    )
    if len(found) == 0:
        return {"width": width, "height": height, "face": None}
    x, y, fw, fh = max(found, key=lambda f: f[2] * f[3])
    return {
        "width": width,
        "height": height,
        "face": {
            "x": round(float(x) / w, 4),
            "y": round(float(y) / h, 4),
            "w": round(float(fw) / w, 4),
            "h": round(float(fh) / h, 4),
        },
    }


def _flatten(img: np.ndarray) -> np.ndarray:
    """透明的地方铺浅灰再转灰度:直接丢掉透明通道的话,透明处常是黑色,人物边缘会被当成脸的轮廓"""
    import cv2

    if img.ndim == 2:
        return img
    if img.shape[2] == 4:
        alpha = img[:, :, 3:4].astype(np.float32) / 255
        rgb = img[:, :, :3].astype(np.float32) * alpha + 200 * (1 - alpha)
        return cv2.cvtColor(rgb.astype(np.uint8), cv2.COLOR_BGR2GRAY)
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


# 头像里脸的高度占多少:再大就只剩五官,再小头发和肩膀抢戏
FACE_SHARE = 0.6


def face_thumbnail(data: bytes, face: dict[str, float] | None, size: int) -> bytes | None:
    """按脸裁一张正方形小头像(WebP,带透明)—— 封面上的角色头像圈用。

    face 是 face_scan 里的脸框(占整张图的比例);None 时取图的上方居中一块。
    脸贴着图边时,裁到图外的部分是透明的,不会为了凑正方形把脸挤到一边。
    返回 None:这台机器上没有 OpenCV,或者图解不开。
    """
    try:
        import cv2
    except ImportError:
        return None

    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None:
        return None
    img = _to_bgra(img)
    h, w = img.shape[:2]

    if face:
        cx = (face["x"] + face["w"] / 2) * w
        cy = (face["y"] + face["h"] / 2) * h
        side = max(face["w"] * w, face["h"] * h) / FACE_SHARE
    else:
        side = min(w, h) * 0.6
        cx, cy = w / 2, side / 2
    s = max(1, round(side))
    x0, y0 = round(cx - s / 2), round(cy - s / 2)

    pad = max(0, -x0, -y0, x0 + s - w, y0 + s - h)
    if pad:
        img = cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=(0, 0, 0, 0))
        x0, y0 = x0 + pad, y0 + pad
    crop = img[y0 : y0 + s, x0 : x0 + s]
    thumb = cv2.resize(
        crop, (size, size), interpolation=cv2.INTER_AREA if s > size else cv2.INTER_CUBIC
    )
    ok, buf = cv2.imencode(".webp", thumb, [cv2.IMWRITE_WEBP_QUALITY, 90])
    return buf.tobytes() if ok else None


def _to_bgra(img: np.ndarray) -> np.ndarray:
    """灰度、不透明、16 位的图统一成 8 位 BGRA,后面裁图补边都按四通道来"""
    import cv2

    if img.dtype != np.uint8:
        img = (img / 257).astype(np.uint8)
    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
    if img.shape[2] == 3:
        return cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    return img
