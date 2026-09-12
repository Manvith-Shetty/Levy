/**
 * Everything the dashboard needs to find the live Leash deployment.
 *
 * Every value has a default pointing at the public deployment — the ENSv2
 * tree on Sepolia and the Hedera testnet topic — so the dashboard runs live
 * with no .env at all. Override any of them in .env (see .env.example) to
 * point at a redeploy.
 */

const env: Record<string, unknown> = import.meta.env ?? {}

function read(key: string, fallback: string): string {
  const value = env[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

export type DataMode = 'live' | 'demo'

export const config = {
  /** Which data the dashboard opens with. The topbar toggle switches it. */
  defaultMode: (read('VITE_DEFAULT_MODE', 'live') === 'demo' ? 'demo' : 'live') as DataMode,

  // ENSv2 mandate tree on Sepolia ------------------------------------------
  sepoliaRpcUrl: read('VITE_SEPOLIA_RPC_URL', 'https://ethereum-sepolia-rpc.publicnode.com'),
  /** Registry holding the top of the tree (`root`); deeper levels are found
   *  by following on-chain subregistry pointers, exactly as the gateway does. */
  topRegistry: read('VITE_ENS_TOP_REGISTRY', '0x51d32dfa5baf7e3e1d718fdd37d0c346c5ba7838'),
  registrar: read('VITE_ENS_REGISTRAR', '0x33699c74f777c581db3b9c7079d87b778cae2312'),
  /** First block to scan for tree events — the deploy block. */
  fromBlock: BigInt(read('VITE_ENS_FROM_BLOCK', '11684263')),

  // Hedera --------------------------------------------------------------------
  hederaNetwork: read('VITE_HEDERA_NETWORK', 'testnet') as 'testnet' | 'mainnet',
  mirrorUrl: read('VITE_HEDERA_MIRROR_URL', 'https://testnet.mirrornode.hedera.com'),
  /** HCS topic carrying receipts and refusals. Falls back to whatever the
   *  gateway advertises in its manifest. */
  hcsTopicId: read('VITE_HCS_TOPIC_ID', '0.0.10494264'),
  /** The one Hedera account every demo agent pays from. */
  payerAccount: read('VITE_HEDERA_PAYER_ACCOUNT', '0.0.10499031'),
  /** Asset the tree's budgets are denominated in. Budgets are raw integers
   *  on-chain; this is what gives them a unit. */
  assetSymbol: read('VITE_ASSET_SYMBOL', 'USDC'),
  assetDecimals: Number(read('VITE_ASSET_DECIMALS', '6')),
  assetTokenId: read('VITE_ASSET_TOKEN_ID', '0.0.429274'),

  /** Whether to also read the gateway (manifest, in-memory receipts and
   *  refusals) through /api. Off is fine: HCS already carries both. */
  gatewayEnabled: read('VITE_GATEWAY_ENABLED', 'true') !== 'false',

  pollMs: Number(read('VITE_POLL_MS', '15000')),
}

export const SEPOLIA_CHAIN_ID = 11155111

export function hashscanUrl(kind: 'transaction' | 'topic' | 'account' | 'token', id: string): string {
  // HashScan takes transaction ids as `0.0.x-seconds-nanos`.
  const normalized = kind === 'transaction' ? id.replace('@', '-').replace(/\.(\d+)$/, '-$1') : id
  return `https://hashscan.io/${config.hederaNetwork}/${kind}/${normalized}`
}

export function etherscanUrl(kind: 'tx' | 'address', id: string): string {
  return `https://sepolia.etherscan.io/${kind}/${id}`
}
