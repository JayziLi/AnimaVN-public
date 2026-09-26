from fastapi.testclient import TestClient


def allowed(client: TestClient, origin: str) -> bool:
    r = client.get("/api/health", headers={"Origin": origin})
    return r.headers.get("access-control-allow-origin") == origin


def test_phone_can_reach_dev_server_over_lan_or_tailscale(client: TestClient):
    # 手机打开 http://<电脑的地址>:5173,前端就连同一个地址的 :8000,源就是那个地址
    for origin in [
        "http://localhost:5173",
        "http://192.168.1.4:5173",
        "http://10.141.3.7:5173",
        "http://192.168.1.20:5173",
        # Tailscale 分的地址(100.64.0.0/10):带出门时手机走这个
        "http://100.64.0.1:5173",
        "http://100.118.136.98:5173",
        "http://100.127.255.254:5173",
    ]:
        assert allowed(client, origin), origin

    for origin in [
        "http://100.63.0.1:5173",  # 不在 Tailscale 段里
        "http://100.128.0.1:5173",
        "http://8.8.8.8:5173",
        "http://100.118.136.98:3000",  # 只放行前端开发服务器的端口
    ]:
        assert not allowed(client, origin), origin
