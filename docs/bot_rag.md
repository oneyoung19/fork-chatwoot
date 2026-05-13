# RAG Bot 集成设计

> 目标：在 Chatwoot widget 中接入已有的 Next.js LLM RAG 服务，优先由机器人自动回答，用户可通过 NLP 意图或 UI 按钮转人工客服。

---

## 整体架构

```
┌─────────────────────┐
│   用户浏览器          │
│  ┌───────────────┐  │
│  │  Widget iframe │  │
│  │  (Vue 3 SPA)  │  │
│  └───────┬───────┘  │
└──────────│──────────┘
           │ HTTP POST /api/v1/widget/messages
           ▼
┌──────────────────────────────────┐
│         Chatwoot Rails           │
│                                  │
│  MessagesController              │
│       ↓ message_created event    │
│  AgentBotListener                │
│       ↓ webhook (async Sidekiq)  │
│  AgentBots::WebhookJob ──────────┼──▶ POST {nextjs}/api/rag-bot/webhook
│                                  │
│  AgentBot record                 │
│  (outgoing_url = Next.js URL)    │
└──────────────────────────────────┘
           ▲
           │ POST /api/v1/accounts/{id}/conversations/{id}/messages
           │   (api_access_token: AgentBot token)
┌──────────┴──────────────────────┐
│     Next.js App (已有服务)       │
│                                  │
│  POST /api/rag-bot/webhook       │
│       ↓                          │
│  createLLM(content)              │  ← 你已有的 RAG + LLM 函数
│       ↓                          │
│  sendToChatwoot(id, answer)      │
│       ↓（转人工时）               │
│  triggerHandoff(id)              │
└──────────────────────────────────┘
```

### 组件职责边界

| 组件 | 职责 | 不负责 |
|------|------|--------|
| Chatwoot | 消息存储、事件分发、AgentBot webhook 触发 | 不知道 RAG 的存在 |
| Next.js 服务 | 接收 webhook、调用 `createLLM`、回调 Chatwoot API | 不直接操作 Chatwoot DB |
| Widget 前端 | 展示消息、提供"转人工"按钮 | 不直接调 RAG 服务 |

### 改动范围

| 位置 | 改动 |
|------|------|
| Chatwoot 后端 | 零代码改动，管理后台注册 AgentBot 并关联 Inbox |
| Widget 前端 | 新增"转人工"按钮，点击调用 widget `bot_handoff` API |
| Next.js 服务 | 新增一个 API 路由 `app/api/rag-bot/webhook/route.ts` |

---

## Chatwoot 侧配置

### 注册 AgentBot

在管理后台（Settings → Integrations → Agent Bots）创建一条 AgentBot 记录：

| 字段 | 值 |
|------|----|
| Name | RAG Bot（可自定义） |
| Outgoing URL | `https://your-nextjs-app.com/api/rag-bot/webhook` |
| Bot Type | Webhook |

生成的 `access_token` 供 Next.js 服务调用 Chatwoot API 使用。

### 关联 Inbox

Settings → Inboxes → 选择 widget inbox → Configuration → Agent Bot → 选择上面创建的 RAG Bot。

关联后，该 inbox 的每条入站消息都会触发 `AgentBotListener#message_created` → 异步发送 webhook。

---

## Next.js 侧改动

### 接口契约：Chatwoot → Next.js

```
POST /api/rag-bot/webhook
Headers:
  X-Chatwoot-Timestamp: 1715000000
  X-Chatwoot-Signature: sha256=<HMAC-SHA256(secret, "{ts}.{body}")>
  Content-Type: application/json
```

#### 完整 Payload 结构（message_created 事件）

```json
{
  "event": "message_created",

  "id": 1234,
  "content": "你们的退款政策是什么？",
  "content_type": "text",
  "message_type": "incoming",
  "private": false,
  "created_at": "2024-01-15T10:30:00.000Z",
  "source_id": null,
  "additional_attributes": {},
  "content_attributes": {},

  "account": {
    "id": 1,
    "name": "My Company"
  },

  "inbox": {
    "id": 3,
    "name": "Website Widget"
  },

  "conversation": {
    "id": 42,
    "inbox_id": 3,
    "status": "open",
    "labels": [],
    "custom_attributes": {},
    "can_reply": true,
    "channel": "Channel::WebWidget",
    "unread_count": 1,
    "priority": null,
    "waiting_since": 0,
    "created_at": 1715000000,
    "timestamp": 1715000000,
    "meta": {
      "sender": { "id": 5, "name": "访客用户" },
      "assignee": null,
      "assignee_type": "agent_bot",
      "team": null,
      "hmac_verified": false
    },
    "messages": []
  },

  "sender": {
    "id": 5,
    "name": "访客用户",
    "email": null,
    "phone_number": null,
    "avatar": "https://...",
    "identifier": null,
    "additional_attributes": {},
    "custom_attributes": {},
    "account": { "id": 1, "name": "My Company" }
  }
}
```

#### Next.js 路由里需要用到的字段

```typescript
payload.event              // "message_created"
payload.message_type       // "incoming" | "outgoing" | "activity" | "template"
payload.content            // 用户消息文本
payload.conversation.id    // display_id，用于拼 Chatwoot API 回调 URL
payload.account.id         // account_id，用于拼 Chatwoot API 回调 URL
payload.sender?.name       // 发送者名字（可选）
```

> **注意：`conversation.id` 是 `display_id`（对外展示编号），不是数据库内部主键。**  
> 直接用它拼 `/api/v1/accounts/{account.id}/conversations/{conversation.id}/messages` 即可。

#### 必须过滤的事件类型

Bot 自己发出的回复也会再次触发 `message_created` webhook，`message_type` 为 `"outgoing"`。**不过滤会导致死循环**（Bot 回复 → 触发 webhook → Bot 再回复 → …）。

```typescript
// 只处理用户入站消息，其余全部忽略
if (payload.event !== 'message_created' || payload.message_type !== 'incoming') {
  return Response.json({ status: 'ignored' })
}
```

`message_type` 的所有可能值：

| 值 | 含义 | 是否处理 |
|----|------|---------|
| `"incoming"` | 用户发送的消息 | ✅ 处理 |
| `"outgoing"` | Bot / Agent 发出的回复 | ❌ 忽略 |
| `"activity"` | 系统事件（分配、状态变更等） | ❌ 忽略 |
| `"template"` | 模板消息 | ❌ 忽略 |

### 接口契约：Next.js → Chatwoot（发送回复）

```
POST {CHATWOOT_BASE_URL}/api/v1/accounts/{account_id}/conversations/{conversation_id}/messages
Headers:
  api_access_token: {CHATWOOT_AGENT_BOT_TOKEN}
  Content-Type: application/json

{
  "content": "RAG 生成的回答",
  "message_type": "outgoing",
  "private": false
}
```

### 接口契约：Next.js → Chatwoot（触发转人工）

```
POST {CHATWOOT_BASE_URL}/api/v1/accounts/{account_id}/conversations/{conversation_id}/toggle_status
Headers:
  api_access_token: {CHATWOOT_AGENT_BOT_TOKEN}
  Content-Type: application/json

{ "status": "open" }
```

使用 AgentBot token 调用 + `status: open` 时，Chatwoot 内部自动触发 `bot_handoff!`，将对话标记为等待人工接管。

### Webhook 路由骨架

```typescript
// app/api/rag-bot/webhook/route.ts

const CHATWOOT_BASE = process.env.CHATWOOT_BASE_URL!
const ACCOUNT_ID    = process.env.CHATWOOT_ACCOUNT_ID!
const BOT_TOKEN     = process.env.CHATWOOT_AGENT_BOT_TOKEN!

export async function POST(req: Request) {
  const body = await req.text()
  const payload = JSON.parse(body)

  // 只处理用户入站消息
  if (payload.event !== 'message_created' || payload.message_type !== 'incoming') {
    return Response.json({ status: 'ignored' })
  }

  const conversationId: number = payload.conversation.id
  const userMessage: string    = payload.content

  // 立即返回 200，避免 Chatwoot webhook 超时重试
  handleMessage(conversationId, userMessage).catch(console.error)
  return Response.json({ status: 'ok' })
}

async function handleMessage(conversationId: number, content: string) {
  // 调用你已有的 createLLM（插入 RAG 检索 + LLM 生成逻辑）
  const answer = await createLLM(content)
  await sendToChatwoot(conversationId, answer)
}

async function sendToChatwoot(conversationId: number, content: string) {
  await fetch(
    `${CHATWOOT_BASE}/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      headers: { 'api_access_token': BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, message_type: 'outgoing', private: false }),
    }
  )
}

async function triggerHandoff(conversationId: number) {
  await fetch(
    `${CHATWOOT_BASE}/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversationId}/toggle_status`,
    {
      method: 'POST',
      headers: { 'api_access_token': BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'open' }),
    }
  )
}
```

### 环境变量（Next.js `.env.local`）

```bash
CHATWOOT_BASE_URL=https://your-chatwoot.example.com
CHATWOOT_ACCOUNT_ID=1
CHATWOOT_AGENT_BOT_TOKEN=xxxx     # AgentBot 的 access_token
CHATWOOT_AGENT_BOT_SECRET=xxxx   # 用于验签（可选）
```

---

## Widget 前端改动

### "转人工"按钮

在 `app/javascript/widget/components/HeaderActions.vue` 新增一个按钮。

点击后调用 Vuex action `conversation/requestBotHandoff`，该 action 调用新增的 widget API `POST /api/v1/widget/conversations/bot_handoff`，Chatwoot 后端直接执行 `conversation.bot_handoff!`。

按钮仅在对话为 `open` 状态且有 conversation id 时显示。

---

## 对话状态流转

```
用户发起对话
     │
     ▼
[Bot 模式] Next.js RAG Bot 自动回复
     │
     ├─ 用户点击"转人工"按钮（Widget → Chatwoot bot_handoff endpoint）
     │
     └─ NLP 检测到转人工意图（Next.js → Chatwoot toggle_status API）
             │
             ▼
        bot_handoff! 触发
             │
             ▼
[等待人工] conversation 标记为 open，进入人工队列
             │
             ▼
[人工模式] 普通 Agent 接管，正常对话
```
