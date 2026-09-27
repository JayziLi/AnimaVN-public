"""图片接口的 ?w= :按宽度缩一份 WebP。

标题画面要从立绘、背景里取色,前端得在 canvas 里读像素 —— 跨域的图要带 CORS 头才读得到,
而游戏里早就用普通 <img> 把原图载进了缓存(那次请求不带 Origin,响应里也就没有 CORS 头,
还设了一年的缓存),同一个地址再以 CORS 方式请求会直接吃到这份缓存、被浏览器拦下。
换个地址(加 ?w=)就绕开了,顺带只下几 KB,不用为了取个色把整张原图再拉一遍。
"""

import numpy as np

# 缩略图的宽度范围:再小取色不准,再大就没必要缩了
MIN_WIDTH = 16
MAX_WIDTH = 1024


def shrink_image(data: bytes, width: int) -> bytes | None:
    """缩到这个宽度(等比)的 WebP,透明通道保留。

    返回 None:原图本来就不比这宽、图解不开(GIF 之类 OpenCV 读不了的),或者没装 OpenCV ——
    调用方都照发原图。
    """
    try:
        import cv2
    except ImportError:
        return None

    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None:
        return None
    h, w = img.shape[:2]
    if w <= width:
        return None
    if img.dtype != np.uint8:
        img = (img / 257).astype(np.uint8)
    small = cv2.resize(img, (width, max(1, round(h * width / w))), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".webp", small, [cv2.IMWRITE_WEBP_QUALITY, 85])
    return buf.tobytes() if ok else None
