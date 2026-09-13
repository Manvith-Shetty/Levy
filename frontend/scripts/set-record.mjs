// Sets one policy record (an ENS text record) on a live agent, signed by the
// account that owns the tree's resolvers (the deployer).
//
//   DEPLOYER_KEY=0x... node scripts/set-record.mjs <agent> <key> <value>
//   node scripts/set-record.mjs <agent> <key> <value> --dry-run   # no key: simulate as the deployer
//
//   # let root and agent.root buy compute (sub.agent.root stays inference-only)
//   DEPLOYER_KEY=0x... node scripts/set-record.mjs root allowedServices inference,compute
//   DEPLOYER_KEY=0x... node scripts/set-record.mjs agent.root allowedServices inference,compute
//
// Finds the agent's resolver by walking the registries from the top one,
// simulates the write first, then sends it and waits for the receipt.
// SEPOLIA_RPC_URL and ENS_TOP_REGISTRY override the defaults.

import { createPublicClient, createWalletClient, http, namehash, parseAbi, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

const KEYS = ['budget', 'maxPerCall', 'ratePerMinute', 'allowedServices', 'allowedAssets']

const DEPLOYER = '0x06de353ddb9c102cda81edc8a535b88dfd1f7c08'
const dryRun = process.argv.includes('--dry-run')
const [name, key, value] = process.argv.slice(2).filter((a) => a !== '--dry-run')
if (!name || !key || value === undefined) {
  console.error('usage: DEPLOYER_KEY=0x... node scripts/set-record.mjs <agent> <key> <value>')
  process.exit(1)
}
if (!KEYS.includes(key)) {
  console.error(`key must be one of: ${KEYS.join(', ')}`)
  process.exit(1)
}
const pk = process.env.DEPLOYER_KEY
if (!pk && !dryRun) {
  console.error('Set DEPLOYER_KEY (the account that owns the tree, 0x06de…7c08). Testnet only.')
  process.exit(1)
}

const rpc = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'
const top = getAddress((process.env.ENS_TOP_REGISTRY || '0x51d32dfa5baf7e3e1d718fdd37d0c346c5ba7838').toLowerCase())
const registryAbi = parseAbi([
  'function getSubregistry(string label) view returns (address)',
  'function getResolver(string label) view returns (address)',
])
const resolverAbi = parseAbi([
  'function setText(bytes32 node, string key, string value)',
  'function text(bytes32 node, string key) view returns (string)',
])

const client = createPublicClient({ chain: sepolia, transport: http(rpc) })
const account = dryRun ? { address: getAddress(DEPLOYER) } : privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`)

// Walk down: the top registry holds the last label; each subregistry the next.
const labels = name.split('.')
let registry = top
for (let i = labels.length - 1; i > 0; i--) {
  registry = await client.readContract({ address: registry, abi: registryAbi, functionName: 'getSubregistry', args: [labels[i]] })
  if (/^0x0+$/.test(registry)) throw new Error(`${labels.slice(i).join('.')} has no subregistry`)
}
const resolver = await client.readContract({ address: registry, abi: registryAbi, functionName: 'getResolver', args: [labels[0]] })
if (/^0x0+$/.test(resolver)) throw new Error(`${name} has no resolver`)

const node = namehash(name)
const before = await client.readContract({ address: resolver, abi: resolverAbi, functionName: 'text', args: [node, key] })
console.log(`${name} ${key}: ${JSON.stringify(before)} → ${JSON.stringify(value)}  (resolver ${resolver}, signer ${account.address})`)

const { request } = await client.simulateContract({
  account: account.address,
  address: resolver,
  abi: resolverAbi,
  functionName: 'setText',
  args: [node, key, value],
})
if (dryRun) {
  console.log('dry run: the deployer can make this change. Run again with DEPLOYER_KEY to send it.')
  process.exit(0)
}
const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpc) })
const hash = await wallet.writeContract({ ...request, account })
console.log(`sent ${hash}, waiting…`)
const receipt = await client.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success') throw new Error(`reverted: ${hash}`)
console.log(`done: https://sepolia.etherscan.io/tx/${hash}`)
