/** Domain model for the Leash control plane.
 *
 * `spent` on an Agent is that agent's *own* spend. Anything a child spends
 * belongs to the child; roll-ups are derived in selectors.ts so the invariant
 * "a subtree can never spend more than the root granted" stays computable
 * from one source of truth.
 */

export type AgentStatus = 'active' | 'warning' | 'expired' | 'suspended' | 'revoked'

export type ResourceKind =
  | 'compute'
  | 'storage'
  | 'database'
  | 'inference'
  | 'networking'
  | 'secrets'

export interface PermissionLimits {
  transaction?: number
  daily?: number
  monthly?: number
}

export interface Permission {
  resource: ResourceKind
  allowed: boolean
  limits?: PermissionLimits
}

export interface Agent {
  id: string
  name: string
  description: string

  parentId?: string
  children: string[]

  /** Ceiling this agent may spend or delegate, in USD. */
  authority: number
  /** This agent's own settled spend. Children track their own. */
  spent: number

  status: AgentStatus

  createdAt: string
  expiresAt?: string
  /** What happens when `expiresAt` passes. */
  onExpiry: 'revoke' | 'freeze'

  permissions: Permission[]
  policyId?: string

  /** Hedera account the agent settles from. */
  account: string

  /** The on-chain mandate behind a live agent. Absent in demo mode. */
  mandate?: LiveMandate
}

/** What a live agent actually is on ENSv2 Sepolia. Amounts are in whole
 * units of the tree's asset (USDC). */
export interface LiveMandate {
  /** Full ENS name, e.g. `sub.agent.root`. */
  name: string
  label: string
  registry: string
  /** Registry this agent's children are minted into, when wired. */
  subregistry?: string
  resolver?: string
  /** Largest single payment this node itself allows. */
  maxPerCall: number
  /** Read from the `ratePerMinute` record; not enforced by the gateway yet. */
  ratePerMinute: number
  /** Read from the `allowedServices` record; not enforced by the gateway yet. */
  allowedServices: string[]
  /** Whether new children can be minted under this agent right now: the
   * registrar has it bound as a parent and it has a subregistry. */
  canParent: boolean
  createdTx?: string
  /** Why the text records couldn't be read, if they couldn't. */
  recordsError?: string
}

export type ActivityKind =
  | 'payment.approved'
  | 'payment.blocked'
  | 'agent.created'
  | 'authority.delegated'
  | 'agent.revoked'
  | 'agent.renewed'
  | 'policy.changed'
  | 'compute.stopped'

export type Network = 'hedera-testnet' | 'hedera-mainnet' | 'ethereum-sepolia'

export interface ActivityEvent {
  id: string
  kind: ActivityKind
  agentId: string

  amount?: number
  service?: string
  /** Why a payment was blocked, in the interface's voice. */
  reason?: string
  /** The child in a delegation or creation event. */
  targetAgentId?: string
  policyId?: string

  /** Policy ceiling that applied when the request was evaluated. */
  policyLimit?: number
  /** Agent's spend that day, before this request. */
  dailyUsage?: number
  dailyLimit?: number

  timestamp: string
  txId?: string
  network: Network

  /** Explorer page for `txId` — HashScan for payments, Etherscan for tree
   * changes. Demo events leave this unset. */
  explorerUrl?: string
  explorerLabel?: string
  /** Asset the amount is in, when it isn't the dashboard's own. */
  assetSymbol?: string
  /** Whether the amount counts toward spend totals. */
  counted?: boolean
  /** The ancestor chain that authorized a payment, root first. */
  mandatePath?: Array<{ name: string; budget: number; expiresAt: string }>
  /** The ancestor that blocked a refused payment. */
  blockedBy?: string
  /** Hedera account that paid. */
  payer?: string
  /** Where this record was read from. */
  source?: 'hcs' | 'gateway' | 'ens'
  /** Sequence number of the event's own message on the HCS topic. */
  hcsSequence?: number
  /** Service category bought or refused (`inference`, `compute`). */
  category?: string
  /** Compute: the container a payment started, or one that was torn down. */
  resource?: string
}

export interface Policy {
  id: string
  name: string
  description: string
  active: boolean
  maxTransaction: number
  dailyLimit: number
  monthlyLimit: number
  services: ResourceKind[]
  providers: string[]
  /** Set when this "policy" is a live agent's own ENS text records. */
  live?: {
    budget: number
    maxPerCall: number
    ratePerMinute: number
    allowedServices: string[]
    resolver?: string
  }
}

export interface Service {
  id: string
  name: string
  category: string
  connected: boolean
  resource: ResourceKind
  /** Region or endpoint, shown as the service's subtitle. */
  endpoint: string
  /** Extra facts for live services (model, pricing, topic, ...). */
  details?: Array<{ label: string; value: string; href?: string }>
  /** Live marketplace listing, for providers agents can pay. */
  listing?: {
    description: string
    model: string
    /** Lowercase category as policies name it: `inference`, `compute`. */
    kind: string
    pricing: string[]
    asset: string
    network: string
    /** How agents found it: announced on the HCS topic, or configured. */
    registeredVia: 'hcs' | 'configured' | 'gateway'
    announcedAt?: string
    /** Agents whose policy (and every parent's) permits this category. */
    authorizedAgents: string[]
  }
}

export interface NotificationSettings {
  nearingBudget: boolean
  expiration: boolean
  paymentBlocked: boolean
  childCreated: boolean
}

/** The shape the create-agent wizard collects before anything is committed. */
export interface AgentDraft {
  name: string
  description: string
  parentId: string
  authority: number
  resources: ResourceKind[]
  limits: Record<string, number | undefined>
  provider: string
  instanceTypes: string[]
  maxHourlyCost: number
  expires: boolean
  expiresDate: string
  expiresTime: string
  onExpiry: 'revoke' | 'freeze'
  policyId?: string
}

export interface PaymentRequest {
  agentId: string
  amount: number
  service: string
}

export interface PaymentDecision {
  approved: boolean
  reason?: string
  /** The ceiling that was breached, for the blocked-payment readout. */
  limitLabel?: string
  limitValue?: number
  policyId?: string
  event: ActivityEvent
}
