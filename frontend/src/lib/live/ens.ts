/**
 * Reads the Leash mandate tree straight from ENSv2 on Sepolia.
 *
 * The tree lives across one registry per level, linked by subregistry
 * pointers — the same shape `crates/mandate/src/ens.rs` walks for the
 * gateway. Registries can't be enumerated by view calls, so this reader
 * rebuilds the tree from each registry's event log (starting at the top
 * registry and following `SubregistryUpdated` down), then reads every
 * node's *current* state — expiry, resolver, subregistry, text records —
 * in batched calls, so what the dashboard shows is what the guard sees.
 */

import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  keccak256,
  namehash,
  parseAbi,
  parseAbiItem,
  toBytes,
  toEventSelector,
  type Address,
  type Hash,
  type Log,
} from 'viem'
import { sepolia } from 'viem/chains'
import { config } from '../config'

export const client = createPublicClient({
  chain: sepolia,
  transport: http(config.sepoliaRpcUrl, { batch: true }),
})

export const registryAbi = parseAbi([
  'function getSubregistry(string label) view returns (address)',
  'function getResolver(string label) view returns (address)',
  'function getExpiry(uint256 anyId) view returns (uint64)',
  'function unregister(uint256 anyId)',
  'function renew(uint256 anyId, uint64 newExpiry)',
])

export const resolverAbi = parseAbi([
  'function text(bytes32 node, string key) view returns (string)',
  'function setText(bytes32 node, string key, string value)',
  'function multicall(bytes[] data) returns (bytes[])',
])

export const registrarAbi = parseAbi([
  'function parentNodeFor(address parentRegistry, uint256 parentLabelhash) view returns (bytes32)',
  'function registerChild(address targetRegistry, address parentRegistry, string parentLabel, string label, address nameOwner, address resolver, uint64 budget, uint64 expiry) returns (uint256)',
  'error ParentNotBound()',
  'error ParentExpired()',
  'error ParentResolverUnset()',
  'error BadBudgetRecord()',
  'error BudgetExceedsParent(uint64 budget, uint64 parentBudget)',
  'error ExpiryExceedsParent(uint64 expiry, uint64 parentExpiry)',
  'error ExpiryNotFuture()',
  'error NameNotAvailable()',
  'error InvalidOwner()',
])

// Event signatures recovered from the live registries' logs.
const EV = {
  labelRegistered: parseAbiItem(
    'event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)',
  ),
  labelUnregistered: parseAbiItem('event LabelUnregistered(uint256 indexed tokenId, address indexed sender)'),
  expiryUpdated: parseAbiItem(
    'event ExpiryUpdated(uint256 indexed tokenId, uint64 indexed newExpiry, address indexed sender)',
  ),
  resolverUpdated: parseAbiItem(
    'event ResolverUpdated(uint256 indexed tokenId, address indexed resolver, address indexed sender)',
  ),
  subregistryUpdated: parseAbiItem(
    'event SubregistryUpdated(uint256 indexed tokenId, address indexed subregistry, address indexed sender)',
  ),
  mandateRegistered: parseAbiItem(
    'event MandateRegistered(address indexed targetRegistry, string label, address owner, address resolver, uint64 expiry, uint64 budget, uint256 tokenId)',
  ),
}

export const RECORD_KEYS = ['budget', 'allowedServices', 'ratePerMinute', 'maxPerCall'] as const

export interface MandateRecords {
  budget: bigint
  maxPerCall: bigint
  ratePerMinute: bigint
  allowedServices: string[]
}

export type NodeStatus = 'active' | 'expired' | 'revoked'

export interface TreeEvent {
  kind: 'registered' | 'minted' | 'unregistered' | 'renewed'
  name: string
  parent?: string
  budget?: bigint
  expiry?: bigint
  sender?: Address
  block: bigint
  logIndex: number
  txHash: Hash
  timestamp?: number
}

export interface EnsNode {
  /** Full name, e.g. `sub.agent.root`. */
  name: string
  label: string
  parent?: string
  /** Registry holding this label. */
  registry: Address
  labelhash: bigint
  /** Registry holding this node's children, when wired. */
  subregistry?: Address
  /** Resolver holding this node's text records (last known if revoked). */
  resolver?: Address
  owner?: Address
  expiresAt?: number
  status: NodeStatus
  records?: MandateRecords
  /** Why records couldn't be read, when they couldn't. */
  recordsError?: string
  /** Budget the registrar minted with — the fallback when records are gone. */
  mintBudget?: bigint
  /** Whether the registrar has this node bound as a parent. */
  bound: boolean
  createdAt?: number
  createdTx?: Hash
  revokedAt?: number
}

export interface EnsSnapshot {
  nodes: EnsNode[]
  events: TreeEvent[]
  latestBlock: bigint
}

const lc = (a: string) => a.toLowerCase()
const addr = (a: string) => getAddress(lc(a))

export function labelhashOf(label: string): bigint {
  return BigInt(keccak256(toBytes(label)))
}

/**
 * ENSv2 token ids are the labelhash with its low 32 bits used as a version
 * counter, so a re-registration or unregister bumps the id. Matching on the
 * high bits ties every version of a token back to its label.
 */
const tokenKey = (id: bigint) => (id >> 32n).toString(16)

/** Block timestamps never change; keep them across polls. */
const blockTimes = new Map<bigint, number>()

async function timestampsFor(blocks: bigint[]): Promise<void> {
  const missing = [...new Set(blocks)].filter((b) => !blockTimes.has(b))
  await Promise.all(
    missing.map(async (blockNumber) => {
      const block = await client.getBlock({ blockNumber })
      blockTimes.set(blockNumber, Number(block.timestamp) * 1000)
    }),
  )
}

/**
 * RPCs to read the tree's logs from, in order: the configured one, then
 * public Sepolia endpoints known to serve `eth_getLogs` over wide ranges to
 * browsers. Some nodes answer with no logs at all (publicnode has, for
 * hours at a time), which looks exactly like an empty tree.
 */
const LOG_RPCS = [...new Set([config.sepoliaRpcUrl, 'https://sepolia.gateway.tenderly.co', 'https://ethereum-sepolia-rpc.publicnode.com'])]
const logClients = LOG_RPCS.map((url) => createPublicClient({ chain: sepolia, transport: http(url, { batch: true }) }))
/** The RPC that last returned the tree, tried first next time. */
let logClient = 0

/** Public RPCs cap eth_getLogs ranges; page through in fixed windows. */
async function logsFor(addresses: Address[], toBlock: bigint): Promise<Log[]> {
  const WINDOW = 45_000n
  const out: Log[] = []
  for (let from = config.fromBlock; from <= toBlock; from += WINDOW + 1n) {
    const to = from + WINDOW > toBlock ? toBlock : from + WINDOW
    out.push(...(await logClients[logClient].getLogs({ address: addresses, fromBlock: from, toBlock: to })))
  }
  return out
}

type TreeEventAbi = (typeof EV)[keyof typeof EV]

function decode<T>(log: Log, event: TreeEventAbi): T | null {
  try {
    return decodeEventLog({ abi: [event], data: log.data, topics: log.topics }).args as T
  } catch {
    return null
  }
}

const TOPIC = Object.fromEntries(
  Object.entries(EV).map(([key, event]) => [key, toEventSelector(event)]),
) as Record<keyof typeof EV, Hash>

interface LabelEntry {
  registry: Address
  label: string
  labelhash: bigint
  createdBlock: bigint
  createdLogIndex: number
  createdTx: Hash
  owner: Address
  /** Latest lifecycle transitions, by block order. */
  lastActivation: bigint
  lastUnregister?: bigint
  unregisterTx?: Hash
  resolver?: Address
  subregistry?: Address
}

export async function loadTree(): Promise<EnsSnapshot> {
  // A few blocks behind the head: public RPCs load-balance across nodes, and
  // one that's a block behind can answer a range past its head with no logs.
  const latestBlock = (await client.getBlockNumber()) - 3n
  const top = addr(config.topRegistry)
  const registrar = addr(config.registrar)

  const entries = new Map<string, LabelEntry>() // `${registry}:${tokenKey}`
  const byRegistry = new Map<string, LabelEntry[]>()
  const parentOfRegistry = new Map<string, { registry: Address; tokenKey: string }>()
  const treeEvents: TreeEvent[] = []
  const pendingEvents: Array<{ kind: TreeEvent['kind']; registry: Address; key: string; log: Log; extra?: Partial<TreeEvent> }> = []

  // 1. Walk registries breadth-first, following subregistry pointers.
  const seen = new Set<string>()
  let frontier: Address[] = [top]
  for (let depth = 0; frontier.length > 0 && depth < 8; depth++) {
    frontier.forEach((r) => seen.add(lc(r)))
    let logs = await logsFor(frontier, latestBlock).catch(() => [] as Log[])
    // The top registry always has events; none means an RPC that doesn't
    // serve them, not an empty tree. Try the others, then fail the load so
    // the last tree read stays on screen.
    for (let tried = 1; depth === 0 && logs.length === 0 && tried < logClients.length; tried++) {
      logClient = (logClient + 1) % logClients.length
      logs = await logsFor(frontier, latestBlock).catch(() => [] as Log[])
    }
    if (depth === 0 && logs.length === 0) {
      throw new Error(
        `No Sepolia RPC returned events for the top registry ${config.topRegistry} (tried ${LOG_RPCS.map((u) => new URL(u).host).join(', ')}). The next refresh retries.`,
      )
    }
    const next: Address[] = []

    for (const log of logs) {
      const registry = addr(log.address)
      const topic = log.topics[0]
      const regKey = lc(registry)

      if (topic === TOPIC.labelRegistered) {
        const a = decode<{ tokenId: bigint; labelHash: Hash; label: string; owner: Address }>(log, EV.labelRegistered)
        if (!a) continue
        const key = `${regKey}:${tokenKey(a.tokenId)}`
        const existing = entries.get(key)
        const entry: LabelEntry = existing ?? {
          registry,
          label: a.label,
          labelhash: BigInt(a.labelHash),
          createdBlock: log.blockNumber!,
          createdLogIndex: log.logIndex!,
          createdTx: log.transactionHash!,
          owner: a.owner,
          lastActivation: log.blockNumber!,
        }
        entry.lastActivation = log.blockNumber!
        entry.owner = a.owner
        if (!existing) {
          entries.set(key, entry)
          byRegistry.set(regKey, [...(byRegistry.get(regKey) ?? []), entry])
        }
        pendingEvents.push({ kind: 'registered', registry, key, log })
      } else if (topic === TOPIC.labelUnregistered) {
        const a = decode<{ tokenId: bigint; sender: Address }>(log, EV.labelUnregistered)
        if (!a) continue
        pendingEvents.push({ kind: 'unregistered', registry, key: `${regKey}:${tokenKey(a.tokenId)}`, log, extra: { sender: a.sender } })
      } else if (topic === TOPIC.expiryUpdated) {
        const a = decode<{ tokenId: bigint; newExpiry: bigint; sender: Address }>(log, EV.expiryUpdated)
        if (!a) continue
        pendingEvents.push({ kind: 'renewed', registry, key: `${regKey}:${tokenKey(a.tokenId)}`, log, extra: { expiry: a.newExpiry, sender: a.sender } })
      } else if (topic === TOPIC.resolverUpdated) {
        const a = decode<{ tokenId: bigint; resolver: Address }>(log, EV.resolverUpdated)
        const entry = a && entries.get(`${regKey}:${tokenKey(a.tokenId)}`)
        if (entry && a.resolver !== '0x0000000000000000000000000000000000000000') entry.resolver = a.resolver
      } else if (topic === TOPIC.subregistryUpdated) {
        const a = decode<{ tokenId: bigint; subregistry: Address }>(log, EV.subregistryUpdated)
        if (!a || /^0x0+$/.test(a.subregistry)) continue
        const sub = addr(a.subregistry)
        const entry = entries.get(`${regKey}:${tokenKey(a.tokenId)}`)
        if (entry) entry.subregistry = sub
        parentOfRegistry.set(lc(sub), { registry, tokenKey: tokenKey(a.tokenId) })
        if (!seen.has(lc(sub))) next.push(sub)
      }
    }
    frontier = [...new Set(next.map(lc))].map(addr)
  }

  // 2. Registrar mints: the budget each child was minted with, and its resolver.
  const minted = new Map<string, { budget: bigint; resolver: Address; tx: Hash; block: bigint; logIndex: number }>()
  for (const log of await logsFor([registrar], latestBlock)) {
    if (log.topics[0] !== TOPIC.mandateRegistered) continue
    const a = decode<{ targetRegistry: Address; label: string; resolver: Address; budget: bigint }>(log, EV.mandateRegistered)
    if (!a) continue
    minted.set(`${lc(a.targetRegistry)}:${a.label}`, {
      budget: a.budget,
      resolver: a.resolver,
      tx: log.transactionHash!,
      block: log.blockNumber!,
      logIndex: log.logIndex!,
    })
  }

  // 3. Names: a registry's labels hang under whichever node points at it.
  const nameOf = new Map<LabelEntry, string>()
  const fullName = (entry: LabelEntry, guard = 0): string => {
    const cached = nameOf.get(entry)
    if (cached) return cached
    const parentLink = parentOfRegistry.get(lc(entry.registry))
    const parentEntry = parentLink && entries.get(`${lc(parentLink.registry)}:${parentLink.tokenKey}`)
    const name = parentEntry && guard < 8 ? `${entry.label}.${fullName(parentEntry, guard + 1)}` : entry.label
    nameOf.set(entry, name)
    return name
  }
  const reachable = [...entries.values()].filter(
    (e) => lc(e.registry) === lc(top) || parentOfRegistry.has(lc(e.registry)),
  )

  // Lifecycle ordering: unregister after the latest (re)activation = revoked.
  for (const p of pendingEvents) {
    const entry = entries.get(p.key)
    if (!entry) continue
    if (p.kind === 'unregistered') {
      entry.lastUnregister = p.log.blockNumber!
      entry.unregisterTx = p.log.transactionHash!
    }
    if (p.kind === 'renewed' && p.log.blockNumber! > entry.lastActivation) entry.lastActivation = p.log.blockNumber!
  }

  // 4. Current state, batched.
  const stateCalls = reachable.flatMap((e) => [
    { address: e.registry, abi: registryAbi, functionName: 'getExpiry', args: [e.labelhash] } as const,
    { address: e.registry, abi: registryAbi, functionName: 'getResolver', args: [e.label] } as const,
    { address: e.registry, abi: registryAbi, functionName: 'getSubregistry', args: [e.label] } as const,
    { address: registrar, abi: registrarAbi, functionName: 'parentNodeFor', args: [e.registry, e.labelhash] } as const,
  ])
  const state = await client.multicall({ contracts: stateCalls, allowFailure: true })

  const now = Date.now()
  const nodes: EnsNode[] = reachable.map((entry, i) => {
    const [expiryR, resolverR, subR, boundR] = state.slice(i * 4, i * 4 + 4)
    const name = fullName(entry)
    const expiry = expiryR.status === 'success' ? Number(expiryR.result as bigint) * 1000 : undefined
    const liveResolver = resolverR.status === 'success' ? (resolverR.result as Address) : undefined
    const liveSub = subR.status === 'success' ? (subR.result as Address) : undefined
    const mint = minted.get(`${lc(entry.registry)}:${entry.label}`)
    const isZero = (a?: string) => !a || /^0x0+$/.test(a)
    const resolver = !isZero(liveResolver) ? liveResolver : (entry.resolver ?? mint?.resolver)
    const revoked = entry.lastUnregister !== undefined && entry.lastUnregister >= entry.lastActivation
    const status: NodeStatus =
      revoked && (expiry === undefined || expiry <= now) ? 'revoked' : expiry !== undefined && expiry <= now ? 'expired' : 'active'

    return {
      name,
      label: entry.label,
      parent: name.includes('.') ? name.slice(name.indexOf('.') + 1) : undefined,
      registry: entry.registry,
      labelhash: entry.labelhash,
      subregistry: !isZero(liveSub) ? liveSub : entry.subregistry,
      resolver,
      owner: entry.owner,
      expiresAt: expiry,
      status,
      mintBudget: mint?.budget,
      bound: boundR.status === 'success' && !/^0x0+$/.test(boundR.result as string),
      createdTx: mint?.tx ?? entry.createdTx,
      createdAt: undefined,
      revokedAt: undefined,
    }
  })

  // 5. Text records, from the live (or last known) resolver of each node.
  const recordCalls = nodes.flatMap((n) =>
    RECORD_KEYS.map(
      (key) =>
        ({
          address: n.resolver ?? '0x0000000000000000000000000000000000000000',
          abi: resolverAbi,
          functionName: 'text',
          args: [namehash(n.name), key],
        }) as const,
    ),
  )
  const records = await client.multicall({ contracts: recordCalls, allowFailure: true })
  nodes.forEach((node, i) => {
    if (!node.resolver) {
      node.recordsError = 'No resolver recorded for this name'
      return
    }
    const [budget, services, rate, perCall] = records.slice(i * 4, i * 4 + 4).map((r) =>
      r.status === 'success' ? (r.result as string) : '',
    )
    const int = (v: string) => (/^\d+$/.test(v) ? BigInt(v) : undefined)
    const b = int(budget)
    if (b === undefined) {
      node.recordsError = 'Budget record missing or malformed'
      return
    }
    node.records = {
      budget: b,
      maxPerCall: int(perCall) ?? b,
      ratePerMinute: int(rate) ?? 0n,
      allowedServices: services.split(',').map((s) => s.trim()).filter(Boolean),
    }
  })

  // 6. Timeline: mints, unregisters, renewals — with block timestamps.
  const nameByKey = new Map<string, string>()
  for (const [key, entry] of entries) if (reachable.includes(entry)) nameByKey.set(key, fullName(entry))

  for (const p of pendingEvents) {
    const name = nameByKey.get(p.key)
    if (!name) continue
    const entry = entries.get(p.key)!
    const mint = minted.get(`${lc(entry.registry)}:${entry.label}`)
    if (p.kind === 'registered') {
      // Registrar mints carry the budget; direct registrations (the root) don't.
      treeEvents.push({
        kind: mint ? 'minted' : 'registered',
        name,
        parent: name.includes('.') ? name.slice(name.indexOf('.') + 1) : undefined,
        budget: mint?.budget,
        block: p.log.blockNumber!,
        logIndex: p.log.logIndex!,
        txHash: p.log.transactionHash!,
      })
    } else {
      // The initial expiry set at registration also emits ExpiryUpdated on
      // some paths; only count renewals after the name already existed.
      if (p.kind === 'renewed' && p.log.blockNumber === entry.createdBlock) continue
      treeEvents.push({
        kind: p.kind,
        name,
        expiry: p.extra?.expiry,
        sender: p.extra?.sender,
        block: p.log.blockNumber!,
        logIndex: p.log.logIndex!,
        txHash: p.log.transactionHash!,
      })
    }
  }

  await timestampsFor(treeEvents.map((e) => e.block))
  for (const e of treeEvents) e.timestamp = blockTimes.get(e.block)
  for (const node of nodes) {
    const created = treeEvents.find((e) => e.name === node.name && (e.kind === 'minted' || e.kind === 'registered'))
    node.createdAt = created?.timestamp
    if (node.status === 'revoked') {
      node.revokedAt = [...treeEvents].reverse().find((e) => e.name === node.name && e.kind === 'unregistered')?.timestamp
    }
  }

  treeEvents.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : Number(a.block - b.block)))
  return { nodes, events: treeEvents, latestBlock }
}
