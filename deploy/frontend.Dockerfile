# ---------- 构建 ----------
FROM node:22-alpine AS build

WORKDIR /src

# 依赖单独一层:改前端代码不会重跑 npm ci
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./

# 留空 = 前端走相对路径 /api/...,和后端同源。
# 这样换域名、换 IP、加 HTTPS 都不用重新构建,而且浏览器根本不做跨域预检。
# 注意必须显式写出来:环境变量不存在时 client.ts 里的 ?? 会退回 localhost:8000。
RUN echo "VITE_API_BASE_URL=" > .env.production

# 两个入口(debug.html 是整个应用 / index.html 只负责跳过去),vite.config.ts 里配的
RUN npm run build

# ---------- 运行 ----------
FROM nginx:alpine

COPY --from=build /src/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
