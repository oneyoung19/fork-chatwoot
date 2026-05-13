# 开发环境启动指南

本文档面向开发者，介绍如何在本地启动 Chatwoot（包括前端和后端）并进入开发状态。

---

## 一、前提条件

| 依赖 | 版本要求 | 推荐安装方式 |
|------|----------|-------------|
| Ruby | 3.4.4 | rbenv |
| Bundler | 2.5.16 | `gem install bundler -v 2.5.16` |
| Node.js | 24.x | nvm / 系统包管理器 |
| pnpm | 10.x | `npm install -g pnpm@10.2.0` |
| PostgreSQL | 16（含 pgvector 扩展） | Homebrew / apt |
| Redis | 任意稳定版 | Homebrew / apt |
| Overmind | 任意 | Homebrew / 手动安装 |

> macOS 一键安装示例：`brew install rbenv ruby-build node redis postgresql@16 overmind`

---

## 二、方式一：本地直接运行（推荐日常开发）

### 1. Ruby 环境

```bash
# 安装 rbenv（若未安装）
brew install rbenv ruby-build

# 在项目根目录安装指定 Ruby 版本
rbenv install $(cat .ruby-version)
rbenv local $(cat .ruby-version)

# 确认版本
ruby -v  # 应输出 ruby 3.4.4
```

每次新开终端，需初始化 rbenv（或写入 `~/.zshrc`）：

```bash
eval "$(rbenv init -)"
```

### 2. 安装依赖

```bash
bundle install   # Ruby gems
pnpm install     # Node 依赖
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，必填项如下：

| 变量 | 是否必填 | 说明 |
|------|----------|------|
| `SECRET_KEY_BASE` | **必填** | Rails Cookie 签名密钥，用 `openssl rand -hex 64` 生成 |
| `POSTGRES_PASSWORD` | **必填** | 数据库密码，不能为空（Docker postgres 镜像强制要求），开发环境填任意字符串如 `password` 即可 |
| `FRONTEND_URL` | **建议修改** | 改为 `http://localhost:3000`（默认的 `0.0.0.0` 会导致 Widget embed 代码中 BASE_URL 不可用） |
| `POSTGRES_HOST` | 已有默认值 | Docker 下默认 `postgres`（容器服务名），无需修改 |
| `POSTGRES_USERNAME` | 已有默认值 | 默认 `postgres`，无需修改 |
| `REDIS_URL` | 已有默认值 | Docker 下默认 `redis://redis:6379`，无需修改 |
| `REDIS_PASSWORD` | 可选 | 若设置，Redis 容器会启用密码验证，开发环境可留空 |
| `SMTP_ADDRESS` | 可选 | 填 `mailhog` 可使用 docker-compose 内置的 MailHog 接收邮件 |

开发环境可将 `LETTER_OPENER=true` 取消注释，邮件将在浏览器直接打开预览（无需真实 SMTP）。

### 4. 数据库初始化

```bash
# 创建数据库、加载 schema、执行 seed
bundle exec rails db:chatwoot_prepare
```

此命令会自动判断数据库是否存在：若首次运行则完整初始化；若已存在则仅执行迁移。

### 5. 启动所有服务

```bash
overmind start -f Procfile.dev
```

`Procfile.dev` 同时启动三个进程：

| 进程 | 命令 | 端口 |
|------|------|------|
| `backend` | `bin/rails s -p 3000` | **3000**（主应用、API） |
| `vite` | `bin/vite dev` | **3036**（Vite 热更新服务器） |
| `worker` | `dotenv bundle exec sidekiq -C config/sidekiq.yml` | 无（后台队列处理器） |

浏览器访问 `http://localhost:3000` 即可看到 Dashboard。

> 也可以分别启动：
> ```bash
> bundle exec rails s -p 3000
> bin/vite dev
> bundle exec sidekiq -C config/sidekiq.yml
> ```

### 6. 进入 Rails 控制台

```bash
bundle exec rails console
```

---

## 三、方式二：Docker Compose 开发模式

适用于不想在本机安装 Ruby/PostgreSQL/Redis 的场景。

### 前提

- 安装 Docker Desktop 并保持运行
- 复制 `.env.example` 为 `.env`（参考上节环境变量说明）

### 启动

```bash
# 首次启动（需构建本地镜像）
# 第一步：先构建基础镜像
docker compose -f docker-compose.yaml build base
# 第二步：再构建并启动所有服务
docker compose -f docker-compose.yaml up --build

# 后续启动
docker compose -f docker-compose.yaml up

# 有报错情况的话 需要数据库初始化（等容器全部起来）
# docker compose up
docker compose exec rails bundle exec rails db:chatwoot_prepare
docker compose exec rails bundle exec rails db:seed
```

服务拓扑：

```
┌─────────────────────────────────────────────┐
│              docker-compose.yaml            │
│                                             │
│  rails (:3000) ←→ vite (:3036)             │
│      ↕                                      │
│  sidekiq                                    │
│      ↕              ↕                       │
│  postgres (:5432)  redis (:6379)            │
│                                             │
│  mailhog (:1025 SMTP / :8025 Web UI)        │
└─────────────────────────────────────────────┘
```

- Rails 镜像在开发模式下挂载本地代码目录，修改 Ruby 文件后自动重载（Rails 默认行为）。
- Vite 以 `--host 0.0.0.0` 模式运行，供 Rails 容器通过内部网络访问，前端改动实时热更新。
- MailHog 接收开发邮件，Web UI 访问 `http://localhost:8025`。

首次启动时，Rails 容器的 entrypoint 会等待 PostgreSQL 就绪后自动执行 `bundle install`，随后启动服务器。

初始化数据库：

```bash
docker compose exec rails bundle exec rails db:chatwoot_prepare
```

如需测试 Widget 嵌入功能，需手动构建 SDK（开发模式不会自动构建，生产构建时由 `assets:precompile` 自动触发）：

```bash
docker compose exec -e BUILD_MODE=library vite bin/vite build
```

### 常用 Docker 命令

```bash
# 启动 / 停止
docker compose -f docker-compose.yaml up          # 启动所有服务
docker compose -f docker-compose.yaml up --build  # 重新构建镜像并启动
docker compose -f docker-compose.yaml down        # 停止并移除容器（保留数据卷）
docker compose -f docker-compose.yaml down -v     # 停止并清除所有数据卷（重置数据库）

# 查看日志
docker compose logs -f              # 所有服务
docker compose logs -f rails        # 仅 Rails
docker compose logs -f sidekiq      # 仅 Sidekiq

# 在容器内执行命令
docker compose exec rails bundle exec rails console        # Rails 控制台
docker compose exec rails bundle exec rails db:migrate     # 执行迁移
docker compose exec rails bundle exec rails db:seed        # 填充默认测试数据
docker compose exec rails bash                             # 进入容器 shell

# 查看容器状态
docker compose ps
```

---

## 四、测试数据填充

| 命令 | 说明 |
|------|------|
| `bundle exec rails db:seed` | 标准 seed：创建默认账号、收件箱等最小数据集，适合快速功能验证（Docker 下加 `docker compose exec rails` 前缀） |
| `bundle exec rails search:setup_test_data` | 搜索/性能测试专用：批量生成大量会话、联系人等数据 |
| `bundle exec rails runner "Internal::SeedAccountJob.perform_now(Account.find(1))"` | 丰富的账号示例数据（对话、标签、自动化规则等），模拟真实使用场景 |

`db:seed` 执行后生成的默认登录账号：

| 字段 | 值 |
|------|----|
| Email | `john@acme.inc` |
| Password | `Password1!` |

---

## 五、常用开发命令

```bash
# Lint
pnpm eslint                    # JS/Vue 检查
pnpm eslint:fix                # 自动修复
bundle exec rubocop -a         # Ruby 自动修复

# 测试
pnpm test                      # Vitest 单元测试
pnpm test:watch                # 监听模式
bundle exec rspec spec/path/to/file_spec.rb        # 单个文件
bundle exec rspec spec/path/to/file_spec.rb:42     # 单个用例

# 代码生成
bundle exec rails g model/controller/...

# 数据库
bundle exec rails db:migrate
bundle exec rails db:rollback

# 构建 SDK（独立产物）
BUILD_MODE=library bin/vite build   # 本地直接运行时，输出至 public/packs/js/sdk.js
# docker compose exec -e BUILD_MODE=library vite bin/vite build  # Docker 模式下
docker compose exec vite pnpm run build:sdk # bin/vite build 有 vite-ruby 缓存会跳过构建，改用 pnpm run build:sdk 直接调用 vite

```

---

## 六、IDE / 工具建议

- **VS Code**：推荐安装 Volar（Vue）、Rubocop、Tailwind CSS IntelliSense 扩展
- **Rails 日志**：`tail -f log/development.log`
- **Sidekiq Web UI**：访问 `http://localhost:3000/sidekiq`（需超级管理员身份）
- **超级管理员**：访问 `http://localhost:3000/super_admin`

---

## 七、依赖安装机制（docker compose up 每次都会重装吗？）

每次 `docker compose up` 确实会执行依赖安装命令，但由于 Docker named volume 的存在，**大多数情况下很快**。

### 每次启动时执行的命令

- **rails / sidekiq 容器**（`docker/entrypoints/rails.sh`）：执行 `bundle install`
- **vite 容器**（`docker/entrypoints/vite.sh`）：执行 `pnpm store prune && pnpm install --force`

### 为什么不慢

`docker-compose.yaml` 声明了 named volume，跨容器重启持久存在：

```yaml
volumes:
  - bundle:/usr/local/bundle      # gems 缓存在此
  - node_modules:/app/node_modules  # node_modules 缓存在此
```

| 命令 | 第一次 | 后续 `up` |
|------|--------|-----------|
| `bundle install` | 完整安装所有 gems | `Gemfile.lock` 无变化时几乎瞬间完成 |
| `pnpm install --force` | 完整安装 | 强制重装，但 pnpm 通过硬链接从本地 store 复制，速度快 |

`pnpm install --force` 之所以加 `--force`，是因为基础镜像按生产环境构建（不含 devDependencies），开发模式启动时需要每次补装开发依赖。

### 什么时候会真正完整重装

```bash
# 删除 volume 后下次 up 会完整重装
docker compose down -v

# 重新构建镜像
docker compose up --build
```

正常的 `docker compose up` 或 `Ctrl+C` 后再 `up` 不会触发完整重装。
