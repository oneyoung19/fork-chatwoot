# Bot Handoff Flow Design

**Date**: 2026-05-13  
**Status**: Approved  
**Scope**: Fix post-handoff bot re-entry bug; add activity message for button-triggered handoff

---

## Background

Chatwoot is configured with a Next.js RAG bot (via AgentBot webhook). When a user starts a conversation, the inbox has an active bot and the conversation starts in `pending` status. The bot auto-replies via the webhook. When the user requests a human agent, handoff is triggered via one of two paths.

---

## Problem Statement

### Bug: Bot responds after handoff when no agent is assigned yet

After text-triggered handoff (`isHandoffRequest` detects keyword), the conversation status becomes `open` via `bot_handoff!`. However, the next user message still fires the webhook, and the gate condition only checks for `assignee`:

```typescript
const assignee = meta?.assignee
if (assignee) { return ignored }
```

If no specific agent has been assigned yet (only a team, or neither), `assignee` is `null` and the bot continues responding with RAG answers — overriding the handoff semantics.

### UX Gap: Button-triggered handoff has no user-facing confirmation

Text path sends an outgoing bot message ("好的，正在为您转接...") before triggering handoff. Button path (`POST /api/v1/widget/conversations/bot_handoff`) calls `bot_handoff!` directly with no message to the user. The button simply disappears silently.

### Docs inconsistency

`docs/bot_rag.md` states the Transfer button shows for `open` status; the actual code shows it for `pending`.

---

## Architecture: Post-Fix State Machine

```
User starts conversation
     │
     ▼
[PENDING] Bot mode
  ├─ Any message → AgentBotListener → webhook → RAG reply ✅
  │
  ├─── Handoff triggered (two paths)
  │     │
  │     ├── Path 1: User types handoff keyword
  │     │     webhook.ts detects → chatwootSendMessage("好的，正在转接...")
  │     │                        → chatwootTriggerHandoff → toggle_status {status: open}
  │     │                          → Rails: bot_handoff! → status=OPEN
  │     │
  │     └── Path 2: User clicks header button
  │           widget → POST /api/v1/widget/conversations/bot_handoff
  │                  → Rails: create activity message + bot_handoff! → status=OPEN
  │
  ▼
[OPEN] Waiting for agent
  ├─ User message → AgentBotListener → webhook → status≠pending → ❌ ignored
  └─ Inbox members notified → agent joins
         │
         ▼
[OPEN + assignee] Human agent mode
  └─ User message → AgentBotListener → webhook → assignee present → ❌ ignored
```

### Gate condition change in webhook.ts

| Scenario | Before | After |
|---|---|---|
| pending + no assignee | ✅ Bot replies | ✅ Bot replies |
| open + no assignee (just handed off, agent not yet joined) | ❌ Bot replies (Bug) | ✅ Ignored |
| open + assignee | ✅ Ignored | ✅ Ignored |

---

## Changes

### 1. `webhook.ts` — Fix gate condition

**Location**: Before `handleMessage` call (around line 54)

Replace:
```typescript
const assignee = meta?.assignee
if (assignee) {
  console.log(`[chatwoot] account=${accountId} conv=${conversationId} — human assignee present, ignored`)
  return NextResponse.json({ status: 'ignored' })
}
```

With:
```typescript
const convStatus = (conversation?.status as string | undefined) ?? ''
const assignee = meta?.assignee

if (convStatus !== 'pending' || assignee) {
  console.log(`[chatwoot] conv=${conversationId} ignored: status=${convStatus}, assignee=${!!assignee}`)
  return NextResponse.json({ status: 'ignored' })
}
```

**Why**: `status === 'pending'` is the canonical signal that the bot owns the conversation. Any other status (open, resolved, snoozed) means a human or the system has taken over.

### 2. `app/controllers/api/v1/widget/conversations_controller.rb` — Activity message on button handoff

**Location**: `bot_handoff` action

Replace:
```ruby
def bot_handoff
  return head :unprocessable_entity if conversation.resolved?

  conversation.bot_handoff!
  head :ok
end
```

With:
```ruby
def bot_handoff
  return head :unprocessable_entity if conversation.resolved?

  conversation.messages.create!(
    account: conversation.account,
    inbox: conversation.inbox,
    message_type: :activity,
    content: I18n.t('conversations.activity.bot_handoff_initiated'),
    content_type: :text
  )
  conversation.bot_handoff!
  head :ok
end
```

### 3. `config/locales/en.yml` — i18n key

Under `conversations.activity`, add:
```yaml
bot_handoff_initiated: "Your session is being transferred to a live agent. Our representative will assist you shortly."
```

### 4. `docs/bot_rag.md` — Fix button visibility description

Line ~298, change:
> 按钮仅在对话为 `open` 状态且有 conversation id 时显示。

To:
> 按钮仅在对话为 `pending` 状态（Bot 接管中）且有 conversation id 时显示。Bot 转人工后状态变为 `open`，按钮自动消失。

---

## File Change Summary

| File | Change |
|---|---|
| `webhook.ts` | Replace assignee-only gate with `status !== 'pending' \|\| assignee` |
| `app/controllers/api/v1/widget/conversations_controller.rb` | Create activity message before `bot_handoff!` |
| `config/locales/en.yml` | Add `conversations.activity.bot_handoff_initiated` key |
| `docs/bot_rag.md` | Fix button visibility condition description |

---

## Out of Scope (recorded for future)

**Plan B — Unified message form**: Remove `chatwootSendMessage` from `webhook.ts` handoff path; have `bot_handoff!` at the Rails model level create the activity message for both paths. This makes both paths visually identical (both show activity-style message). Requires verifying that the bot-token `toggle_status` call correctly triggers `bot_handoff!` and the message creation. Deferred until Plan A is validated in production.

---

## Testing Notes

1. Text-triggered handoff: type "转人工" → confirm outgoing bot message appears → subsequent user message should NOT trigger RAG reply
2. Button-triggered handoff: click header button → confirm activity message appears in chat → subsequent user message should NOT trigger RAG reply
3. Normal conversation: user messages in `pending` conversation → RAG continues to reply correctly
4. Agent-assigned conversation: agent joins, user messages → RAG stays silent
