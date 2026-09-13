/**
 * Writes to the mandate tree from the user's own wallet (EIP-1193, e.g.
 * MetaMask) on Sepolia. The dashboard never holds a key.
 *
 * Every write is simulated first, so a missing role or a registrar rule
 * (child budget above the parent's, expiry past the parent's) comes back as
 * a readable reason before the wallet ever asks for a signature.
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  custom,
  encodeFunctionData,
  getAddress,
  namehash,
  UserRejectedRequestError,
  type Address,
  type EIP1193Provider,
  type Hash,
} from 'viem'
import { sepolia } from 'viem/chains'
import { config } from '../config'
import { client, labelhashOf, registrarAbi, registryAbi, resolverAbi } from './ens'

declare global {
  interface Window {
    ethereum?: EIP1193Provider
  }
}

export function hasInjectedWallet(): boolean {
  return typeof window !== 'undefined' && Boolean(window.ethereum)
}

function walletClient() {
  if (!window.ethereum) {
    throw new Error(
      'No browser wallet found. The agent tree lives on Sepolia, so this needs an Ethereum wallet such as MetaMask — not a Hedera account.',
    )
  }
  return createWalletClient({ chain: sepolia, transport: custom(window.ethereum) })
}

async function ensureSepolia(wallet: ReturnType<typeof walletClient>) {
  const chainId = await wallet.getChainId()
  if (chainId === sepolia.id) return
  try {
    await wallet.switchChain({ id: sepolia.id })
  } catch {
    await wallet.addChain({ chain: sepolia })
    await wallet.switchChain({ id: sepolia.id })
  }
}

/** Asks the wallet for an account and moves it to Sepolia. */
export async function connect(): Promise<Address> {
  const wallet = walletClient()
  const [account] = await wallet.requestAddresses()
  await ensureSepolia(wallet)
  return getAddress(account)
}

/** The already-authorized account, without prompting. */
export async function currentAccount(): Promise<Address | undefined> {
  if (!window.ethereum) return undefined
  const [account] = await walletClient().getAddresses()
  return account ? getAddress(account) : undefined
}

const REASONS: Record<string, (args: readonly unknown[]) => string> = {
  BudgetExceedsParent: ([budget, parent]) =>
    `Budget ${budget} exceeds the parent's budget of ${parent} (raw units).`,
  ExpiryExceedsParent: () => "Expiry is later than the parent's — a child can't outlive its parent.",
  ExpiryNotFuture: () => 'Expiry must be in the future.',
  ParentNotBound: () => "The registrar has no binding for this parent, so it can't mint children yet.",
  ParentExpired: () => 'The parent has expired or been revoked.',
  ParentResolverUnset: () => 'The parent has no resolver, so its budget cannot be checked.',
  BadBudgetRecord: () => "The parent's budget record is missing or malformed.",
  NameNotAvailable: () => 'That label is already taken under this parent.',
  InvalidOwner: () => 'Owner address is invalid.',
}

/** Turns a viem error into one sentence a person can act on. */
export function explain(error: unknown, who?: string): string {
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) return 'You rejected the request in your wallet.'
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError)
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName
      if (name && REASONS[name]) return REASONS[name](revert.data?.args ?? [])
      return `The contract refused this transaction. The connected account probably lacks the role for it${
        who ? ` — connect ${who}, which owns this tree` : ''
      }.`
    }
    return error.shortMessage
  }
  return error instanceof Error ? error.message : String(error)
}

async function send(
  request: Parameters<typeof client.simulateContract>[0],
): Promise<Hash> {
  const wallet = walletClient()
  await ensureSepolia(wallet)
  const [account] = await wallet.getAddresses()
  if (!account) throw new Error('Connect a wallet first.')
  const { request: simulated } = await client.simulateContract({ ...request, account } as never)
  const hash = await wallet.writeContract(simulated as never)
  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`Transaction ${hash} reverted.`)
  return hash
}

interface NodeRef {
  label: string
  registry: string
}

/**
 * Revokes a node: one `unregister` on the registry holding its label. No loop
 * over children — every descendant is blocked because the guard walks up
 * through this node and finds it gone.
 */
export function revoke(node: NodeRef): Promise<Hash> {
  return send({
    address: getAddress(node.registry.toLowerCase()),
    abi: registryAbi,
    functionName: 'unregister',
    args: [labelhashOf(node.label)],
  })
}

/** Restores a revoked or lapsed node by renewing it to `expiry` (seconds). */
export function renew(node: NodeRef, expiry: bigint): Promise<Hash> {
  return send({
    address: getAddress(node.registry.toLowerCase()),
    abi: registryAbi,
    functionName: 'renew',
    args: [labelhashOf(node.label), expiry],
  })
}

export interface ChildSpec {
  parent: { name: string; label: string; registry: string; subregistry: string; resolver: string }
  label: string
  budget: bigint
  maxPerCall: bigint
  ratePerMinute: bigint
  allowedServices: string[]
  /** Unix seconds; must not be later than the parent's expiry. */
  expiry: bigint
}

export type CreateStep = 'mint' | 'records'

/**
 * Mints a child through the MandateRegistrar (which enforces budget ≤ parent
 * and expiry ≤ parent on-chain), then writes its four text records in one
 * resolver multicall. Two signatures, both simulated before the first one.
 */
export async function createChild(spec: ChildSpec, onStep: (step: CreateStep) => void): Promise<Hash[]> {
  const owner = (await currentAccount()) ?? (await connect())
  const resolver = getAddress(spec.parent.resolver.toLowerCase())

  const node = namehash(`${spec.label}.${spec.parent.name}`)
  const setText = (key: string, value: string) =>
    encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [node, key, value] })
  const writeRecords = {
    address: resolver,
    abi: resolverAbi,
    functionName: 'multicall',
    args: [
      [
        setText('budget', spec.budget.toString()),
        setText('maxPerCall', spec.maxPerCall.toString()),
        setText('ratePerMinute', spec.ratePerMinute.toString()),
        setText('allowedServices', spec.allowedServices.join(',')),
      ],
    ],
  } as const

  // Minting is open to anyone, but writing records needs a role on the
  // parent's resolver. Check that first, so a wallet without it fails before
  // it mints a name with no budget.
  await client.simulateContract({ ...writeRecords, account: owner } as never)

  onStep('mint')
  const minted = await send({
    address: getAddress(config.registrar.toLowerCase()),
    abi: registrarAbi,
    functionName: 'registerChild',
    args: [
      getAddress(spec.parent.subregistry.toLowerCase()),
      getAddress(spec.parent.registry.toLowerCase()),
      spec.parent.label,
      spec.label,
      owner,
      resolver,
      spec.budget,
      spec.expiry,
    ],
  })

  onStep('records')
  const records = await send(writeRecords)
  return [minted, records]
}

/** ENS labels this tree accepts: lowercase letters, digits and hyphens. */
export function toLabel(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}
