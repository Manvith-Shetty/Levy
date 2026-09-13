#!/usr/bin/env bash
# Starts two extra providers next to the main gateway (4021), so the agent
# has quotes to compare: the same gateway binary, a different name, model and
# price. They share crates/gateway/.env (payee, asset, mandate tree, HCS topic)
# — only the variables below are overridden.
#
#   scripts/demo-providers.sh          # start B (4022) and C (4023)
#
# Logs go to /tmp/leash-provider-{b,c}.log. Stop them with the PIDs it prints.
set -euo pipefail
cd "$(dirname "$0")/../crates/gateway"
bin=../../target/debug/gateway
[ -x "$bin" ] || cargo build -p gateway

start() {
  local name=$1 port=$2 model=$3 input=$4 output=$5
  PROVIDER_NAME=$name PORT=$port BASE_URL=http://localhost:$port MODEL=$model \
    INPUT_PRICE_PER_1K=$input OUTPUT_PRICE_PER_1K=$output \
    nohup "$bin" > "/tmp/$name.log" 2>&1 &
  echo "$name  http://localhost:$port  pid $!"
}

# USDC atomic units (6 decimals) per 1k tokens. Provider A (4021) is 1000 / 4000.
start leash-provider-b 4022 echo-mini 600 2500
start leash-provider-c 4023 echo-pro 2000 8000
