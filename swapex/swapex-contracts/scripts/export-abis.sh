#!/usr/bin/env bash
# Regenerate the web app's ABIs and deployment manifests from this repo.
# Usage: scripts/export-abis.sh ../Swapex--main
set -euo pipefail
WEB=${1:?path to the web app}
cd "$(dirname "$0")/.."
mkdir -p "$WEB/lib/abi" "$WEB/lib/deployments"
# python3 on Linux/macOS; fall back to py (Windows). Each candidate is verified by
# actually running it: the Windows python3 App Execution alias exists on PATH but never runs.
PYTHON=""
for cand in python3 py; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "import sys" >/dev/null 2>&1; then
    PYTHON=$cand
    break
  fi
done
[ -n "$PYTHON" ] || { echo "Missing: python3 (or py). Install Python 3." >&2; exit 1; }
for spec in "src/periphery/SwapexRouter.sol:SwapexRouter" "src/periphery/SwapexQuoter.sol:SwapexQuoter" \
            "src/periphery/SwapexPositionManager.sol:SwapexPositionManager" "src/periphery/SwapexLimitOrders.sol:SwapexLimitOrders" \
            "src/v3/SwapexFactory.sol:SwapexFactory" "src/v3/SwapexPool.sol:SwapexPool" \
            "src/testnet/TestToken.sol:TestToken"; do
  forge inspect "$spec" abi --json > "$WEB/lib/abi/${spec##*:}.json"
done
# manifests: merge deployments/<id>.json with deployments/<id>.seed.json when present
"$PYTHON" - "$WEB" <<'PY'
import json, os, sys, glob
web = sys.argv[1]
for path in glob.glob("deployments/*.json"):
    base = os.path.basename(path)
    if base.endswith(".seed.json"):
        continue
    chain = base[:-5]
    data = json.load(open(path))
    seed = f"deployments/{chain}.seed.json"
    data["tokens"] = json.load(open(seed))["tokens"] if os.path.exists(seed) else []
    json.dump(data, open(f"{web}/lib/deployments/{chain}.json", "w"), indent=2)
    print("wrote", f"{web}/lib/deployments/{chain}.json")
PY
