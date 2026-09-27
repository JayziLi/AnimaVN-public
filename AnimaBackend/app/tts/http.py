"""TTS 请求用的 httpx 客户端。

语音服务一般在局域网或 Tailscale 上(见 docs/voice-server.md)。本机开着 Clash 之类的
系统代理、或者设了 HTTP(S)_PROXY 时,发往这些地址的请求会被转去代理,然后连不上 ——
所以目标是本机、私有网段、Tailscale 时一律直连,其他地址照常走环境里的代理设置。
"""

import functools
import ipaddress
import ssl
from urllib.parse import urlsplit

import httpx

from app.tts.base import TTSError

# Tailscale 给设备分的地址段(CGNAT)。Python 不把它算作 private,单独判断
_TAILSCALE = ipaddress.ip_network("100.64.0.0/10")


def is_direct_host(host: str) -> bool:
    host = host.strip("[]").lower()
    if not host:
        return False
    # 不带点的主机名(比如 gpu-box)只可能是局域网里的机器
    if host == "localhost" or ("." not in host and ":" not in host):
        return True
    if host.endswith((".local", ".ts.net")):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    if ip.is_loopback or ip.is_private or ip.is_link_local:
        return True
    return ip.version == 4 and ip in _TAILSCALE


@functools.cache
def _ssl_context() -> ssl.SSLContext:
    # httpx 每建一个客户端都要重新加载一遍 CA 证书,这台机器上要 0.3–4 秒,
    # 比合成一句还慢(实测一句 1.4 秒的合成经后端要 3–15 秒)。每次请求都新建客户端,
    # 所以证书只加载一次,所有客户端共用
    return httpx.create_ssl_context()


def transport_error(base_url: str, service: str, e: httpx.HTTPError) -> tuple[int, str]:
    """连接层的异常 → (状态码, 给人看的原因)。几种断法能分开(2026-09-25 实测):
    - 本机地址连接被拒:SSH 隧道没开(隧道开着时,本机端口总是有人接)
    - 连上了但一个字没回就断开:隧道 / tailscale serve 通了,台式机上的服务没启动
    - 连接超时:台式机没开机,或者不在同一个网络(Tailscale 上的设备离线时就是这样)
    """
    if isinstance(e, httpx.TimeoutException) and not isinstance(e, httpx.ConnectTimeout):
        return 504, "语音合成超时"
    if isinstance(e, httpx.ConnectTimeout):
        return 503, f"连不上语音服务 {base_url}(台式机没响应:没开机,或者不在同一个网络)"
    if isinstance(e, (httpx.RemoteProtocolError, httpx.ReadError)):
        return 503, (
            f"语音服务没回应 {base_url}(连接是通的,但台式机上的 {service} 没启动,"
            "用台式机桌面上的快捷方式启动它)"
        )
    host = (urlsplit(base_url).hostname or "").strip("[]").lower()
    if host == "localhost" or host.startswith("127.") or host == "::1":
        return 503, (
            f"连不上语音服务 {base_url}(本机地址要靠 SSH 隧道转到台式机,隧道没开。"
            "建议把地址换成台式机的 Tailscale 地址,见 docs/voice-server.md)"
        )
    return 503, f"连不上语音服务 {base_url}(台式机没开机、{service} 没启动,或者网络不通)"


# 台式机上的服务额外开的只读接口:按路径原样取回一段参考音频(「语音详情」里试听)。
# GSV 由 D:\GPT-SoVITS\api_v2_anima.py 提供(包着 api_v2.py,见 docs/voice-server.md);
# IndexTTS 小服务还没有
REF_ROUTE = "/anima/ref"
# api_v2 合成时会堵住自己的事件循环,碰上正在合成一句长的要等几秒
REF_TIMEOUT = 20.0


async def read_reference(client: httpx.AsyncClient, base_url: str, service: str, path: str) -> tuple[bytes, str]:
    """GET {base_url}/anima/ref?path=,返回 (音频字节, mime)。失败抛 TTSError,连接层的异常由调用方处理"""
    res = await client.get(f"{base_url}{REF_ROUTE}", params={"path": path})
    if res.status_code == 200:
        mime = res.headers.get("content-type", "").split(";")[0].strip() or "audio/wav"
        return res.content, mime
    try:
        body = res.json()
    except ValueError:
        body = None
    detail = body.get("detail") if isinstance(body, dict) else None
    if res.status_code == 404 and detail in (None, "Not Found"):
        raise TTSError(
            501,
            f"{service} 还没开放取参考音频的接口({REF_ROUTE}),听不了原声。"
            "GPT-SoVITS 要用台式机上的 api_v2_anima.py 启动,见 docs/voice-server.md",
        )
    # 接口自己的报错(文件不存在、路径不在允许的目录里)原样带回去
    status = res.status_code if 400 <= res.status_code < 500 else 502
    raise TTSError(status, str(detail) if detail else f"{service} 返回 HTTP {res.status_code}")


def make_tts_client(base_url: str, timeout: float) -> httpx.AsyncClient:
    host = urlsplit(base_url).hostname or ""
    return httpx.AsyncClient(
        timeout=timeout, trust_env=not is_direct_host(host), verify=_ssl_context()
    )
