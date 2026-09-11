# Deploying the Leash mandate tree (ENSv2 Sepolia)

Needs: `SEPOLIA_RPC_URL` + funded `DEPLOYER_KEY` in env (testnet key only —
never commit; see repo `.env.example`).

## 1. Build + unit test (no secrets needed)

```sh
cd contracts
forge build
forge test            # 8 tests: happy path, bitmap, 5 fail-closed reverts, boundary
```

## 2. Deploy + seed (one broadcast)

```sh
forge script script/DeployMandate.s.sol \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$DEPLOYER_KEY" --broadcast
```

This deploys, in order: 3 UserRegistry proxies (L1/L2/L3) + 3 per-name
resolver proxies via the Verifiable Factory → `MandateRegistrar` → grants it
`ROLE_REGISTRAR|ROLE_RENEW` on all three roots → mints `root` directly →
wires `setSubregistry` + `setParent` → binds parents + mints `agent`, `sub`
through the registrar (subset checks live) → seeds the 4 text records per
name → delegates `ratePerMinute` on the leaf to ops via `authorizeTextRoles`.

Copy the logged `L1/L2/L3/registrar` addresses into `.env` (`LEASH_*`).

## 3. Verify on-chain (no key needed, any Sepolia RPC)

- `cast call $L1 'getExpiry(uint256)(uint64)' $(cast keccak root)` → root expiry
- `cast call $L3 'getResolver(string)(address)' sub` → leaf resolver
- `cast call $RESOLVER 'text(bytes32,string)(string)' $SUB_NODE budget` → `10000`
  (`$SUB_NODE` = namehash of `sub.agent.root`; compute with `cast keccak` stepwise
  or read it from the deploy broadcast log)
- Explorer: `https://sepolia.etherscan.io/address/<each>` + app.ens.dev
  (note: tree is standalone under its own registries, not mounted on `.eth` —
  resolution goes through our reader + direct resolver reads; mounting is future work)

## 4. Prove the guard reads it live

```sh
LEASH_RPC_URL=... LEASH_TOP_REGISTRY=$LEASH_L1_REGISTRY LEASH_LEAF=sub.agent.root \
  cargo test -p mandate --test live_sepolia -- --ignored --nocapture
```

Then run the gateway with `MANDATE_MODE=ens`,
`MANDATE_REGISTRY_ADDRESS=$LEASH_L1_REGISTRY` (top — reader walks down) and hit `/v1/infer` — plus the
revoke demo: `cast send $L1 'unregister(uint256)' <root-labelhash>` (or let
root lapse) and watch the next call block with the root named as blocker.

## 5. Demo order (matches team plan)

Real paid request first (Manvith's Hedera path), then revoke-root → whole
tree dark in one transaction, replayed from HCS. Record ≤5 min.
