from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# anchor the sqlite file to the AnimaBackend directory, so the DB is the
# same no matter which directory uvicorn is launched from
_BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # only read on first startup to seed default connections; after that,
    # connections live in the DB and are managed via /api/connections
    anthropic_api_key: str | None = None
    openai_api_key: str | None = None
    openai_base_url: str | None = None
    database_url: str = f"sqlite:///{(_BACKEND_DIR / 'data' / 'animabackend.db').as_posix()}"
    # 浏览器把 localhost 和 127.0.0.1 当成两个源,少一个就会在那个地址上
    # 被 CORS 拦成 "Failed to fetch" —— 两个都放进来
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    # 手机局域网联调:前端跟着地址栏连后端,源就是本机当时的局域网 IP。
    # 按私有网段放行 :5173,换网络不用再改 IP;带出门时手机走 Tailscale,
    # 它分的 100.64.0.0/10 也放行。部署时置空关掉
    cors_origin_regex: str | None = (
        r"http://(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+"
        r"|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+):5173"
    )
    # 情绪识别模型(立绘标签的兜底匹配)。下载:python scripts/download_emotion_model.py。
    # Docker 里放 /app/models —— /app/data 是数据卷的挂载点,放进去会被盖住
    emotion_model_dir: str = str(_BACKEND_DIR / "models" / "bge-small-zh-v1.5")


settings = Settings()
