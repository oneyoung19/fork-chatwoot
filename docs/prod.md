# 生产环境部署指南

本文档面向开发者和运维工程师，覆盖 Chatwoot 三种主流生产部署方式，以及关键配置说明。

---

## 一、部署方式对比

| 方式 | 适用规模 | 维护复杂度 | 推荐程度 |
|------|----------|------------|----------|
| Docker Compose | 小到中型（单机） | 低 | ★★★★★ 推荐 |
| Linux 裸机（Ubuntu） | 小到中型（单机） | 中 | ★★★★ |
| Heroku / PaaS | 快速原型 / 小规模 | 低 | ★★★ |

生产镜像由官方发布：`chatwoot/chatwoot:latest`（或指定版本如 `chatwoot/chatwoot:v4.13.0`）。

---

## 二、方式一：Docker Compose（推荐）

### 1. 准备 `.env` 文件

```bash
wget -O .env https://raw.githubusercontent.com/chatwoot/chatwoot/develop/.env.example
# 或直接复制项目根目录的 .env.example
```

**必填变量（最小集）：**

| 变量 | 说明 |
|------|------|
| `SECRET_KEY_BASE` | Rails Cookie 签名密钥。使用 `openssl rand -hex 64` 生成，必须设置且不可泄露 |
| `FRONTEND_URL` | 对外暴露的完整域名，如 `https://chat.example.com` |
| `POSTGRES_HOST` | 数据库主机名（Docker Compose 中填 `postgres`） |
| `POSTGRES_USERNAME` | 数据库用户名 |
| `POSTGRES_PASSWORD` | 数据库密码（生产必须设置） |
| `REDIS_URL` | Redis 连接地址（Docker Compose 中填 `redis://redis:6379`） |
| `REDIS_PASSWORD` | Redis 密码 |
| `MAILER_SENDER_EMAIL` | 系统发件地址 |
| `SMTP_ADDRESS` | SMTP 服务器地址 |
| `SMTP_PORT` | SMTP 端口（通常 587 或 465） |
| `SMTP_USERNAME` | SMTP 用户名 |
| `SMTP_PASSWORD` | SMTP 密码 |
| `RAILS_ENV` | 必须为 `production` |

**Active Record 加密（MFA 功能需要）：**

```bash
# 在容器内或本地 Rails 环境执行：
bundle exec rails db:encryption:init
# 将输出的三个 key 填入 .env
ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY=
ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY=
ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT=
```

### 2. 启动服务

```bash
# 使用官方生产 compose 文件
docker compose -f docker-compose.production.yaml up -d
```

服务拓扑：

```
Internet
    │
    ▼
  Nginx (宿主机，反向代理)
    │
    ▼  127.0.0.1:3000
┌─────────────────────────────────────────┐
│       docker-compose.production.yaml    │
│                                         │
│  rails (:3000)                          │
│      ↕                                  │
│  sidekiq                                │
│      ↕              ↕                   │
│  postgres (:5432)  redis (:6379)        │
│                                         │
│  （文件挂载：storage_data 卷）            │
└─────────────────────────────────────────┘
```

注意：生产 compose 文件中 postgres 和 redis 端口仅绑定 `127.0.0.1`，不对外暴露。

### 3. 数据库初始化（仅首次）

```bash
docker compose -f docker-compose.production.yaml exec rails \
  bundle exec rails db:chatwoot_prepare
```

`db:chatwoot_prepare` 会自动检测数据库状态：
- 若数据库不存在 → 创建 + 加载 schema + 执行 seed
- 若数据库已存在 → 仅执行挂起的 migrations

### 4. 验证服务状态

```bash
docker compose -f docker-compose.production.yaml ps
docker compose -f docker-compose.production.yaml logs -f rails
```

### 5. Nginx 反向代理

安装 Nginx 并创建站点配置（参考 `deployment/nginx_chatwoot.conf`）：

```nginx
upstream backend {
  server 127.0.0.1:3000;
  keepalive 32;
}

map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}

server {
  listen 80;
  server_name chat.example.com;
  return 301 https://chat.example.com$request_uri;
}

server {
  listen 443 ssl http2;
  server_name chat.example.com;

  ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;

  location / {
    proxy_pass http://backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 0;
    proxy_read_timeout 36000s;
  }
}
```

> `proxy_read_timeout 36000s` 是为了支持 ActionCable WebSocket 长连接，不可省略。

SSL 证书申请：

```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d chat.example.com
```

---

## 三、方式二：Linux 裸机（Ubuntu 20.04 / 22.04 / 24.04）

### 自动脚本安装（推荐）

Chatwoot 官方提供 `cwctl` 脚本，一键完成 Ruby/Node/PostgreSQL/Redis/Nginx/SSL 全套安装：

```bash
# 以 root 用户执行
wget https://get.chatwoot.app/linux/install.sh -O install.sh
chmod +x install.sh

# 安装（自动配置 Nginx + Let's Encrypt）
./install.sh --install
```

脚本结束后，服务通过 systemd 管理，以 `chatwoot` 用户运行。

### systemd 服务管理

```bash
# 查看状态
systemctl status chatwoot.target

# 启动 / 停止 / 重启
systemctl start chatwoot.target
systemctl stop chatwoot.target
systemctl restart chatwoot.target

# 查看日志
journalctl -u chatwoot-web.1 -f
journalctl -u chatwoot-worker.1 -f
```

两个核心 systemd 服务（位于 `deployment/`）：

| 服务文件 | 进程 | 内存限制 |
|----------|------|----------|
| `chatwoot-web.1.service` | `bin/rails server -p 3000` | 无 |
| `chatwoot-worker.1.service` | `sidekiq -C config/sidekiq.yml` | 1.2 GB（OOM 时停止） |

两者均以 `chatwoot` 用户身份运行，应用目录位于 `/home/chatwoot/chatwoot`，环境变量通过 `dotenv` 从 `.env` 文件加载。

---

## 四、方式三：Heroku / PaaS

项目根目录的 `Procfile` 定义了 PaaS 进程：

```
release: POSTGRES_STATEMENT_TIMEOUT=600s bundle exec rails db:chatwoot_prepare && echo $SOURCE_VERSION > .git_sha
web:     bundle exec rails ip_lookup:setup && bin/rails server -p $PORT -e $RAILS_ENV
worker:  bundle exec rails ip_lookup:setup && bundle exec sidekiq -C config/sidekiq.yml
```

- `release` 进程在每次部署时执行数据库迁移。
- 需要单独的 Heroku Postgres 和 Redis 附加组件。
- 环境变量通过 Heroku Config Vars 设置，而非 `.env` 文件。

---

## 五、文件存储配置

生产环境建议使用云存储（避免容器重建时丢失用户上传文件）。通过 `ACTIVE_STORAGE_SERVICE` 切换：

| 值 | 说明 | 所需变量 |
|----|------|----------|
| `local` | 默认，存储在 `storage/` 目录（Docker 中为 `storage_data` 卷） | 无 |
| `amazon` | AWS S3 | `S3_BUCKET_NAME` `AWS_ACCESS_KEY_ID` `AWS_SECRET_ACCESS_KEY` `AWS_REGION` |
| `google` | GCS | `GCS_PROJECT` `GCS_CREDENTIALS` `GCS_BUCKET` |
| `microsoft` | Azure Blob | `AZURE_STORAGE_ACCOUNT_NAME` `AZURE_STORAGE_ACCESS_KEY` `AZURE_STORAGE_CONTAINER` |
| `s3_compatible` | MinIO / DigitalOcean Spaces 等 | `STORAGE_ACCESS_KEY_ID` `STORAGE_SECRET_ACCESS_KEY` `STORAGE_REGION` `STORAGE_BUCKET_NAME` `STORAGE_ENDPOINT` |

示例（使用 S3）：

```bash
ACTIVE_STORAGE_SERVICE=amazon
S3_BUCKET_NAME=my-chatwoot-bucket
AWS_ACCESS_KEY_ID=AKIAXXXXXXXXXXXXXXXX
AWS_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxx
AWS_REGION=ap-east-1
```

---

## 六、关键环境变量速查

```bash
# 安全
SECRET_KEY_BASE=                   # 必须，64+ 位随机字符串
ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY=
ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY=
ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT=

# 域名
FRONTEND_URL=https://chat.example.com
FORCE_SSL=true

# 数据库
POSTGRES_HOST=localhost
POSTGRES_USERNAME=chatwoot_prod
POSTGRES_PASSWORD=
POSTGRES_DATABASE=chatwoot_production
RAILS_MAX_THREADS=5
SIDEKIQ_CONCURRENCY=10

# Redis
REDIS_URL=redis://localhost:6379
REDIS_PASSWORD=

# 邮件
MAILER_SENDER_EMAIL=Chatwoot <noreply@example.com>
SMTP_ADDRESS=smtp.example.com
SMTP_PORT=587
SMTP_USERNAME=
SMTP_PASSWORD=
SMTP_ENABLE_STARTTLS_AUTO=true

# 限流（可选）
ENABLE_RACK_ATTACK=true
RACK_ATTACK_LIMIT=300

# AI 功能（可选）
OPENAI_API_KEY=

# 推送通知（可选，使用官方移动 App）
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=

# APM / 错误监控（可选）
SENTRY_DSN=
```

---

## 七、升级流程

### Docker Compose 升级

```bash
# 1. 拉取新镜像
docker compose -f docker-compose.production.yaml pull

# 2. 重新创建容器（零停机时间短暂中断）
docker compose -f docker-compose.production.yaml up -d

# 3. 执行数据库迁移（若有）
docker compose -f docker-compose.production.yaml exec rails \
  bundle exec rails db:migrate

# 4. 验证
docker compose -f docker-compose.production.yaml ps
curl -sf http://localhost:3000/health && echo "OK"
```

### 裸机 cwctl 升级

```bash
./install.sh --upgrade
```

脚本会自动完成代码更新、依赖安装、数据库迁移和服务重启。

---

## 八、健康检查

应用内置健康检查端点，可用于负载均衡器探活：

```
GET /health
```

返回 `200 OK` 表示 Rails 进程正常。Sidekiq 队列堆积情况可通过 `/sidekiq` Web UI 监控（超级管理员权限）。
