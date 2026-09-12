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
}

export type ActivityKind =
  | 'payment.approved'
  | 'payment.blocked'
  | 'agent.created'
  | 'authority.delegated'
  | 'agent.revoked'
  | 'policy.changed'

export type Network = 'hedera-testnet' | 'hedera-mainnet'

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
}

export interface Service {
  id: string
  name: string
  category: string
  connected: boolean
  resource: ResourceKind
  /** Region or endpoint, shown as the service's subtitle. */
  endpoint: string
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
