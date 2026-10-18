#!/usr/bin/env bash
# Local dev stack: anvil, deploy, seed three test tokens and pools, export ABIs, run a swap check, start the web app.
# Wallet setup: add network "Local" (chain id 31337, RPC http://127.0.0.1:8545); import an anvil test account.
set -euo pipefail
cd "$(dirname "$0")"
RPC=${RPC:-http://127.0.0.1:8545}
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil account #0, public test key
cleanup() { [ -n "${ANVIL_PID:-}" ] && kill "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT

if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "Using the node already running at $RPC"
else
  anvil --silent & ANVIL_PID=$!
  for _ in $(seq 1 40); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
fi

cd swapex-contracts
forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key "$KEY" --broadcast >/dev/null
forge script script/SeedTestnet.s.sol --rpc-url "$RPC" --private-key "$KEY" --broadcast >/dev/null
./scripts/export-abis.sh ../Swapex--main >/dev/null
echo "Deployed and seeded. Manifest: swapex-contracts/deployments/31337.json"
cd ../Swapex--main
NEXT_PUBLIC_CHAIN_ID=31337 npm run dev
