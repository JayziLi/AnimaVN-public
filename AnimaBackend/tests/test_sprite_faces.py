from pathlib import Path

import cv2
import numpy as np

from app.sprite_faces import scan

# Ren'Py 示例游戏里的 Sylvie(MIT),前端「载入示例立绘」用的就是它
SYLVIE = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "public"
    / "vn"
    / "sample-sprites"
    / "sylvie-blue-normal.png"
)


def test_finds_the_face_in_a_sample_sprite():
    result = scan(SYLVIE.read_bytes())

    assert (result["width"], result["height"]) == (334, 700)
    face = result["face"]
    assert face is not None
    # 位置都是占整张图的比例:脸在上半截、横向大致居中
    assert 0 < face["y"] < 0.3
    assert 0.1 < face["h"] < 0.4
    assert 0.2 < face["x"] + face["w"] / 2 < 0.8


def test_large_images_give_the_same_face_after_downscaling():
    img = cv2.imdecode(np.frombuffer(SYLVIE.read_bytes(), np.uint8), cv2.IMREAD_UNCHANGED)
    big = cv2.resize(img, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)

    small = scan(SYLVIE.read_bytes())
    large = scan(cv2.imencode(".png", big)[1].tobytes())

    assert (large["width"], large["height"]) == (1002, 2100)
    assert abs(large["face"]["y"] - small["face"]["y"]) < 0.03
    assert abs(large["face"]["h"] - small["face"]["h"]) < 0.05


def test_16_bit_pngs_scan_like_the_8_bit_original():
    """16 位 PNG(有的绘图软件默认导出这种)按 8 位的同一张图找脸;以前灰度 / 不透明的直接报错,带透明的找不到脸"""
    img = cv2.imdecode(np.frombuffer(SYLVIE.read_bytes(), np.uint8), cv2.IMREAD_UNCHANGED)
    assert img.dtype == np.uint8 and img.shape[2] == 4
    wide = img.astype(np.uint16) * 257
    variants = {
        "rgba": wide,
        "rgb": cv2.cvtColor(wide, cv2.COLOR_BGRA2BGR),
        "gray": cv2.cvtColor(cv2.cvtColor(wide, cv2.COLOR_BGRA2BGR), cv2.COLOR_BGR2GRAY),
    }
    expected = scan(SYLVIE.read_bytes())
    for name, v in variants.items():
        ok, png = cv2.imencode(".png", v)
        assert ok, name
        result = scan(png.tobytes())
        assert (result["width"], result["height"]) == (334, 700), name
        assert result["face"] is not None, name
        assert abs(result["face"]["y"] - expected["face"]["y"]) < 0.03, name


def test_blank_image_has_a_size_but_no_face():
    ok, png = cv2.imencode(".png", np.zeros((300, 200, 4), np.uint8))
    assert ok

    assert scan(png.tobytes()) == {"width": 200, "height": 300, "face": None}


def test_undecodable_bytes_are_marked_scanned_without_a_size():
    assert scan(b"not an image") == {"width": None, "height": None, "face": None}


def test_face_thumbnail_is_a_square_webp_centred_on_the_face():
    from app.sprite_faces import face_thumbnail

    data = SYLVIE.read_bytes()
    face = scan(data)["face"]
    thumb = face_thumbnail(data, face, 96)

    img = cv2.imdecode(np.frombuffer(thumb, np.uint8), cv2.IMREAD_UNCHANGED)
    assert thumb[:4] == b"RIFF" and thumb[8:12] == b"WEBP"
    assert img.shape == (96, 96, 4)
    # 脸在正中间:中心一圈是不透明的立绘
    assert img[40:56, 40:56, 3].min() > 200


def test_face_thumbnail_pads_with_transparency_and_falls_back_without_a_face():
    from app.sprite_faces import face_thumbnail

    ok, png = cv2.imencode(".png", np.full((300, 200, 3), 120, np.uint8))
    assert ok
    # 脸框贴着左上角:裁出去的部分是透明的,不会把图拉歪
    corner = face_thumbnail(png.tobytes(), {"x": 0.0, "y": 0.0, "w": 0.2, "h": 0.1}, 64)
    img = cv2.imdecode(np.frombuffer(corner, np.uint8), cv2.IMREAD_UNCHANGED)
    assert img.shape == (64, 64, 4)
    assert img[2, 2, 3] == 0
    assert img[60, 60, 3] == 255

    # 没找到脸:取上方居中的一块
    top = face_thumbnail(png.tobytes(), None, 64)
    img = cv2.imdecode(np.frombuffer(top, np.uint8), cv2.IMREAD_UNCHANGED)
    assert img.shape[:2] == (64, 64)
    # 整张不透明时编码器会省掉透明通道
    assert img.shape[2] == 3 or img[:, :, 3].min() == 255

    assert face_thumbnail(b"not an image", None, 64) is None
