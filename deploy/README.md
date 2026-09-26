# 部署

一台 Linux 服务器 + Docker，四步。

```
浏览器 ──80──> nginx 容器 ┬── /            静态文件(debug.html:视觉小说 + 调试台;/ 自动跳过去)
                          └── /api/*       反代到 backend 容器 :8000
                                                └── sqlite 在 named volume 里
```

后端**不映射端口**，公网只能经 nginx 进来。整站一道 Basic Auth。

---

## 1. 先生成密码文件

**这步必须在 `up` 之前。** 文件不存在的话 Docker 会替你建一个同名*目录*，
nginx 拿目录当密码文件读，整站 500。

```bash
# 服务器上装了 apache2-utils / httpd-tools:
htpasswd -Bc deploy/htpasswd 你的用户名

# 没装也不想装,用 docker 里现成的:
docker run --rm httpd:alpine htpasswd -Bbn 你的用户名 你的密码 > deploy/htpasswd
```

确认一下不是空的：

```bash
cat deploy/htpasswd     # 应该是 用户名:$2y$05$....
```

**还要让 nginx 读得到。** auth_basic_user_file 是 worker 进程读的,worker 跑在
镜像里的 `nginx` 用户(uid 101)下,不是 root。所以文件 600 且属于你自己的话,
每个请求都会 403 —— 日志里是 "no user/password was provided"。两种做法:

```bash
sudo chown 101:101 deploy/htpasswd && chmod 600 deploy/htpasswd   # 宿主上显示成 messagebus:lxd,正常
# 或者干脆放开读权限(存的是 bcrypt 哈希,不是明文):
chmod 644 deploy/htpasswd
```

重新生成过密码文件就得重做这一步,`>` 重定向会把 owner 变回你自己。

## 2. 填 API 密钥（可选）

只在**第一次启动、库还是空的**时候用来种默认连接。跳过这步也行——
起来之后在网页的设置页里加连接一样。

仓库根建 `.env`：

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://某个中转站/v1
```

（`.env` 已经在 `.gitignore` 里，不会被提交。）

## 3. 起

```bash
docker compose up -d --build
```

第一次要几分钟（装 Python 依赖 + `npm ci` + `vite build`）。

## 4. 验

```bash
# 应该返回 {"status":"ok","version":"0.1.0"}
curl -u 用户名:密码 http://服务器IP/api/health

# 不带密码应该是 401
curl -i http://服务器IP/api/health | head -1
```

浏览器：

- `http://服务器IP/` —— 自动跳到 debug.html
- `http://服务器IP/debug.html` —— 调试台,顶栏「视觉小说」进游戏界面

---

## 常用操作

```bash
docker compose logs -f backend      # 看后端日志
docker compose logs -f web          # 看 nginx 日志
docker compose restart backend      # 只重启后端
docker compose up -d --build        # 改了代码后重新部署
docker compose down                 # 停(数据留着)
```

**备份/取回数据库**（卡、预设、对话、连接全在这一个文件里）：

```bash
docker compose cp backend:/app/data/animabackend.db ./animabackend.db
```

**换密码**：重跑第 1 步，然后 `docker compose restart web`。
（nginx 每次请求都读 htpasswd，其实连重启都不用。）

---

## 已知限制

**没有数据库迁移。** 启动时跑的是 `Base.metadata.create_all`，它只**建**表，
不会 `ALTER` 已有的表。所以以后往模型里加字段（比如给 `GameSession` 加
`preset_id`），服务器上那份旧库不会自动长出新列 —— 要么手工 `ALTER TABLE`，
要么删库重来。真要长期跑得引入 alembic。

**HTTP，不是 HTTPS。** Basic Auth 的密码是 base64 编码后明文过网的，
中间人能看到。所以：**别用你在别处用过的密码。**

有域名的话换 Caddy 能自动签证书，配置比 nginx 短得多：

```
你的域名 {
    root * /usr/share/nginx/html
    basicauth { 用户名 bcrypt哈希 }
    handle /api/* { reverse_proxy backend:8000 }
    handle { try_files {path} /index.html
             file_server }
}
```

只有裸 IP 的话签不了证书，就先这样。

**SQLite 单写者，uvicorn 只开 1 个 worker。** 自己玩够用，多人同时写会排队。
