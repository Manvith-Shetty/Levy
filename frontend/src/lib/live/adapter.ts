/**
 * Turns the three live sources — the ENS tree on Sepolia, the HCS topic, and
 * (optionally) the gateway — into the same Agent / ActivityEvent / Policy /
 * Service model the demo data uses, so every screen works unchanged.
 *
 * Units: on-chain budgets and receipt amounts are raw integers. The tree's
 * asset (USDC, 6 decimals, by config) is what turns them into dollars.
 * Receipts settled in any other asset are listed but never counted toward
 * spend, because adding HBAR to USDC would be meaningless.
 */

import { config, etherscanUrl, hashscanUrl } from '../config'
import type { Receipt, Refusal, ServiceManifest } from '../gateway/types'
import type {
  ActivityEvent,
  Agent,
  AgentStatus,
  Network,
  Policy,
  ResourceKind,
  Service,
} from '../types'
import type { EnsNode, EnsSnapshot } from './ens'
import type { PayerAccount, TopicEntry } from './hedera'
import type { ProviderEntry } from './runner'

export type SourceKey = 'ens' | 'hcs' | 'gateway' | 'payer'

export interface LiveSnapshot {
  ens?: EnsSnapshot
  topic: TopicEntry[]
  topicId?: string
  gatewayReceipts: Receipt[]
  gatewayRefusals: Refusal[]
  manifest?: ServiceManifest
  payer?: PayerAccount
  /** Providers the agent runner shops across, when it's running. */
  providers?: ProviderEntry[]
  errors: Partial<Record<SourceKey, string>>
  fetchedAt: number
}

export interface LiveModel {
  agents: Agent[]
  events: ActivityEvent[]
  policies: Policy[]
  services: Service[]
  nodes: Record<string, EnsNode>
  /** Plain-language problems the user should know about. */
  warnings: string[]
}

interface AssetInfo {
  id: string
  symbol: string
  decimals: number
}

const RESOURCES: ResourceKind[] = ['compute', 'storage', 'database', 'inference', 'networking', 'secrets']

const TREE_ASSET: AssetInfo = {
  id: config.assetTokenId,
  symbol: config.assetSymbol,
  decimals: config.assetDecimals,
}

function assetFor(id: string, manifest?: ServiceManifest): AssetInfo {
  if (id === TREE_ASSET.id) return TREE_ASSET
  if (manifest && manifest.asset.id === id) return manifest.asset
  if (id === '0.0.0') return { id, symbol: 'HBAR', decimals: 8 }
  return { id, symbol: id, decimals: 0 }
}

const units = (atomic: bigint | number, decimals = TREE_ASSET.decimals) =>
  Number(atomic) / 10 ** decimals

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

function hederaNetwork(network: string): Network {
  return network.includes('mainnet') ? 'hedera-mainnet' : 'hedera-testnet'
}

/** Receipts from HCS and the gateway describe the same payments; merge them. */
function mergeReceipts(snapshot: LiveSnapshot) {
  const out = new Map<string, { receipt: Receipt; source: 'hcs' | 'gateway'; at: string; sequence?: number }>()
  for (const entry of snapshot.topic) {
    if (entry.kind !== 'receipt') continue
    const key = entry.body.transaction_id || entry.body.quote_id
    out.set(key, {
      receipt: entry.body,
      source: 'hcs',
      at: entry.body.settled_at || entry.consensusAt,
      sequence: entry.sequence,
    })
  }
  for (const receipt of snapshot.gatewayReceipts) {
    const key = receipt.transaction_id || receipt.quote_id
    if (!out.has(key)) out.set(key, { receipt, source: 'gateway', at: receipt.settled_at })
  }
  return [...out.values()]
}

function mergeRefusals(snapshot: LiveSnapshot) {
  const out = new Map<string, { refusal: Refusal; source: 'hcs' | 'gateway'; sequence?: number }>()
  for (const entry of snapshot.topic) {
    if (entry.kind === 'refusal')
      out.set(entry.body.quote_id, { refusal: entry.body, source: 'hcs', sequence: entry.sequence })
  }
  for (const refusal of snapshot.gatewayRefusals) {
    if (!out.has(refusal.quote_id)) out.set(refusal.quote_id, { refusal, source: 'gateway' })
  }
  return [...out.values()]
}

const VIOLATION_LABEL: Record<string, string> = {
  expired: 'Authority expired or revoked',
  over_budget: 'Request exceeds the authority',
  insufficient_authority: 'Request exceeds remaining authority',
  over_per_call_limit: 'Request exceeds the per-request limit',
  service_not_permitted: 'Service not permitted by policy',
  asset_not_permitted: 'Asset not permitted by policy',
  unresolvable: 'Agent is not registered in the tree',
}

export function adapt(snapshot: LiveSnapshot): LiveModel {
  const warnings: string[] = []
  const manifest = snapshot.manifest
  const nodes = snapshot.ens?.nodes ?? []
  const nodeByName: Record<string, EnsNode> = Object.fromEntries(nodes.map((n) => [n.name, n]))

  if (manifest && manifest.asset.id !== TREE_ASSET.id) {
    warnings.push(
      `The gateway settles in ${manifest.asset.symbol}, but budgets are read as ${TREE_ASSET.symbol}. Set PAYMENT_ASSET=usdc on the gateway — ${manifest.asset.symbol} payments are listed but not counted toward spend.`,
    )
  }
  const payer = snapshot.payer
  if (payer && !(payer.token && payer.token > 0)) {
    warnings.push(
      !payer.associated && !payer.autoAssociates
        ? `The shared payer ${payer.id} isn't associated with ${TREE_ASSET.symbol} (${TREE_ASSET.id}). Associate it, then fund it — until then every payment from it fails.`
        : `The shared payer ${payer.id} holds no ${TREE_ASSET.symbol} yet, so every payment from it fails. Send it testnet ${TREE_ASSET.symbol} (${TREE_ASSET.id}) — ${payer.associated ? 'it is already associated' : 'it associates automatically on first receipt'}.`,
    )
  }

  // --- Payments and refusals ------------------------------------------------
  const events: ActivityEvent[] = []
  const ownSpend = new Map<string, number>()

  for (const { receipt, source, at, sequence } of mergeReceipts(snapshot)) {
    const asset = assetFor(receipt.asset, manifest)
    const counted = asset.id === TREE_ASSET.id
    const path = receipt.mandate_path ?? []
    const leaf = path.at(-1)?.name ?? 'Unattributed'
    const amount = units(receipt.amount, asset.decimals)
    if (counted && nodeByName[leaf]) ownSpend.set(leaf, (ownSpend.get(leaf) ?? 0) + amount)

    events.push({
      id: `rcpt_${receipt.transaction_id || receipt.quote_id}`,
      kind: 'payment.approved',
      agentId: leaf,
      amount,
      assetSymbol: counted ? undefined : asset.symbol,
      counted,
      service: receipt.provider,
      timestamp: at,
      txId: receipt.transaction_id,
      explorerUrl: receipt.transaction_id ? hashscanUrl('transaction', receipt.transaction_id) : undefined,
      explorerLabel: 'HashScan',
      network: hederaNetwork(receipt.network),
      mandatePath: path.map((hop) => ({
        name: hop.name,
        budget: units(hop.budget, asset.decimals),
        expiresAt: hop.expires_at,
      })),
      payer: receipt.payer,
      source,
      hcsSequence: sequence,
      category: receipt.service,
    })
  }

  for (const { refusal, source, sequence } of mergeRefusals(snapshot)) {
    const asset = assetFor(refusal.asset, manifest)
    events.push({
      id: `rfsl_${refusal.quote_id}`,
      kind: 'payment.blocked',
      agentId: refusal.agent,
      amount: units(refusal.amount, asset.decimals),
      assetSymbol: asset.id === TREE_ASSET.id ? undefined : asset.symbol,
      counted: false,
      service: refusal.provider,
      reason: VIOLATION_LABEL[refusal.violation] ?? refusal.reason,
      blockedBy: refusal.blocked_by,
      policyLimit: refusal.limit != null ? units(refusal.limit, asset.decimals) : undefined,
      timestamp: refusal.refused_at,
      network: hederaNetwork(refusal.network),
      source,
      hcsSequence: sequence,
      category: refusal.service,
    })
  }

  // --- Tree history -----------------------------------------------------------
  for (const e of snapshot.ens?.events ?? []) {
    const node = nodeByName[e.name]
    const base = {
      timestamp: new Date(e.timestamp ?? Date.now()).toISOString(),
      txId: e.txHash,
      explorerUrl: etherscanUrl('tx', e.txHash),
      explorerLabel: 'Etherscan',
      network: 'ethereum-sepolia' as Network,
      source: 'ens' as const,
    }
    if (e.kind === 'registered') {
      // The root is registered straight on the top registry by its owner.
      events.push({
        ...base,
        id: `ens_${e.txHash}_${e.logIndex}`,
        kind: 'authority.delegated',
        agentId: node?.owner ? shortAddress(node.owner) : 'Account owner',
        targetAgentId: e.name,
        amount: node?.records ? units(node.records.budget) : undefined,
      })
    } else if (e.kind === 'minted' && e.parent) {
      events.push({
        ...base,
        id: `ens_${e.txHash}_${e.logIndex}_created`,
        kind: 'agent.created',
        agentId: e.parent,
        targetAgentId: e.name,
      })
      events.push({
        ...base,
        id: `ens_${e.txHash}_${e.logIndex}_delegated`,
        kind: 'authority.delegated',
        agentId: e.parent,
        targetAgentId: e.name,
        amount: e.budget !== undefined ? units(e.budget) : undefined,
      })
    } else if (e.kind === 'unregistered') {
      events.push({
        ...base,
        id: `ens_${e.txHash}_${e.logIndex}`,
        kind: 'agent.revoked',
        agentId: e.name,
        reason: 'Unregistered on-chain — every descendant is blocked by the same transaction',
      })
    } else if (e.kind === 'renewed') {
      events.push({
        ...base,
        id: `ens_${e.txHash}_${e.logIndex}`,
        kind: 'agent.renewed',
        agentId: e.name,
        reason:
          e.expiry !== undefined
            ? `${e.name}'s authority renewed until ${new Date(Number(e.expiry) * 1000).toLocaleDateString()}`
            : undefined,
      })
    }
  }

  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

  // --- Agents -----------------------------------------------------------------
  const statusOf = (node: EnsNode): AgentStatus => {
    if (node.status === 'revoked') return 'revoked'
    if (node.status === 'expired') return 'expired'
    // A dead ancestor blocks this node even though its own entry is intact.
    for (let p = node.parent; p; p = nodeByName[p]?.parent) {
      const ancestor = nodeByName[p]
      if (ancestor && ancestor.status !== 'active') return 'suspended'
    }
    return 'active'
  }

  const agents: Agent[] = nodes.map((node) => {
    const budget = node.records?.budget ?? node.mintBudget ?? 0n
    const services = node.records?.allowedServices ?? []
    const maxPerCall = units(node.records?.maxPerCall ?? budget)
    return {
      id: node.name,
      name: node.name,
      description: 'Non-transferable ENSv2 subname on Sepolia',
      parentId: node.parent,
      children: nodes.filter((n) => n.parent === node.name).map((n) => n.name),
      authority: units(budget),
      spent: Math.round((ownSpend.get(node.name) ?? 0) * 1e6) / 1e6,
      status: statusOf(node),
      createdAt: new Date(node.createdAt ?? Date.now()).toISOString(),
      expiresAt: node.expiresAt ? new Date(node.expiresAt).toISOString() : undefined,
      onExpiry: 'revoke',
      permissions: RESOURCES.map((resource) => ({
        resource,
        allowed: services.includes(resource),
        limits: services.includes(resource) ? { transaction: maxPerCall } : undefined,
      })),
      policyId: `ens:${node.name}`,
      account: node.owner ?? '',
      mandate: {
        name: node.name,
        label: node.label,
        registry: node.registry,
        subregistry: node.subregistry,
        resolver: node.resolver,
        maxPerCall,
        ratePerMinute: units(node.records?.ratePerMinute ?? 0n),
        allowedServices: services,
        canParent: node.bound && Boolean(node.subregistry) && node.status === 'active',
        createdTx: node.createdTx,
        recordsError: node.recordsError,
      },
    }
  })

  // --- Policies: each agent's text records are its policy ---------------------
  const policies: Policy[] = agents.map((agent) => ({
    id: `ens:${agent.id}`,
    name: agent.name,
    description: 'ENS text records',
    active: agent.status === 'active',
    maxTransaction: agent.mandate!.maxPerCall,
    dailyLimit: 0,
    monthlyLimit: 0,
    services: agent.mandate!.allowedServices.filter((s): s is ResourceKind =>
      RESOURCES.includes(s as ResourceKind),
    ),
    providers: [],
    live: {
      budget: agent.authority,
      maxPerCall: agent.mandate!.maxPerCall,
      ratePerMinute: agent.mandate!.ratePerMinute,
      allowedServices: agent.mandate!.allowedServices,
      resolver: agent.mandate!.resolver,
    },
  }))

  // --- Services: the marketplace agents buy from --------------------------------
  // Providers come from three places, most live first: the gateway behind
  // /api, whatever the agent runner discovered, and announcements on the HCS
  // topic (which is how providers register). One card per provider name.
  type Listing = {
    provider: string
    model: string
    category: string
    description: string
    base_url: string
    network: string
    asset: { symbol: string; decimals: number }
    pricing: { per_1k_input: number; per_1k_output: number; minimum: number }
    pay_to?: string
    facilitator?: string
    connected: boolean
    registeredVia: 'hcs' | 'configured' | 'gateway'
    announcedAt?: string
  }
  const listings = new Map<string, Listing>()
  const announced = new Map<string, string>()
  for (const entry of snapshot.topic) {
    if (entry.kind === 'announce' && !announced.has(entry.body.provider)) {
      announced.set(entry.body.provider, entry.body.announced_at || entry.consensusAt)
    }
  }
  const fromManifest = (
    m: ServiceManifest | NonNullable<ProviderEntry['manifest']>,
    connected: boolean,
    via: Listing['registeredVia'],
  ): Listing => ({
    provider: m.provider,
    model: m.model,
    category: (m.category || 'inference').toLowerCase(),
    description: m.description || '',
    base_url: m.base_url,
    network: m.network,
    asset: m.asset,
    pricing: m.pricing,
    pay_to: m.pay_to,
    facilitator: m.facilitator,
    connected,
    registeredVia: announced.has(m.provider) ? 'hcs' : via,
    announcedAt: announced.get(m.provider),
  })
  if (manifest) listings.set(manifest.provider, fromManifest(manifest, !snapshot.errors.gateway, 'gateway'))
  for (const entry of snapshot.providers ?? []) {
    if (entry.manifest && !listings.has(entry.manifest.provider)) {
      listings.set(entry.manifest.provider, fromManifest(entry.manifest, true, entry.source ?? 'configured'))
    }
  }
  for (const entry of snapshot.topic) {
    if (entry.kind !== 'announce' || listings.has(entry.body.provider)) continue
    const a = entry.body
    const decimals = a.asset === TREE_ASSET.symbol ? TREE_ASSET.decimals : a.asset === 'HBAR' ? 8 : 6
    listings.set(a.provider, {
      provider: a.provider,
      model: a.model,
      category: a.category.toLowerCase(),
      description: '',
      base_url: a.base_url,
      network: a.network,
      asset: { symbol: a.asset, decimals },
      pricing: a.pricing,
      connected: false,
      registeredVia: 'hcs',
      announcedAt: a.announced_at || entry.consensusAt,
    })
  }

  // An agent may buy a category when it and every live ancestor allow it.
  const permits = (name: string, category: string): boolean => {
    for (let node: EnsNode | undefined = nodeByName[name]; node; node = node.parent ? nodeByName[node.parent] : undefined) {
      if (node.status !== 'active' || !(node.records?.allowedServices ?? []).includes(category)) return false
    }
    return true
  }

  const services: Service[] = [...listings.values()]
    .sort((x, y) => x.category.localeCompare(y.category) || x.provider.localeCompare(y.provider))
    .map((l) => {
      const price = (atomic: number) => `${units(atomic, l.asset.decimals)} ${l.asset.symbol}`
      const perJob = l.pricing.per_1k_input === 0 && l.pricing.per_1k_output === 0
      return {
        id: `svc_${l.provider}`,
        name: l.provider,
        category: l.category.charAt(0).toUpperCase() + l.category.slice(1),
        connected: l.connected,
        resource: (['inference', 'compute', 'storage', 'networking'].includes(l.category)
          ? l.category
          : 'inference') as Service['resource'],
        endpoint: l.base_url,
        listing: {
          description: l.description,
          model: l.model,
          kind: l.category,
          pricing: perJob
            ? [`${price(l.pricing.minimum)} per call`]
            : [
                `${price(l.pricing.per_1k_input)} / 1K input tokens`,
                `${price(l.pricing.per_1k_output)} / 1K output tokens`,
                `${price(l.pricing.minimum)} minimum`,
              ],
          asset: l.asset.symbol,
          network: l.network.includes('mainnet') ? 'Hedera mainnet' : 'Hedera testnet',
          registeredVia: l.registeredVia,
          announcedAt: l.announcedAt,
          authorizedAgents: nodes.filter((n) => n.parent && permits(n.name, l.category)).map((n) => n.name),
        },
        details: [
          { label: 'Endpoint', value: l.base_url.replace(/^https?:\/\//, '') },
          ...(l.pay_to ? [{ label: 'Pays to', value: l.pay_to, href: hashscanUrl('account', l.pay_to) }] : []),
          ...(l.facilitator ? [{ label: 'Facilitator', value: l.facilitator.replace(/^https?:\/\//, '') }] : []),
        ],
      }
    })

  return { agents, events, policies, services, nodes: nodeByName, warnings }
}

/** Converts whole units of the tree's asset to the integer a record holds. */
export function toAtomic(amount: number): bigint {
  return BigInt(Math.round(amount * 10 ** TREE_ASSET.decimals))
}

export const treeAsset = TREE_ASSET
