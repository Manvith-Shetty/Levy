/**
 * The chain the ENSv2 tree lives on, from VITE_ENS_CHAIN_ID. Sepolia and
 * mainnet use viem's definitions; any other id gets one built from the
 * VITE_ENS_* settings (name, RPC, explorer, Multicall3).
 */

import { defineChain, type Chain } from 'viem'
import { mainnet, sepolia } from 'viem/chains'
import { config } from '../config'

function build(): Chain {
  if (config.ensChainId === sepolia.id) return sepolia
  if (config.ensChainId === mainnet.id) return mainnet
  return defineChain({
    id: config.ensChainId,
    name: config.ensChainName,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.sepoliaRpcUrl] } },
    blockExplorers: { default: { name: 'Explorer', url: config.ethExplorerUrl } },
    contracts: { multicall3: { address: config.multicall3 as `0x${string}` } },
  })
}

export const ensChain: Chain = build()
