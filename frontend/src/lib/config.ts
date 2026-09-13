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

/** `a,b,c` → `['a', 'b', 'c']`. */
function list(key: string, fallback: string): string[] {
  return read(key, fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** `a=b,c=d` → `{ a: 'b', c: 'd' }`. */
function pairs(key: string, fallback: string): Record<string, string> {
  return Object.fromEntries(
    list(key, fallback)
      .map((entry) => entry.split('='))
      .filter((kv) => kv.length === 2)
      .map(([k, v]) => [k.trim(), v.trim()]),
  )
}

const hederaNetwork = read('VITE_HEDERA_NETWORK', 'testnet') as 'testnet' | 'mainnet'

export type DataMode = 'live' | 'demo'

export const config = {
  /** Which data the dashboard opens with. The topbar toggle switches it. */
  defaultMode: (read('VITE_DEFAULT_MODE', 'live') === 'demo' ? 'demo' : 'live') as DataMode,

  // ENSv2 mandate tree (Sepolia by default) ----------------------------------
  /** Chain the tree lives on, as the wallet and the RPC know it. */
  ensChainId: Number(read('VITE_ENS_CHAIN_ID', '11155111')),
  /** Its name in the interface ("Sepolia"). */
  ensChainName: read('VITE_ENS_CHAIN_NAME', 'Sepolia'),
  /** Block explorer for the tree's transactions and addresses. */
  ethExplorerUrl: read('VITE_ETH_EXPLORER_URL', 'https://sepolia.etherscan.io').replace(/\/$/, ''),
  /** Multicall3 on that chain (same address on most). */
  multicall3: read('VITE_MULTICALL3_ADDRESS', '0xca11bde05977b3631167028862be2a173976ca11'),
  sepoliaRpcUrl: read('VITE_SEPOLIA_RPC_URL', 'https://ethereum-sepolia-rpc.publicnode.com'),
  /** Tried in order when the RPC above returns no tree events (some public
   *  nodes answer eth_getLogs with nothing). */
  rpcFallbacks: list(
    'VITE_SEPOLIA_RPC_FALLBACKS',
    'https://sepolia.gateway.tenderly.co,https://ethereum-sepolia-rpc.publicnode.com',
  ),
  /** Blocks per eth_getLogs call; lower it for RPCs with a smaller range cap. */
  ensLogWindow: BigInt(read('VITE_ENS_LOG_WINDOW', '45000')),
  /** Registry holding the top of the tree (`root`); deeper levels are found
   *  by following on-chain subregistry pointers, exactly as the gateway does. */
  topRegistry: read('VITE_ENS_TOP_REGISTRY', '0x51d32dfa5baf7e3e1d718fdd37d0c346c5ba7838'),
  registrar: read('VITE_ENS_REGISTRAR', '0x33699c74f777c581db3b9c7079d87b778cae2312'),
  /** First block to scan for tree events — the deploy block. */
  fromBlock: BigInt(read('VITE_ENS_FROM_BLOCK', '11684263')),

  // Hedera --------------------------------------------------------------------
  hederaNetwork,
  /** Its name in the interface. */
  hederaNetworkName: read('VITE_HEDERA_NETWORK_NAME', hederaNetwork === 'mainnet' ? 'Hedera Mainnet' : 'Hedera Testnet'),
  /** HashScan (or another Hedera explorer with the same URL shape). */
  hashscanBaseUrl: read('VITE_HASHSCAN_URL', 'https://hashscan.io').replace(/\/$/, ''),
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
  /** Where the gateway is reached: the same-origin `/api` proxy by default. */
  gatewayUrl: read('VITE_GATEWAY_URL', '/api').replace(/\/$/, ''),

  pollMs: Number(read('VITE_POLL_MS', '15000')),

  // Agents and services -------------------------------------------------------
  /** Agent a new run or policy simulation starts with, when it exists. */
  defaultAgent: read('VITE_DEFAULT_AGENT', 'sub.agent.root'),
  /** Service categories an agent can be allowed, in the order they're listed. */
  services: list('VITE_SERVICES', 'inference,compute,ops,data'),
  /** First task suggested per service in "Run a paid request". */
  defaultTasks: {
    inference: read('VITE_DEFAULT_TASK_INFERENCE', "Explain Hedera's hashgraph consensus in three sentences."),
    compute: read('VITE_DEFAULT_TASK_COMPUTE', 'Run a Redis cache for 10 minutes.'),
  } as Record<string, string>,
  /** How often the running-containers list refreshes, in milliseconds. */
  resourcesPollMs: Number(read('VITE_RESOURCES_POLL_MS', '5000')),

  // Autopilot -----------------------------------------------------------------
  /** How often the Autopilot page refreshes, in milliseconds. */
  autopilotPollMs: Number(read('VITE_AUTOPILOT_POLL_MS', '1500')),
  /** Public link to the stack Autopilot keeps alive. Defaults to the origin
   *  of the ops provider's end-to-end check. */
  shopUrl: read('VITE_SHOP_URL', ''),
  /** What each service of the stack is, for people: `name=label,…`. */
  serviceLabels: pairs('VITE_STACK_SERVICE_LABELS', 'cache=Redis cache,api=Python API,web=Web front end'),
  /** Atomic units a diagnosis is expected to cost, for the policy check shown
   *  on the diagnoser's card. */
  diagnosisEstimate: Number(read('VITE_AUTOPILOT_DIAGNOSIS_ESTIMATE', '1000')),

  // Agent runner --------------------------------------------------------------
  /** The agent runner (`cargo run -p agent --bin agent-runner`) makes real
   *  paid requests from the shared wallet on the dashboard's behalf. Like the
   *  gateway it has no CORS, so by default it's reached through a same-origin
   *  `/runner` proxy; set a full URL only for a runner that allows your origin. */
  runnerEnabled: read('VITE_RUNNER_ENABLED', 'true') !== 'false',
  runnerUrl: read('VITE_RUNNER_URL', '/runner'),
  /** Sent as a bearer token when the runner was started with RUNNER_TOKEN.
   *  It ends up in the bundle, so it deters drive-by use — it isn't a secret. */
  runnerToken: read('VITE_RUNNER_TOKEN', ''),
}

export function hashscanUrl(
  kind: 'transaction' | 'topic' | 'account' | 'token',
  id: string,
  network: string = config.hederaNetwork,
): string {
  // HashScan takes transaction ids as `0.0.x-seconds-nanos`.
  const normalized = kind === 'transaction' ? id.replace('@', '-').replace(/\.(\d+)$/, '-$1') : id
  const net = network.includes('mainnet') ? 'mainnet' : 'testnet'
  return `${config.hashscanBaseUrl}/${net}/${kind}/${normalized}`
}

export function etherscanUrl(kind: 'tx' | 'address', id: string): string {
  return `${config.ethExplorerUrl}/${kind}/${id}`
}
