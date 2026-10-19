#!/usr/bin/env bash
# End-to-end check on a local anvil node: deploy, seed, then swap the way the web app does.
# Needs foundry (anvil, forge, cast). Uses anvil's public development key; never use it anywhere else.
set -euo pipefail
RPC=${RPC:-http://127.0.0.1:8545}
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil account #0 (public test key)
ME=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
cd "$(dirname "$0")/.."

if ! cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  # taskkill fallback: on Windows a plain `kill` sometimes leaves the anvil process alive,
  # and a surviving node makes the next run reuse its state (addresses then differ)
  anvil --silent & ANVIL_PID=$!
  trap 'kill $ANVIL_PID 2>/dev/null || MSYS2_ARG_CONV_EXCL="*" taskkill /F /PID $ANVIL_PID >/dev/null 2>&1 || true' EXIT
  for _ in $(seq 1 30); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
fi

# python3 on Linux/macOS; fall back to py (Windows). Each candidate is verified by
# actually running it: the Windows python3 App Execution alias exists but never runs.
PYTHON=""
for cand in python3 py; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "import sys" >/dev/null 2>&1; then
    PYTHON=$cand
    break
  fi
done
[ -n "$PYTHON" ] || { echo "Missing: python3 (or py). Install Python 3." >&2; exit 1; }

forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key $KEY --broadcast >/dev/null
forge script script/SeedTestnet.s.sol --rpc-url "$RPC" --private-key $KEY --broadcast >/dev/null

j() { "$PYTHON" -c "import json,sys;d=json.load(open('$1'));print($2)"; }
ROUTER=$(j deployments/31337.json "d['router']"); QUOTER=$(j deployments/31337.json "d['quoter']")
WETH=$(j deployments/31337.json "d['weth9']"); USDC=$(j deployments/31337.seed.json "d['tokens'][0]['address']")
DEADLINE=$(( $(date +%s) + 3600 ))
# path = tokenIn | fee(3 bytes) | tokenOut, exactly as lib/path.js builds it
PATH_WETH_USDC=0x$(echo "${WETH#0x}$(printf '%06x' 3000)${USDC#0x}" | tr 'A-F' 'a-f')

echo "== quote 0.001 WETH -> tUSDC"
cast call "$QUOTER" "quoteExactInputSingle((address,address,uint24,uint256,uint160))((uint256,uint160,int24,uint256))" \
  "($WETH,$USDC,3000,1000000000000000,0)" --rpc-url "$RPC"

echo "== swap ETH -> tUSDC through the router (native ETH in)"
BEFORE=$(cast call "$USDC" "balanceOf(address)(uint256)" $ME --rpc-url "$RPC" | awk '{print $1}')
cast send "$ROUTER" "exactInput((bytes,address,uint256,uint256,uint256))((uint256))" \
  "($PATH_WETH_USDC,$ME,$DEADLINE,1000000000000000,1)" --value 1000000000000000 --private-key $KEY --rpc-url "$RPC" >/dev/null
AFTER=$(cast call "$USDC" "balanceOf(address)(uint256)" $ME --rpc-url "$RPC" | awk '{print $1}')
echo "tUSDC received (raw, 6 decimals): $((AFTER-BEFORE))"
[ $((AFTER-BEFORE)) -gt 0 ]

echo "== swap tUSDC -> ETH (multicall: swap to router, then unwrap)"
PATH_USDC_WETH=0x$(echo "${USDC#0x}$(printf '%06x' 3000)${WETH#0x}" | tr 'A-F' 'a-f')
cast send "$USDC" "approve(address,uint256)" "$ROUTER" 1000000 --private-key $KEY --rpc-url "$RPC" >/dev/null
SWAP=$(cast calldata "exactInput((bytes,address,uint256,uint256,uint256))" "($PATH_USDC_WETH,0x0000000000000000000000000000000000000002,$DEADLINE,1000000,1)")
UNWRAP=$(cast calldata "unwrapWETH9(uint256,address)" 1 $ME)
ETH_BEFORE=$(cast balance $ME --rpc-url "$RPC")
cast send "$ROUTER" "multicall(bytes[])" "[$SWAP,$UNWRAP]" --private-key $KEY --rpc-url "$RPC" >/dev/null
ETH_AFTER=$(cast balance $ME --rpc-url "$RPC")
echo "ETH balance change (wei, includes gas): $((ETH_AFTER-ETH_BEFORE))"

echo "== limit order round trip: EIP-712 sign -> 60% fill -> remainder fill"
forge script script/E2ELimitOrder.s.sol --rpc-url "$RPC" --broadcast >/dev/null

echo "OK"
