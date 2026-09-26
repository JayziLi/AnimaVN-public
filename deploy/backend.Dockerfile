# 构建上下文是仓库根,不是 AnimaBackend/ —— 这样 deploy/ 里的东西也够得着
FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# 情绪识别模型(立绘标签兜底匹配)烤进镜像,单独一层放在代码前面:改代码不用重新下载。
# 放 /app/models —— /app/data 是数据卷的挂载点,放进去会被盖住
COPY AnimaBackend/scripts/download_emotion_model.py ./scripts/
RUN pip install --no-cache-dir httpx \
 && python scripts/download_emotion_model.py --dir /app/models/bge-small-zh-v1.5
ENV EMOTION_MODEL_DIR=/app/models/bge-small-zh-v1.5

COPY AnimaBackend/pyproject.toml ./
COPY AnimaBackend/app ./app
RUN pip install --no-cache-dir .

# SQLite 文件的家。compose 把 named volume 挂在这儿,所以别往里塞东西
RUN mkdir -p /app/data

EXPOSE 8000

# SQLite 只有一个写者,多 worker 只会互相抢锁 —— 就开一个。
# proxy-headers 让 uvicorn 认 nginx 转发过来的真实 scheme/IP;
# 只有 nginx 容器能连到这个端口,所以 allow-ips 放开是安全的。
CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "1", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
