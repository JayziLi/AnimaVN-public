import logging
from contextlib import asynccontextmanager
from importlib import metadata

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import (
    app_settings,
    connections,
    debug,
    debug_chats,
    emotion,
    personas,
    scenes,
    sprites,
    tavern,
    tts,
    voices,
)
from app.config import settings
from app.db import Base, SessionLocal, engine
from app.seed import (
    seed_default_connections,
    seed_default_persona,
    seed_default_tavern_data,
)

# uvicorn only wires up its own loggers; without a handler here app.* INFO
# lines (e.g. prompt-cache usage per request) never reach the console
_app_log_handler = logging.StreamHandler()
_app_log_handler.setFormatter(logging.Formatter("%(levelname)s:     %(message)s"))
logging.getLogger("app").addHandler(_app_log_handler)
logging.getLogger("app").setLevel(logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        seed_default_connections(db)
        seed_default_persona(db)
        seed_default_tavern_data(db)
    finally:
        db.close()
    yield


app = FastAPI(title="AnimaBackend API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=settings.cors_origin_regex or None,
    allow_methods=["*"],
    allow_headers=["*"],
    # 开发时前端(5173)和后端(8000)不同源,不列出来前端读不到语音的这两个响应头
    expose_headers=["X-TTS-Cache", "X-TTS-Emotion", "X-TTS-Emo-Mode"],
)

app.include_router(connections.router)
app.include_router(personas.router)
app.include_router(debug.router)
app.include_router(debug_chats.router)
app.include_router(tavern.router)
app.include_router(sprites.router)
app.include_router(scenes.router)
app.include_router(app_settings.router)
app.include_router(tts.router)
app.include_router(voices.router)
app.include_router(emotion.router)


def _version() -> str:
    try:
        return metadata.version("animabackend")
    except metadata.PackageNotFoundError:
        return "0.1.0"  # dev checkout without editable install — keep in sync with pyproject.toml


@app.get("/api/health")
def health():
    return {"status": "ok", "version": _version()}
