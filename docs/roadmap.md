# 系统架构与演进路线

本文档面向开发者和架构师，深入描述 Chatwoot 的技术架构、各层职责、关键数据流，以及项目的演进方向。

---

## Part 1：系统架构全景

### 1.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                            客户端层                                  │
│                                                                     │
│  浏览器/移动 App          嵌入网站                  开发者             │
│  (Dashboard UI)         (Widget 聊天组件)          (REST API)        │
└──────────┬─────────────────┬──────────────────────┬───────────────┘
           │                 │                      │
           ▼                 ▼                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          Nginx 反向代理                               │
│           HTTP/HTTPS + WebSocket 升级 (proxy_read_timeout 36000s)   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Puma / Rails 应用                             │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                      请求路由层                               │   │
│  │  config/routes.rb                                           │   │
│  │  ├── /app/*          → DashboardController (Vue SPA shell)  │   │
│  │  ├── /api/v1/*       → API::V1 Controllers                  │   │
│  │  ├── /widget         → WidgetsController                    │   │
│  │  ├── /auth           → Devise Token Auth                    │   │
│  │  ├── /super_admin    → SuperAdmin Controllers               │   │
│  │  └── /cable          → ActionCable WebSocket                │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    业务逻辑层                                  │   │
│  │  Controllers → Services → Models                            │   │
│  │  Policies (Pundit) ← 授权检查                                │   │
│  │  Finders ← 复杂查询封装                                       │   │
│  │  Builders ← 对象构建                                          │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    事件总线层                                  │   │
│  │  Dispatcher                                                 │   │
│  │  ├── SyncDispatcher  → ActionCableBroadcastJob, Hooks       │   │
│  │  └── AsyncDispatcher → Sidekiq Jobs via Listeners           │   │
│  └─────────────────────────────────────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────────────┘
                             │
           ┌─────────────────┼─────────────────┐
           ▼                 ▼                 ▼
┌─────────────────┐ ┌───────────────┐ ┌────────────────────────────┐
│   PostgreSQL 16  │ │     Redis     │ │        Sidekiq             │
│   (+ pgvector)  │ │               │ │                            │
│                 │ │ ├─ ActionCable │ │  队列：critical / high /   │
│  主数据存储      │ │ │   PubSub     │ │  medium / default /        │
│  向量索引        │ │ ├─ Sidekiq 队列│ │  mailers / scheduled /     │
│  会话缓存        │ │ └─ 应用缓存   │ │  low / purgable / ...      │
└─────────────────┘ └───────────────┘ └────────────────────────────┘
```

---

### 1.2 技术栈一览

| 层次 | 技术 | 版本 / 说明 |
|------|------|------------|
| Web 框架 | Ruby on Rails | 7.x |
| Ruby | MRI Ruby | 3.4.4 |
| 应用服务器 | Puma | 多线程 |
| 数据库 | PostgreSQL + pgvector | 16，pgvector 用于 AI 向量检索 |
| 缓存 / 队列 broker | Redis | Alpine 版 |
| 后台任务 | Sidekiq | 10 并发（可配置） |
| 实时通信 | ActionCable | Redis adapter |
| 认证 | Devise Token Auth | JWT + cookie 双支持 |
| 授权 | Pundit | Policy 类 |
| 事件总线 | Wisper | Pub/Sub，SyncDispatcher + AsyncDispatcher |
| 前端框架 | Vue 3 | Composition API + `<script setup>` |
| 前端构建 | Vite + vite-plugin-ruby | 多 entrypoint |
| 前端状态管理 | Vuex 4（主） + Pinia（迁移中） | — |
| 前端路由 | Vue Router | — |
| CSS | Tailwind CSS | 不允许自定义 CSS |
| 测试（Ruby） | RSpec | — |
| 测试（JS） | Vitest | — |
| 容器化 | Docker + Docker Compose | Alpine 基础镜像，多阶段构建 |
| 文件存储 | ActiveStorage | 支持 local / S3 / GCS / Azure / MinIO |
| 邮件 | ActionMailer + SMTP | 入站邮件通过 ActionMailbox |
| AI 集成 | RubyLLM / OpenAI API | Captain 功能，pgvector 用于文档检索 |

---

### 1.3 后端架构详解

#### 1.3.1 分层结构与职责

```
HTTP 请求
    │
    ▼
ApplicationController / ApiController
    │  鉴权（Devise Token Auth）
    │  账号范围限定（current_account）
    ▼
API::V1::Accounts::XxxController
    │  参数许可（strong params）
    │  Pundit 授权（policy）
    │  调用 Finder 或 Service
    ▼
Finders / Services
    │  Finder：复杂查询对象，返回 ActiveRecord::Relation
    │  Service：业务流程编排，跨多个 Model 操作
    │  完成后触发 Dispatcher.dispatch(event_name, ...)
    ▼
ActiveRecord Models
    │  数据验证、关联、回调
    │  Enterprise 扩展通过 prepend_mod_with / include_mod_with 注入
    ▼
PostgreSQL
```

核心模型关系：

```
Account (租户)
    ├── User (客服人员)
    ├── Inbox (收件箱)
    │     └── Channel::XxxModel (WebWidget/Email/Whatsapp/Facebook/...)
    ├── Contact
    │     └── ContactInbox ─── Conversation
    │                                └── Message
    │                                      └── Attachment
    └── Label / Team / AutomationRule / ...
```

#### 1.3.2 事件系统（Wisper Pub/Sub）

事件系统是 Chatwoot 响应各种业务变化（新消息、对话状态变更、自动化触发等）的核心机制：

```
业务操作（Service / Model callback）
    │
    ▼
Dispatcher.dispatch(event_name, timestamp, data)
    │
    ├─► SyncDispatcher（同步，同一请求线程内）
    │       └── ActionCableListener
    │             └── ActionCableBroadcastJob.perform_now
    │                   └── RoomChannel.broadcast_to (WebSocket 推送)
    │
    └─► AsyncDispatcher（异步，通过 Sidekiq）
            ├── AutomationRuleListener  → 触发自动化规则
            ├── NotificationListener   → 生成通知 / 发邮件
            ├── HookListener           → 触发 Webhook
            ├── CsatSurveyListener     → 发送满意度调查
            ├── CampaignListener       → 活动相关处理
            └── AgentBotListener       → 机器人集成
```

常见事件名（`event_name`）：

| 事件 | 触发时机 |
|------|----------|
| `conversation_created` | 新对话创建 |
| `message_created` | 新消息发送 |
| `conversation_resolved` | 对话标记为已解决 |
| `conversation_assigned` | 对话分配给客服 |
| `contact_created` | 新联系人创建 |

添加新事件处理：在 `app/listeners/` 下创建 Listener 类，在 `app/dispatchers/async_dispatcher.rb`（或 `sync_dispatcher.rb`）的 `listeners` 方法中注册。

#### 1.3.3 Sidekiq 队列优先级

Sidekiq 处理器从高优先级到低优先级依次消费：

| 队列 | 用途 |
|------|------|
| `critical` | 最高优先，时间敏感操作 |
| `high` | 重要但非关键操作 |
| `medium` | 普通业务任务 |
| `default` | 默认级别 |
| `mailers` | 邮件发送 |
| `action_mailbox_routing` | 入站邮件路由 |
| `low` | 低优先级任务 |
| `scheduled_jobs` | 定时任务 |
| `deferred` | 延迟执行 |
| `purgable` | 清理类任务 |
| `housekeeping` | 系统维护 |
| `async_database_migration` | 异步数据库迁移 |
| `bulk_reindex_low` | 批量重建索引 |

并发数通过 `SIDEKIQ_CONCURRENCY` 环境变量控制（默认 10）。

#### 1.3.4 实时通信（ActionCable）

```
前端（Vue）
    │  WebSocket 连接 /cable
    │  订阅 RoomChannel（每个账号一个 channel）
    ▼
ActionCable::Server
    │  Redis PubSub adapter
    │  channel_prefix: chatwoot_{env}_action_cable
    ▼
RoomChannel
    │  广播消息类型：conversation_created / message_created /
    │               conversation_updated / contact_updated / ...
    ▼
前端 Store（Vuex / Pinia）
    └── 更新对话列表、消息列表、通知计数等
```

---

### 1.4 前端架构详解

#### 1.4.1 多应用结构

Vite 的多 entrypoint 模式将前端分为相互独立的应用：

```
app/javascript/
│
├── entrypoints/           # Vite 入口（每个生成独立 bundle）
│   ├── dashboard.js       # 主应用（客服工作台）
│   ├── widget.js          # 嵌入式聊天气泡组件
│   ├── portal.js          # Help Center 客户门户
│   ├── superadmin.js      # 超级管理员后台
│   ├── survey.js          # CSAT 满意度调查页
│   ├── v3app.js           # 下一代 UI（chatwoot_v4 feature flag 控制）
│   └── sdk.js             # JS SDK（需独立构建：BUILD_MODE=library）
│
├── dashboard/             # 主客服工作台应用
│   ├── App.vue            # 应用根组件
│   ├── store/             # Vuex 状态管理
│   │   ├── modules/       # 业务模块（conversations, contacts, agents ...）
│   │   └── captain/       # Captain AI 相关模块
│   ├── stores/            # Pinia（calls.js, companies.js，迁移进行中）
│   ├── components-next/   # 新组件库（所有新 UI 开发在此）
│   ├── components/        # 遗留组件（deprecated，仅维护不新增）
│   ├── composables/       # Vue 可组合函数
│   │   └── store.js       # useStore() / useStoreGetters() Vuex 桥接
│   ├── routes/            # Vue Router 路由定义
│   │   └── dashboard/     # 按功能域组织：conversation/contacts/settings/...
│   ├── api/               # API 客户端（每个资源一个文件）
│   └── featureFlags.js    # FEATURE_FLAGS + PREMIUM_FEATURES 常量
│
├── v3/                    # 下一代 UI（Vue 3 + Pinia）
│
├── widget/                # 嵌入式聊天组件（独立 Vue 应用）
│
├── shared/                # dashboard 和 widget 共享代码
│   ├── composables/       # 共享可组合函数（含 useBranding）
│   ├── helpers/           # 工具函数
│   └── store/             # 共享 Vuex 模块（globalConfig）
│
└── sdk/                   # JS SDK（UMD 格式，embed 脚本）
```

#### 1.4.2 状态管理

Dashboard 使用 Vuex 作为主状态管理，正在逐步向 Pinia 迁移：

```
<script setup> 中访问 Vuex：
    import { useStore, useStoreGetters } from '@/composables/store'
    const store = useStore()
    const { 'conversations/allConversations': conversations } = useStoreGetters()

Vuex 模块（store/modules/）：
    conversations       对话列表、当前对话
    contacts            联系人
    agents              客服人员
    inboxes             收件箱
    labels              标签
    teams               团队
    notifications       通知
    reports             报表
    captain/            Captain AI（copilotThreads, copilotMessages, ...）
    ... 共 40+ 模块

Pinia Store（stores/，仅已迁移部分）：
    calls.js            语音通话状态
    companies.js        公司信息

v3/ 中全部使用 Pinia。
```

#### 1.4.3 组件体系

```
components-next/    ← 所有新功能的 UI 开发入口
    ├── button/         通用按钮
    ├── input/          输入框
    ├── dialog/         对话框
    ├── dropdown-menu/  下拉菜单
    ├── Conversation/   对话相关组件（消息气泡等）
    ├── Contacts/       联系人视图
    ├── captain/        Captain AI UI
    ├── Settings/       设置页面
    └── ...

components/         ← 遗留组件，仅维护，禁止新增
```

#### 1.4.4 功能开关（Feature Flags）

`featureFlags.js` 中定义所有功能开关：

```javascript
// OSS 功能开关（按账号/安装配置）
FEATURE_FLAGS.CONVERSATIONS / .CONTACTS / .REPORTS / ...

// Enterprise 专属（需要付费授权）
PREMIUM_FEATURES = [
    FEATURE_FLAGS.CAPTAIN,          // AI 副驾驶
    FEATURE_FLAGS.SLA,              // SLA 策略
    FEATURE_FLAGS.CUSTOM_ROLES,     // 自定义角色
    FEATURE_FLAGS.AUDIT_LOGS,       // 审计日志
    FEATURE_FLAGS.HELP_CENTER,      // 知识库
    FEATURE_FLAGS.SAML,             // SSO
    FEATURE_FLAGS.ADVANCED_ASSIGNMENT,
    FEATURE_FLAGS.CONVERSATION_REQUIRED_ATTRIBUTES,
]
```

---

### 1.5 数据层

#### PostgreSQL

- 数据库名：`chatwoot_production`（生产） / `chatwoot_dev`（开发）
- **pgvector 扩展**：用于 Captain AI 的文档向量检索，基础镜像使用 `pgvector/pgvector:pg16`
- 连接池：Sidekiq 进程使用 `SIDEKIQ_CONCURRENCY` 个连接，Rails 进程使用 `RAILS_MAX_THREADS` 个连接
- 语句超时：默认 14 秒（`POSTGRES_STATEMENT_TIMEOUT`）

#### Redis

Redis 承担三类职责，通过不同 key 空间区分：

| 用途 | 配置入口 |
|------|----------|
| ActionCable PubSub | `config/cable.yml` |
| Sidekiq 任务队列 | Sidekiq 内置 |
| Rails 应用缓存（速率限制、会话缓存等） | `config/environments/` |

生产建议：配置 Redis 密码（`REDIS_PASSWORD`），可选 Redis Sentinel 实现高可用（`REDIS_SENTINELS`）。

#### Active Storage

附件（图片、语音、文件）通过 Rails Active Storage 管理，后端可选：

```
ACTIVE_STORAGE_SERVICE=local      → 存储在 storage/ 目录或 Docker volume
                      =amazon     → AWS S3
                      =google     → Google Cloud Storage
                      =microsoft  → Azure Blob Storage
                      =s3_compatible → MinIO / DigitalOcean Spaces
```

---

### 1.6 渠道系统（Inbox Channel Types）

每个 `Inbox` 对应一种渠道类型，由 `channel_type` 字段标识：

| 渠道类型 | 模型文件 | 说明 |
|----------|----------|------|
| `Channel::WebWidget` | `channel/web_widget.rb` | 网页嵌入聊天气泡 |
| `Channel::Email` | `channel/email.rb` | 邮件收件箱（IMAP） |
| `Channel::FacebookPage` | `channel/facebook_page.rb` | Facebook Messenger |
| `Channel::Instagram` | `channel/instagram.rb` | Instagram DM |
| `Channel::Whatsapp` | `channel/whatsapp.rb` | WhatsApp Business API |
| `Channel::Api` | `channel/api.rb` | 自定义 API 渠道 |
| `Channel::Telegram` | `channel/telegram.rb` | Telegram Bot |
| `Channel::Tiktok` | `channel/tiktok.rb` | TikTok 私信 |
| `Channel::Sms` | `channel/sms.rb` | SMS（Twilio） |
| `Channel::TwilioSms` | `channel/twilio_sms.rb` | Twilio SMS/WhatsApp |
| `Channel::TwitterProfile` | `channel/twitter_profile.rb` | Twitter DM |
| `Channel::Line` | `channel/line.rb` | LINE 官方账号 |

---

### 1.7 Enterprise Edition 扩展机制

Chatwoot OSS 核心代码在 `app/`，Enterprise Edition（EE）代码在 `enterprise/app/`，目录结构完全镜像。

**扩展方式：**

```ruby
# 在 OSS 模型/服务文件末尾：
Conversation.include_mod_with('Audit::Conversation')  # 注入额外方法
Conversation.prepend_mod_with('Conversation')          # 覆盖已有方法

# 对应 Enterprise 模块文件：
# enterprise/app/models/enterprise/conversation.rb
module Enterprise::Conversation
  def some_method
    # Enterprise 实现，通过 super 调用 OSS 版本
    super
    # 额外 EE 逻辑
  end
end
```

**原则：**
- OSS 文件中不写 EE 专属逻辑，通过 `prepend_mod_with` / `include_mod_with` 创建扩展点
- EE 专属功能直接放在 `enterprise/` 下，无需改动 OSS
- Controller / Policy / Service 遵循同样模式

---

## Part 2：演进路线图

### 近期（进行中，基于当前代码库状态）

| 方向 | 具体内容 |
|------|----------|
| **语音通话** | WhatsApp Cloud Calling（入站/出站）、通话录音存储 |
| **Captain AI 增强** | 文档自动同步、自定义 AI Tools、场景化回复（Scenarios） |
| **Companies CRM** | 公司创建、联系人关联、公司备注与历史记录 |
| **Linear 集成深化** | Private Note 自动关联 Linear Issue |
| **Widget 创建服务** | 新账号注册后自动创建首个 Web Widget |

### 中期

| 方向 | 具体内容 |
|------|----------|
| **v4 UI 全面推进** | `chatwoot_v4` feature flag 控制下，v3 应用逐步替代 dashboard |
| **Pinia 全面迁移** | 所有 Vuex 模块迁移至 Pinia，废弃 Vuex |
| **高级搜索** | `advanced_search` feature flag，全文检索增强 |
| **IMAP 认证扩展** | 支持多种 IMAP 认证类型（OAuth、App Password 等） |

### 长期

| 方向 | 具体内容 |
|------|----------|
| **AI 深度集成** | RubyLLM 框架扩展、pgvector 向量召回、多模型支持 |
| **必填属性工作流** | `conversation_required_attributes`：关闭对话前强制补全字段 |
| **多租户高可用** | Redis Sentinel / Cluster、数据库读写分离、异步数据库迁移 |

---

## 附录：关键文件速查

| 文件 / 目录 | 说明 |
|-------------|------|
| `config/routes.rb` | 全量路由定义 |
| `app/dispatchers/dispatcher.rb` | 事件总线入口 |
| `app/listeners/` | 事件处理器集合 |
| `app/models/channel/` | 渠道类型模型 |
| `app/javascript/dashboard/featureFlags.js` | 功能开关常量 |
| `app/javascript/dashboard/store/index.js` | Vuex store 汇总 |
| `app/javascript/dashboard/composables/store.js` | Vuex + `<script setup>` 桥接 |
| `app/javascript/dashboard/components-next/` | 新组件库 |
| `config/sidekiq.yml` | Sidekiq 队列优先级配置 |
| `config/storage.yml` | Active Storage 后端配置 |
| `enterprise/` | Enterprise Edition 代码目录 |
| `deployment/` | systemd 服务文件 + Nginx 配置 + 安装脚本 |
