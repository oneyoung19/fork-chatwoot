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

> macOS 一键安装示例：`brew install rbenv node redis postgresql@16 overmind`

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

编辑 `.env`，至少填写以下变量：

| 变量 | 说明 | 示例 |
|------|------|------|
| `SECRET_KEY_BASE` | Rails Cookie 签名密钥，用 `bundle exec rake secret` 生成 | 64 位十六进制字符串 |
| `FRONTEND_URL` | 前端访问地址 | `http://localhost:3000` |
| `POSTGRES_HOST` | PostgreSQL 主机 | `localhost` |
| `POSTGRES_USERNAME` | 数据库用户名 | `postgres` |
| `POSTGRES_PASSWORD` | 数据库密码 | （可留空用于本地） |
| `REDIS_URL` | Redis 连接地址 | `redis://localhost:6379` |
| `SMTP_ADDRESS` | SMTP 服务器（可不填，使用 MailHog） | `localhost` |

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
| `worker` | `sidekiq -C config/sidekiq.yml` | 无（后台队列处理器） |

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
docker compose -f docker-compose.yaml up
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

首次启动时，Rails 容器的 entrypoint 会等待 PostgreSQL 就绪后自动执行 `bundle install`，随后启动服务器。如需手动初始化数据库：

```bash
docker compose exec rails bundle exec rails db:chatwoot_prepare
```

---

## 四、测试数据填充

| 命令 | 说明 |
|------|------|
| `bundle exec rails db:seed` | 标准 seed：创建默认账号、收件箱等最小数据集，适合快速功能验证 |
| `bundle exec rails search:setup_test_data` | 搜索/性能测试专用：批量生成大量会话、联系人等数据 |
| `bundle exec rails runner "Internal::SeedAccountJob.perform_now(Account.find(1))"` | 丰富的账号示例数据（对话、标签、自动化规则等），模拟真实使用场景 |

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
BUILD_MODE=library bin/vite build   # 输出至 public/packs/js/sdk.js
```

---

## 六、IDE / 工具建议

- **VS Code**：推荐安装 Volar（Vue）、Rubocop、Tailwind CSS IntelliSense 扩展
- **Rails 日志**：`tail -f log/development.log`
- **Sidekiq Web UI**：访问 `http://localhost:3000/sidekiq`（需超级管理员身份）
- **超级管理员**：访问 `http://localhost:3000/super_admin`
