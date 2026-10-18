#!/usr/bin/env bash
# Position flows exactly as the web app builds them: create a pool and mint with native ETH in one multicall,
# then remove half through decrease + collect + unwrap + sweep. Run scripts/e2e-local.sh first (same node).
set -euo pipefail
RPC=${RPC:-http://127.0.0.1:8545}
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil account #0 (public test key)
ME=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
cd "$(dirname "$0")/.."
j() { python3 -c "import json;d=json.load(open('$1'));print($2)"; }
PM=$(j deployments/31337.json "d['positionManager']"); WETH=$(j deployments/31337.json "d['weth9']")
DAI=$(j deployments/31337.seed.json "d['tokens'][1]['address']")
FEE=500   # a pool that does not exist yet

read -r T0 T1 SQRT TL TU <<<"$(python3 - "$WETH" "$DAI" <<'PY'
import math, sys
weth, dai = sys.argv[1], sys.argv[2]
# 1 WETH = 3000 DAI, both 18 decimals; price is token1 per token0
price = 3000 if weth.lower() < dai.lower() else 1/3000
t0, t1 = (weth, dai) if weth.lower() < dai.lower() else (dai, weth)
sqrt = int(math.sqrt(price) * 2**96)
tick = math.floor(math.log(price) / math.log(1.0001))
spacing = 10
print(t0, t1, sqrt, (tick - 6000)//spacing*spacing, (tick + 6000)//spacing*spacing + spacing)
PY
)"
ETH=10000000000000000   # 0.01 ETH
BIG=1000000000000000000000
if [ "${WETH,,}" \< "${DAI,,}" ]; then D0=$ETH; D1=$BIG; else D0=$BIG; D1=$ETH; fi
DEADLINE=$(( $(date +%s) + 3600 ))

echo "== create pool + mint with native ETH (one multicall)"
CREATE=$(cast calldata "createAndInitializePoolIfNecessary(address,address,uint24,uint160)" $T0 $T1 $FEE $SQRT)
MINT=$(cast calldata "mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))" "($T0,$T1,$FEE,$TL,$TU,$D0,$D1,0,0,$ME,$DEADLINE)")
REFUND=$(cast calldata "refundETH()")
BAL_ETH=$(cast balance $ME --rpc-url "$RPC")
cast send "$PM" "multicall(bytes[])" "[$CREATE,$MINT,$REFUND]" --value $ETH --private-key $KEY --rpc-url "$RPC" >/dev/null
ID=$(( $(cast call "$PM" "nextTokenId()(uint256)" --rpc-url "$RPC" | awk '{print $1}') - 1 ))
echo "minted position #$ID owned by $(cast call "$PM" "ownerOf(uint256)(address)" $ID --rpc-url "$RPC")"
LIQ=$(cast call "$PM" "positions(uint256)((address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128))" $ID --rpc-url "$RPC" | tr -d '()' | awk -F', ' '{print $6}' | awk '{print $1}')
echo "liquidity $LIQ"
[ "$LIQ" -gt 0 ]
[ "$(cast balance $PM --rpc-url "$RPC")" = "0" ] && echo "no ETH stranded in the position manager"

echo "== remove 50%: decrease + collect to contract + unwrap + sweep (receive ETH)"
HALF=$(python3 -c "print($LIQ//2)")
OTHER=$DAI
DEC=$(cast calldata "decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))" "($ID,$HALF,0,0,$DEADLINE)")
MAXU=340282366920938463463374607431768211455
COL=$(cast calldata "collect((uint256,address,uint128,uint128))" "($ID,0x0000000000000000000000000000000000000002,$MAXU,$MAXU)")
UNW=$(cast calldata "unwrapWETH9(uint256,address)" 0 $ME)
SWP=$(cast calldata "sweepToken(address,uint256,address)" $OTHER 0 $ME)
DAI_BEFORE=$(cast call $DAI "balanceOf(address)(uint256)" $ME --rpc-url "$RPC" | awk '{print $1}')
ETH_BEFORE=$(cast balance $ME --rpc-url "$RPC")
cast send "$PM" "multicall(bytes[])" "[$DEC,$COL,$UNW,$SWP]" --private-key $KEY --rpc-url "$RPC" >/dev/null
DAI_AFTER=$(cast call $DAI "balanceOf(address)(uint256)" $ME --rpc-url "$RPC" | awk '{print $1}')
ETH_AFTER=$(cast balance $ME --rpc-url "$RPC")
echo "DAI received (wei): $(python3 -c "print($DAI_AFTER-$DAI_BEFORE)")"
echo "ETH change incl. gas (wei): $(python3 -c "print($ETH_AFTER-$ETH_BEFORE)")"
[ "$(python3 -c "print(int($DAI_AFTER>$DAI_BEFORE))")" = "1" ]
echo "== close the rest, then burn the NFT"
REST=$(python3 -c "print($LIQ-$HALF)")
DEC2=$(cast calldata "decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))" "($ID,$REST,0,0,$DEADLINE)")
COL2=$(cast calldata "collect((uint256,address,uint128,uint128))" "($ID,$ME,$MAXU,$MAXU)")
cast send "$PM" "multicall(bytes[])" "[$DEC2,$COL2]" --private-key $KEY --rpc-url "$RPC" >/dev/null
cast send "$PM" "burn(uint256)" $ID --private-key $KEY --rpc-url "$RPC" >/dev/null
echo "burned #$ID"
echo "OK"
