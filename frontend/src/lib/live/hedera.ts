/**
 * Reads Hedera testnet through the public mirror node — no key, no gateway.
 *
 * The gateway publishes every settlement receipt and every mandate refusal
 * to one HCS topic (told apart by `kind`), so replaying that topic gives the
 * dashboard the full audit trail even when the gateway itself is offline.
 */

import { config } from '../config'
import type { ComputeEvent, Receipt, Refusal, ServiceAnnouncement } from '../gateway/types'

export type TopicEntry =
  | { kind: 'receipt'; sequence: number; consensusAt: string; body: Receipt }
  | { kind: 'refusal'; sequence: number; consensusAt: string; body: Refusal }
  | { kind: 'announce'; sequence: number; consensusAt: string; body: ServiceAnnouncement }
  | { kind: 'teardown'; sequence: number; consensusAt: string; body: ComputeEvent }

interface MirrorMessage {
  consensus_timestamp: string
  sequence_number: number
  message: string
}

async function mirror<T>(path: string): Promise<T> {
  const response = await fetch(`${config.mirrorUrl}${path}`)
  if (!response.ok) throw new Error(`Mirror node ${response.status} for ${path}`)
  return (await response.json()) as T
}

function decodeBase64Json(base64: string): unknown {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

/** Consensus timestamps are `seconds.nanos`; turn one into ISO 8601. */
export function consensusToIso(timestamp: string): string {
  const [seconds, nanos = '0'] = timestamp.split('.')
  return new Date(Number(seconds) * 1000 + Math.floor(Number(nanos.padEnd(9, '0')) / 1e6)).toISOString()
}

/**
 * Newest-first replay of the topic, up to `maxPages` × 100 messages.
 * Receipts, refusals and service announcements; anything else is skipped.
 */
export async function readTopic(topicId: string, maxPages = 5): Promise<TopicEntry[]> {
  const out: TopicEntry[] = []
  let path: string | null = `/api/v1/topics/${topicId}/messages?limit=100&order=desc`
  for (let page = 0; path && page < maxPages; page++) {
    const data: { messages: MirrorMessage[]; links?: { next?: string | null } } = await mirror(path)
    for (const m of data.messages) {
      let body: unknown
      try {
        body = decodeBase64Json(m.message)
      } catch {
        continue
      }
      const kind = (body as { kind?: string })?.kind ?? ''
      const base = { sequence: m.sequence_number, consensusAt: consensusToIso(m.consensus_timestamp) }
      if (kind.startsWith('x402.') && kind.includes('settlement')) {
        out.push({ ...base, kind: 'receipt', body: body as Receipt })
      } else if (kind.startsWith('leash.mandate.refusal')) {
        out.push({ ...base, kind: 'refusal', body: body as Refusal })
      } else if (kind.startsWith('leash.service.announce')) {
        out.push({ ...base, kind: 'announce', body: body as ServiceAnnouncement })
      } else if (kind.startsWith('leash.compute.teardown')) {
        out.push({ ...base, kind: 'teardown', body: body as ComputeEvent })
      }
    }
    path = data.links?.next ?? null
  }
  return out
}

export interface PayerAccount {
  id: string
  hbar: number
  /** Balance of the configured asset token, in whole units. */
  token?: number
  /** Whether the account is associated with the asset token at all. */
  associated: boolean
  /** Whether it picks up new tokens on first receipt (HIP-904), so it
   *  needs no explicit association — only a balance. */
  autoAssociates: boolean
}

export async function readAccount(id: string): Promise<PayerAccount> {
  const [account, tokens] = await Promise.all([
    mirror<{ balance: { balance: number }; max_automatic_token_associations?: number }>(
      `/api/v1/accounts/${id}`,
    ),
    mirror<{ tokens: Array<{ token_id: string; balance: number }> }>(
      `/api/v1/accounts/${id}/tokens?token.id=${config.assetTokenId}`,
    ).catch(() => ({ tokens: [] })),
  ])
  const holding = tokens.tokens.find((t) => t.token_id === config.assetTokenId)
  return {
    id,
    hbar: account.balance.balance / 1e8,
    token: holding ? holding.balance / 10 ** config.assetDecimals : undefined,
    associated: Boolean(holding),
    autoAssociates:
      account.max_automatic_token_associations === -1 ||
      (account.max_automatic_token_associations ?? 0) > 0,
  }
}
