# Bot Handoff Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the post-handoff bot re-entry bug and add an activity message when the header button triggers handoff.

**Architecture:** Three targeted edits — (1) `webhook.ts` gate condition adds a `status` check so the RAG bot ignores messages after handoff even when no agent is assigned yet; (2) the Rails widget `bot_handoff` controller action creates an `activity`-type message before calling `bot_handoff!`; (3) `docs/bot_rag.md` corrects the button-visibility description.

**Tech Stack:** TypeScript (Next.js webhook), Ruby on Rails (widget controller), YAML (i18n)

---

## File Map

| File | Change |
|---|---|
| `webhook.ts` | Replace assignee-only gate with `status !== 'pending' \|\| assignee` |
| `app/controllers/api/v1/widget/conversations_controller.rb` | Create activity message before `bot_handoff!` |
| `config/locales/en.yml` | Add `conversations.activity.handoff.initiated` key |
| `docs/bot_rag.md` | Fix button visibility condition (~line 298) |

---

## Task 1: Fix webhook.ts gate condition

**Files:**
- Modify: `webhook.ts:54-58`

- [ ] **Step 1: Open `webhook.ts` and locate the assignee guard (around line 54)**

Current code block:
```typescript
  // If a human agent is already assigned, let them handle it
  const meta = conversation?.meta as Record<string, unknown> | undefined
  const assignee = meta?.assignee
  if (assignee) {
    console.log(`[chatwoot] account=${accountId} conv=${conversationId} — human assignee present, ignored`)
    return NextResponse.json({ status: 'ignored' })
  }
```

- [ ] **Step 2: Replace that block with the status + assignee compound check**

```typescript
  const meta = conversation?.meta as Record<string, unknown> | undefined
  const convStatus = (conversation?.status as string | undefined) ?? ''
  const assignee = meta?.assignee

  if (convStatus !== 'pending' || assignee) {
    console.log(`[chatwoot] conv=${conversationId} ignored: status=${convStatus}, assignee=${!!assignee}`)
    return NextResponse.json({ status: 'ignored' })
  }
```

- [ ] **Step 3: Verify the teamId extraction line still follows the new block**

The `const team = meta?.team` and `const teamId = ...` lines should still be present after the guard. Confirm the file reads:

```typescript
  const meta = conversation?.meta as Record<string, unknown> | undefined
  const convStatus = (conversation?.status as string | undefined) ?? ''
  const assignee = meta?.assignee

  if (convStatus !== 'pending' || assignee) {
    console.log(`[chatwoot] conv=${conversationId} ignored: status=${convStatus}, assignee=${!!assignee}`)
    return NextResponse.json({ status: 'ignored' })
  }

  const team = meta?.team as Record<string, unknown> | undefined
  const teamId = team?.id as number | undefined
```

- [ ] **Step 4: Commit**

```bash
git add webhook.ts
git commit -m "fix(webhook): ignore messages when conversation is not pending"
```

---

## Task 2: Add i18n key for handoff activity message

**Files:**
- Modify: `config/locales/en.yml:269` (inside `conversations.activity`, after the `agent_bot` block)

- [ ] **Step 1: Open `config/locales/en.yml` and find the `activity:` block (~line 261)**

It looks like:
```yaml
    activity:
      captain:
        ...
      agent_bot:
        error_moved_to_open: '...'
      status:
        ...
```

- [ ] **Step 2: Add a `handoff` sub-key directly after the `agent_bot` block**

```yaml
      handoff:
        initiated: "Your session is being transferred to a live agent. Our representative will assist you shortly."
```

The final structure around that area:
```yaml
      agent_bot:
        error_moved_to_open: 'Conversation was marked open by system due to an error with the agent bot.'
      handoff:
        initiated: "Your session is being transferred to a live agent. Our representative will assist you shortly."
      status:
        resolved: 'Conversation was marked resolved by %{user_name}'
```

- [ ] **Step 3: Commit**

```bash
git add config/locales/en.yml
git commit -m "i18n(en): add bot handoff activity message key"
```

---

## Task 3: Create activity message in widget bot_handoff controller

**Files:**
- Modify: `app/controllers/api/v1/widget/conversations_controller.rb:67-72`

- [ ] **Step 1: Open the file and locate the `bot_handoff` action (~line 67)**

Current code:
```ruby
def bot_handoff
  return head :unprocessable_entity if conversation.resolved?

  conversation.bot_handoff!
  head :ok
end
```

- [ ] **Step 2: Replace it with the version that creates the activity message first**

```ruby
def bot_handoff
  return head :unprocessable_entity if conversation.resolved?

  conversation.messages.create!(
    account_id: conversation.account_id,
    inbox_id: conversation.inbox_id,
    message_type: :activity,
    content: I18n.t('conversations.activity.handoff.initiated')
  )
  conversation.bot_handoff!
  head :ok
end
```

Note: No `sender` or `content_type` is needed — activity messages follow the pattern used throughout the codebase (see `app/models/concerns/activity_message_handler.rb:91`).

- [ ] **Step 3: Commit**

```bash
git add app/controllers/api/v1/widget/conversations_controller.rb
git commit -m "feat(widget): send activity message on button-triggered bot handoff"
```

---

## Task 4: Fix docs/bot_rag.md button visibility description

**Files:**
- Modify: `docs/bot_rag.md` (~line 298)

- [ ] **Step 1: Find the line that says the button shows for `open` status**

It reads:
```
按钮仅在对话为 `open` 状态且有 conversation id 时显示。
```

- [ ] **Step 2: Replace with the correct description**

```
按钮仅在对话为 `pending` 状态（Bot 接管中）且有 conversation id 时显示。Bot 转人工后状态变为 `open`，按钮自动消失。
```

- [ ] **Step 3: Commit**

```bash
git add docs/bot_rag.md
git commit -m "docs(bot_rag): correct Transfer button visibility condition"
```

---

## Manual Verification

After all tasks are complete, verify these scenarios end-to-end:

**Scenario A — Text-triggered handoff, bot stays silent after**
1. Open widget, send a normal question → confirm RAG reply appears
2. Send "转人工" → confirm outgoing bot message "好的，正在为您转接..." appears
3. Send another message → confirm **no bot reply** (status is now `open`, gate blocks it)

**Scenario B — Button-triggered handoff with activity message**
1. Open widget in `pending` conversation (bot has replied at least once)
2. Click the Transfer button in the header → confirm an **activity message** appears in the chat saying "Your session is being transferred to a live agent..."
3. Send a message → confirm **no bot reply**

**Scenario C — Normal conversation not disrupted**
1. Open widget, send messages back and forth with bot in `pending` conversation
2. Confirm bot continues to reply via RAG
3. Confirm Transfer button is visible (status = pending)
