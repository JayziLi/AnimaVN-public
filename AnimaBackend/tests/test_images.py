import cv2
import numpy as np

from app.images import shrink_image


def _encode(img: np.ndarray, ext: str = ".png") -> bytes:
    ok, buf = cv2.imencode(ext, img)
    assert ok
    return buf.tobytes()


def test_shrinks_to_the_width_keeping_aspect_and_alpha():
    img = np.zeros((300, 200, 4), np.uint8)
    img[:, :, 1] = 200
    img[:, :, 3] = 255
    img[:150, :, 3] = 0  # 上半截透明

    small = cv2.imdecode(np.frombuffer(shrink_image(_encode(img), 50), np.uint8), cv2.IMREAD_UNCHANGED)

    assert small.shape == (75, 50, 4)
    assert small[5, 25, 3] == 0
    assert small[70, 25, 3] == 255


def test_small_or_undecodable_images_are_left_alone():
    # 本来就不宽:原样返回 None,调用方发原图
    assert shrink_image(_encode(np.zeros((40, 30, 3), np.uint8)), 64) is None
    assert shrink_image(b"GIF89a not really", 64) is None
