#!/usr/bin/env bash
# Keeper: fills open limit orders from the indexer's GET /orders list.
#
# env:
#   RPC          chain endpoint          (default http://127.0.0.1:8545)
#   INDEXER_URL  indexer HTTP API        (default http://127.0.0.1:4000)
#   KEY          filler private key      (default anvil dev key #1 - public test key)
#   WATCH        seconds between passes  (default: run one pass and exit)
#   LIMIT_ORDERS override for the contract address
#
# Needs foundry (cast), python3 (or py) and a running indexer. Anvil's public
# development keys are used by default and must never be used on a real network.
set -euo pipefail
RPC=${RPC:-http://127.0.0.1:8545}
INDEXER_URL=${INDEXER_URL:-http://127.0.0.1:4000}
KEY=${KEY:-0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d} # anvil account #1
cd "$(dirname "$0")/.."

command -v cast >/dev/null 2>&1 || { echo "Missing: cast (foundry not on PATH)" >&2; exit 1; }

# python3 on Linux/macOS; py on Windows (each candidate verified by running it)
PYTHON=""
for cand in python3 py; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "import sys" >/dev/null 2>&1; then
    PYTHON=$cand
    break
  fi
done
[ -n "$PYTHON" ] || { echo "Missing: python3 (or py). Install Python 3." >&2; exit 1; }

j() { "$PYTHON" -c "import json,sys;d=json.load(open('$1'));print($2)"; }
LIMIT=${LIMIT_ORDERS:-$(j deployments/31337.json "d.get('limitOrders','')")}
[ -n "$LIMIT" ] || { echo "deployments/31337.json has no limitOrders address" >&2; exit 1; }

# one pass over the indexer's open orders; a fill failure is reported and the
# next order is still attempted
pass() {
  local LIST ROWS FILLED=0 FAILED=0
  LIST=$(curl -fsS "$INDEXER_URL/orders?status=open&limit=100") || {
    echo "indexer unreachable at $INDEXER_URL" >&2
    return 1
  }
  ROWS=$(printf '%s' "$LIST" | "$PYTHON" -c '
import json, sys
d = json.load(sys.stdin)
keys = ("orderHash", "maker", "tokenIn", "tokenOut", "amountIn", "minAmountOut",
        "expiry", "nonce", "receiver", "fee")
for o in d.get("orders", []):
    if o.get("status") != "open":
        continue
    remaining = int(o.get("remaining", "0"))
    if remaining <= 0:
        continue
    print("|".join(str(o[k]) for k in keys) + "|" + str(remaining) + "|" + o["signature"])
') || { echo "could not parse indexer response" >&2; return 1; }

  while IFS='|' read -r HASH MAKER TIN TOUT AMOUNT MINOUT EXPIRY NONCE RECEIVER FEE REMAINING SIG; do
    [ -n "$HASH" ] || continue
    local DEADLINE OUT
    DEADLINE=$(( $(date +%s) + 3600 ))
    # FillParams.minAmountOut = 0: the contract itself enforces the maker's signed
    # floor (order.minAmountOut) across all fills, which is what e2e-local.sh proves.
    if OUT=$(cast send "$LIMIT" \
      "fill(((address,address,address,uint256,uint256,uint256,uint256,address),uint256,uint256,uint24,uint256,bytes))" \
      "(($MAKER,$TIN,$TOUT,$AMOUNT,$MINOUT,$EXPIRY,$NONCE,$RECEIVER),$REMAINING,0,$FEE,$DEADLINE,$SIG)" \
      --private-key "$KEY" --rpc-url "$RPC" 2>&1); then
      FILLED=$((FILLED + 1))
      echo "filled $HASH (remaining $REMAINING)"
    else
      FAILED=$((FAILED + 1))
      echo "FAILED $HASH: $OUT" >&2
    fi
  done <<< "$ROWS"

  echo "pass: $FILLED filled, $FAILED failed"
  [ "$FAILED" -eq 0 ]
}

if [ -n "${WATCH:-}" ]; then
  while :; do
    pass || echo "pass had failures; retrying in ${WATCH}s" >&2
    sleep "$WATCH"
  done
else
  pass
fi
