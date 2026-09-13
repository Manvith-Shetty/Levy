#!/usr/bin/env bash
# Starts extra providers next to the main gateway (4021), so the agent has
# quotes to compare and a service its policy doesn't allow: the same gateway
# binary with a different name, model, category and price. They share
# crates/gateway/.env (payee, asset, mandate tree, HCS topic); only the
# variables below are overridden. Each announces itself on the HCS topic.
#
#   scripts/demo-providers.sh          # (re)start B, C (inference), leash-compute (Docker)
#                                      # and leash-ops (repairs on demo/shop)
#   scripts/demo-providers.sh stop     # stop the ones this script started
#
# Logs: /tmp/leash-provider-<x>.log. Only PIDs this script recorded in
# /tmp/leash-provider-<x>.pid are ever stopped.
set -euo pipefail
cd "$(dirname "$0")/../crates/gateway"
bin=../../target/debug/gateway

stop() {
  local name=$1 pidfile="/tmp/$1.pid"
  if [ -f "$pidfile" ]; then
    local pid; pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null && ps -o command= -p "$pid" | grep -q "target/debug/gateway"; then
      kill "$pid" && echo "stopped $name (pid $pid)"
    fi
    rm -f "$pidfile"
  fi
}

# $8 is the Hugging Face models this provider prefers, in order, when HF_TOKEN
# is set in .env ("a,b,auto": the gateway serves the first one the router's
# live catalog lists and that answers, and moves on if it's dropped);
# "stub" blanks HF_TOKEN for that provider, so it always uses the stub.
start() {
  local name=$1 port=$2 category=$3 model=$4 input=$5 output=$6 minimum=$7 hf_model=${8:-}
  local hf=()
  if [ "$hf_model" = "stub" ]; then hf=(HF_TOKEN=); elif [ -n "$hf_model" ]; then hf=(HF_MODEL="$hf_model"); fi
  if [ "$category" = "compute" ]; then hf+=(COMPUTE_BACKEND=docker); fi
  if [ "$category" = "ops" ]; then hf+=(OPS_COMPOSE_FILE=../../demo/shop/docker-compose.yaml); fi
  stop "$name"
  env PROVIDER_NAME=$name PORT=$port BASE_URL=http://localhost:$port MODEL=$model \
    SERVICE_CATEGORY=$category INPUT_PRICE_PER_1K=$input OUTPUT_PRICE_PER_1K=$output MIN_PAYMENT=$minimum \
    ${hf[@]+"${hf[@]}"} nohup "$bin" > "/tmp/$name.log" 2>&1 &
  echo $! > "/tmp/$name.pid"
  echo "$name  $category  http://localhost:$port  pid $!"
}

if [ "${1:-}" = "stop" ]; then
  for p in leash-provider-b leash-provider-c leash-provider-d leash-compute leash-ops; do stop $p; done
  exit 0
fi

[ -x "$bin" ] || cargo build -p gateway

# USDC atomic units (6 decimals) per 1k tokens. Provider A (4021) is 1000 / 4000
# and prefers HF_MODEL from .env (default meta-llama/Llama-3.1-8B-Instruct,auto).
# With HF_TOKEN set, B and C serve real models; without it, all use the stub.
start leash-provider-b 4022 inference echo-mini 600 2500 100 google/gemma-3-27b-it,meta-llama/Llama-3.1-8B-Instruct,auto
start leash-provider-c 4023 inference echo-pro 2000 8000 100 Qwen/Qwen3-235B-A22B-Instruct-2507,google/gemma-3-27b-it,auto
# Compute: real containers on local Docker, $0.0002 a minute, prepaid and torn
# down when the time runs out (COMPUTE_* in .env tunes images and limits).
stop leash-provider-d   # the old stub compute provider, if it's still up
start leash-compute 4024 compute docker 0 0 0 stub
# Ops: brings up demo/shop (web, api, Redis) and sells repairs on it —
# start, restart, unpause, recreate — at $0.0005 each. The runner's
# autopilot watches it and pays to fix it.
start leash-ops 4025 ops compose 0 0 0 stub
