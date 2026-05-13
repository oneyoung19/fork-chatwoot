import { type NextRequest, NextResponse } from 'next/server'
import { buildContext } from '@packages/ai/rag/generation'
import { createPromptStream, type ModelId } from '@packages/ai/llm'
import { RAG_GENERATION_OPTIONS } from '@packages/ai/quality/quality-rag'

const BASE = process.env.CHATWOOT_BASE_URL!
const BOT_TOKEN = process.env.CHATWOOT_AGENT_BOT_TOKEN!
const SECRET = process.env.CHATWOOT_AGENT_BOT_SECRET ?? ''
const BOT_MODEL = (process.env.CHATWOOT_BOT_MODEL as ModelId) ?? undefined

const HANDOFF_PATTERNS = [
  '转人工', '人工客服', '人工服务', '真人客服', '找人工', '要人工',
  'human agent', 'talk to human', 'speak to agent', 'real person', 'transfer to human',
]

function isHandoffRequest(content: string): boolean {
  const lower = content.toLowerCase()
  return HANDOFF_PATTERNS.some((p) => lower.includes(p.toLowerCase()))
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text()

  if (SECRET && !(await isValidSignature(req.headers, rawBody))) {
    console.warn('[chatwoot] signature mismatch — request rejected')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    console.warn('[chatwoot] invalid JSON body')
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (payload.event !== 'message_created' || payload.message_type !== 'incoming') {
    console.log(`[chatwoot] ignored event=${payload.event} type=${payload.message_type}`)
    return NextResponse.json({ status: 'ignored' })
  }

  const account = payload.account as Record<string, unknown> | undefined
  const accountId = account?.id as number | undefined
  const conversation = payload.conversation as Record<string, unknown> | undefined
  const conversationId = conversation?.id as number | undefined
  const content = (payload.content as string | undefined) ?? ''

  if (!accountId || !conversationId || !content.trim()) {
    console.warn('[chatwoot] missing accountId / conversationId / content — ignored')
    return NextResponse.json({ status: 'ignored' })
  }

  // If a human agent is already assigned, let them handle it
  const meta = conversation?.meta as Record<string, unknown> | undefined
  const assignee = meta?.assignee
  if (assignee) {
    console.log(`[chatwoot] account=${accountId} conv=${conversationId} — human assignee present, ignored`)
    return NextResponse.json({ status: 'ignored' })
  }

  const team = meta?.team as Record<string, unknown> | undefined
  const teamId = team?.id as number | undefined

  console.log(`[chatwoot] account=${accountId} conv=${conversationId} teamId=${teamId ?? 'none'} content="${content.slice(0, 60)}"`)

  // Return 200 immediately so Chatwoot doesn't time out waiting for the LLM
  handleMessage(accountId, conversationId, content.trim(), teamId).catch((err) =>
    console.error('[chatwoot] reply error:', err)
  )

  return NextResponse.json({ status: 'ok' })
}

async function handleMessage(accountId: number, conversationId: number, content: string, teamId?: number) {
  if (isHandoffRequest(content)) {
    console.log(`[chatwoot] conv=${conversationId} handoff detected`)
    await chatwootSendMessage(accountId, conversationId, '好的，正在为您转接人工客服，请稍候。')
    await chatwootTriggerHandoff(accountId, conversationId, teamId)
    console.log(`[chatwoot] conv=${conversationId} handoff complete`)
    return
  }

  console.log(`[chatwoot] conv=${conversationId} calling RAG...`)
  const context = await buildContext(content)
  const system = RAG_GENERATION_OPTIONS.createSystemPrompt(context)
  const result = createPromptStream(content, BOT_MODEL, system)
  const answer = await result.text
  console.log(`[chatwoot] conv=${conversationId} RAG answered (${answer.length} chars)`)
  await chatwootSendMessage(accountId, conversationId, answer)
}

async function chatwootSendMessage(accountId: number, conversationId: number, content: string) {
  await fetch(
    `${BASE}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      headers: { api_access_token: BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, message_type: 'outgoing', private: false })
    }
  )
}

export async function chatwootTriggerHandoff(accountId: number, conversationId: number, teamId?: number) {
  const statusRes = await fetch(
    `${BASE}/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_status`,
    {
      method: 'POST',
      headers: { api_access_token: BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'open' }),
    }
  )
  if (!statusRes.ok) {
    console.error('[chatwoot bot] handoff toggle_status failed:', statusRes.status)
  }

  if (teamId) {
    const assignRes = await fetch(
      `${BASE}/api/v1/accounts/${accountId}/conversations/${conversationId}`,
      {
        method: 'PATCH',
        headers: { api_access_token: BOT_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_id: teamId }),
      }
    )
    if (!assignRes.ok) {
      console.error('[chatwoot bot] handoff team assignment failed:', assignRes.status)
    }
  }
}

async function isValidSignature(headers: Headers, body: string): Promise<boolean> {
  const ts = headers.get('x-chatwoot-timestamp') ?? ''
  const sig = headers.get('x-chatwoot-signature') ?? ''
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const raw = await crypto.subtle.sign('HMAC', key, encoder.encode(`${ts}.${body}`))
  const expected =
    'sha256=' +
    Array.from(new Uint8Array(raw))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  return expected === sig
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return NextResponse.json({ status: 'ok' })
}
