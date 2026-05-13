# RAG Bot Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the existing Next.js LLM RAG service with the Chatwoot widget — the bot auto-replies via Chatwoot's AgentBot webhook system; users can transfer to a human agent via a UI button or NLP intent detection in the Next.js service.

**Architecture:** Chatwoot's AgentBot infrastructure (AgentBotListener → WebhookJob) forwards incoming widget messages to a new Next.js API route. That route calls the existing `createLLM` function and posts the answer back to Chatwoot as the AgentBot. The widget gains a "转人工" button that calls a new `bot_handoff` widget endpoint; the Next.js service can also trigger handoff via the Chatwoot API when it detects intent.

**Tech Stack:** Rails 7 (new widget endpoint), Vue 3 Options API + Vuex (widget UI), Next.js App Router API route (TypeScript).

---

## File Map

### Chatwoot (this repo)

| Action | File |
|--------|------|
| Modify | `config/routes.rb` |
| Modify | `app/controllers/api/v1/widget/conversations_controller.rb` |
| Modify | `app/javascript/widget/api/conversation.js` |
| Modify | `app/javascript/widget/store/modules/conversation/actions.js` |
| Modify | `app/javascript/widget/i18n/locale/en.json` |
| Modify | `app/javascript/widget/components/HeaderActions.vue` |

### Next.js app (your existing service)

| Action | File |
|--------|------|
| Create | `app/api/rag-bot/webhook/route.ts` |

---

## Task 1: Add `bot_handoff` widget API endpoint (Rails)

**Files:**
- Modify: `config/routes.rb:443-451`
- Modify: `app/controllers/api/v1/widget/conversations_controller.rb`

- [ ] **Step 1: Add route**

In `config/routes.rb`, inside the `resources :conversations, only: [:index, :create]` collection block (lines 443–451), add `post :bot_handoff`:

```ruby
resources :conversations, only: [:index, :create] do
  collection do
    post :destroy_custom_attributes
    post :set_custom_attributes
    post :update_last_seen
    post :toggle_typing
    post :transcript
    get  :toggle_status
    post :bot_handoff   # ← add this line
  end
end
```

- [ ] **Step 2: Add controller action**

In `app/controllers/api/v1/widget/conversations_controller.rb`:

1. Add `:bot_handoff` to the `before_action :render_not_found_if_empty` line:

```ruby
before_action :render_not_found_if_empty, only: [:toggle_typing, :toggle_status, :set_custom_attributes, :destroy_custom_attributes, :bot_handoff]
```

2. Add the action before the `private` keyword:

```ruby
def bot_handoff
  return head :unprocessable_entity if conversation.resolved?

  conversation.bot_handoff!
  head :ok
end
```

- [ ] **Step 3: Smoke test routing**

```bash
bundle exec rails routes | grep bot_handoff
```

Expected:
```
bot_handoff_api_v1_widget_conversations POST /api/v1/widget/conversations/bot_handoff(.:format)
```

- [ ] **Step 4: Commit**

```bash
git add config/routes.rb app/controllers/api/v1/widget/conversations_controller.rb
git commit -m "feat(widget): add bot_handoff endpoint for human agent transfer"
```

---

## Task 2: Widget API client + Vuex action

**Files:**
- Modify: `app/javascript/widget/api/conversation.js`
- Modify: `app/javascript/widget/store/modules/conversation/actions.js`

- [ ] **Step 1: Add API function**

In `app/javascript/widget/api/conversation.js`, add after the `toggleStatus` function:

```javascript
const requestBotHandoffAPI = async () => {
  return API.post(
    `/api/v1/widget/conversations/bot_handoff${window.location.search}`
  );
};
```

Add to the export block at the bottom:

```javascript
export {
  createConversationAPI,
  sendMessageAPI,
  getConversationAPI,
  getMessagesAPI,
  sendAttachmentAPI,
  toggleTyping,
  setUserLastSeenAt,
  sendEmailTranscript,
  toggleStatus,
  setCustomAttributes,
  deleteCustomAttribute,
  requestBotHandoffAPI,  // ← add
};
```

- [ ] **Step 2: Add Vuex action**

In `app/javascript/widget/store/modules/conversation/actions.js`:

1. Add to the import at the top:

```javascript
import {
  createConversationAPI,
  sendMessageAPI,
  getMessagesAPI,
  sendAttachmentAPI,
  toggleTyping,
  setUserLastSeenAt,
  toggleStatus,
  setCustomAttributes,
  deleteCustomAttribute,
  requestBotHandoffAPI,  // ← add
} from 'widget/api/conversation';
```

2. Add the action inside the `actions` object, after `resolveConversation`:

```javascript
requestBotHandoff: async () => {
  try {
    await requestBotHandoffAPI();
  } catch (error) {
    // IgnoreError
  }
},
```

- [ ] **Step 3: Commit**

```bash
git add app/javascript/widget/api/conversation.js \
        app/javascript/widget/store/modules/conversation/actions.js
git commit -m "feat(widget): add requestBotHandoff API call and Vuex action"
```

---

## Task 3: Widget UI — "转人工" button

**Files:**
- Modify: `app/javascript/widget/i18n/locale/en.json`
- Modify: `app/javascript/widget/components/HeaderActions.vue`

- [ ] **Step 1: Add i18n key**

In `app/javascript/widget/i18n/locale/en.json`, add alongside the existing `"END_CONVERSATION"` key:

```json
"TRANSFER_TO_HUMAN": "Talk to a person",
```

- [ ] **Step 2: Add computed property and method**

In `app/javascript/widget/components/HeaderActions.vue`, inside `computed`:

```javascript
showTransferButton() {
  return (
    this.conversationStatus === CONVERSATION_STATUS.OPEN &&
    !!this.conversationAttributes.id
  );
},
```

Inside `methods`:

```javascript
transferToHuman() {
  this.$store.dispatch('conversation/requestBotHandoff');
},
```

- [ ] **Step 3: Add button to template**

Inside the `<div v-if="showHeaderActions"...>` block, before the existing end-conversation button:

```html
<button
  v-if="showTransferButton"
  class="button transparent compact"
  :title="$t('TRANSFER_TO_HUMAN')"
  @click="transferToHuman"
>
  <FluentIcon icon="person" size="22" class="text-n-slate-12" />
</button>
```

- [ ] **Step 4: Verify in browser**

```bash
pnpm dev
```

Open a widget conversation in `open` status. Confirm the "Talk to a person" button appears and clicking it hits `POST /api/v1/widget/conversations/bot_handoff`.

- [ ] **Step 5: Commit**

```bash
git add app/javascript/widget/i18n/locale/en.json \
        app/javascript/widget/components/HeaderActions.vue
git commit -m "feat(widget): add Transfer to Human button in chat header"
```

---

## Task 4: Add Chatwoot webhook route to Next.js

**File:** `app/api/rag-bot/webhook/route.ts` (in your Next.js project)

This is the only change needed in your Next.js service. It receives Chatwoot events, calls your existing `createLLM`, and posts the answer back.

- [ ] **Step 1: Add env vars to `.env.local`**

```bash
CHATWOOT_BASE_URL=https://your-chatwoot.example.com
CHATWOOT_ACCOUNT_ID=1
CHATWOOT_AGENT_BOT_TOKEN=xxxx     # AgentBot access_token from Chatwoot admin
CHATWOOT_AGENT_BOT_SECRET=xxxx   # AgentBot secret (for signature verification)
```

- [ ] **Step 2: Create the webhook route**

```typescript
// app/api/rag-bot/webhook/route.ts
import { createLLM } from '@/lib/llm'  // adjust to your actual import path

const BASE      = process.env.CHATWOOT_BASE_URL!
const ACCOUNT   = process.env.CHATWOOT_ACCOUNT_ID!
const BOT_TOKEN = process.env.CHATWOOT_AGENT_BOT_TOKEN!
const SECRET    = process.env.CHATWOOT_AGENT_BOT_SECRET ?? ''

export async function POST(req: Request) {
  const rawBody = await req.text()

  if (SECRET && !(await isValidSignature(req.headers, rawBody))) {
    return new Response('Unauthorized', { status: 401 })
  }

  const payload = JSON.parse(rawBody)

  if (payload.event !== 'message_created' || payload.message_type !== 'incoming') {
    return Response.json({ status: 'ignored' })
  }

  const conversationId: number = payload.conversation.id
  const content: string        = payload.content ?? ''

  if (!content.trim()) return Response.json({ status: 'ignored' })

  // Return 200 immediately; handle async so Chatwoot doesn't time out
  handleMessage(conversationId, content).catch(console.error)
  return Response.json({ status: 'ok' })
}

async function handleMessage(conversationId: number, content: string) {
  const answer = await createLLM(content)
  await chatwootSendMessage(conversationId, answer)
}

async function chatwootSendMessage(conversationId: number, content: string) {
  await fetch(
    `${BASE}/api/v1/accounts/${ACCOUNT}/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      headers: { 'api_access_token': BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, message_type: 'outgoing', private: false }),
    }
  )
}

// Call this from handleMessage when you detect a handoff intent in createLLM
export async function chatwootTriggerHandoff(conversationId: number) {
  await fetch(
    `${BASE}/api/v1/accounts/${ACCOUNT}/conversations/${conversationId}/toggle_status`,
    {
      method: 'POST',
      headers: { 'api_access_token': BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'open' }),
    }
  )
}

async function isValidSignature(headers: Headers, body: string): Promise<boolean> {
  const ts  = headers.get('x-chatwoot-timestamp') ?? ''
  const sig = headers.get('x-chatwoot-signature') ?? ''
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const raw = await crypto.subtle.sign('HMAC', key, encoder.encode(`${ts}.${body}`))
  const expected = 'sha256=' + Array.from(new Uint8Array(raw))
    .map(b => b.toString(16).padStart(2, '0')).join('')
  return expected === sig
}
```

- [ ] **Step 3: Handle handoff intent inside `createLLM`**

When your RAG + LLM logic detects the user wants a human agent, call `chatwootTriggerHandoff` before returning:

```typescript
// example inside your createLLM or a wrapper
import { chatwootTriggerHandoff } from '@/app/api/rag-bot/webhook/route'

async function handleMessage(conversationId: number, content: string) {
  const wantsHuman = await detectHandoffIntent(content)  // your intent check

  if (wantsHuman) {
    await chatwootSendMessage(conversationId, '正在为您转接人工客服，请稍候。')
    await chatwootTriggerHandoff(conversationId)
    return
  }

  const answer = await createLLM(content)
  await chatwootSendMessage(conversationId, answer)
}
```

- [ ] **Step 4: Register AgentBot in Chatwoot admin**

1. Settings → Integrations → Agent Bots → New Agent Bot
2. Name: `RAG Bot`
3. Outgoing URL: `https://your-nextjs-app.com/api/rag-bot/webhook`
4. Copy `access_token` → paste as `CHATWOOT_AGENT_BOT_TOKEN` in `.env.local`
5. Copy `secret` → paste as `CHATWOOT_AGENT_BOT_SECRET` in `.env.local`
6. Settings → Inboxes → your widget inbox → Configuration → Agent Bot → select `RAG Bot`

- [ ] **Step 5: End-to-end smoke test**

Open the widget, send a message. Confirm:
- RAG Bot replies within a few seconds (appears as AgentBot in Chatwoot dashboard)
- Clicking "Talk to a person" in the widget header triggers handoff
- Typing "我要转人工" (or similar) triggers NLP handoff from Next.js side
- After handoff, conversation shows as waiting for human agent in Chatwoot

- [ ] **Step 6: Commit (Next.js repo)**

```bash
git add app/api/rag-bot/webhook/route.ts
git commit -m "feat(rag-bot): add Chatwoot webhook endpoint"
```
