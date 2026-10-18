#!/usr/bin/env bash
# One-command setup: checks tools, installs dependencies, runs the contract tests, syncs ABIs, runs the web tests.
# Needs: git, node (>= 20), npm, foundry (forge, anvil, cast). Install foundry from https://getfoundry.sh
set -euo pipefail
cd "$(dirname "$0")"
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1. $2" >&2; exit 1; }; }
need git "Install git."
need node "Install Node 20 or newer."
need npm "Install npm."
need forge "Install Foundry: https://getfoundry.sh"
need anvil "Install Foundry: https://getfoundry.sh"
need cast "Install Foundry: https://getfoundry.sh"
need python3 "Install Python 3 (used by the helper scripts)."

echo "== contracts: dependencies and tests"
cd swapex-contracts
[ -d lib/forge-std/src ] || forge install foundry-rs/forge-std
forge test
cd ..

echo "== sync ABIs and deployment manifests into the web app"
(cd swapex-contracts && ./scripts/export-abis.sh ../Swapex--main)

echo "== web app: install and test"
(cd Swapex--main && npm install && npm test)

if [ -f swapex-indexer/package.json ]; then
  echo "== indexer: install and test"
  (cd swapex-indexer && npm install && npm test --if-present)
fi

echo
echo "Setup complete. Start the local stack with ./dev.sh"
