// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {SwapexFactory} from "../src/v3/SwapexFactory.sol";
import {SwapexPositionManager} from "../src/periphery/SwapexPositionManager.sol";
import {TestToken} from "../src/testnet/TestToken.sol";
import {FullMath} from "../src/libraries/FullMath.sol";
import {TickMath} from "../src/libraries/TickMath.sol";

interface IWETH {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
}

/// Testnet-only. Deploys free test tokens and opens a few pools with liquidity so the app has something to trade.
/// Run after Deploy.s.sol (it reads deployments/<chainId>.json):
///
///   forge script script/SeedTestnet.s.sol --rpc-url sepolia --account swapex-testnet-deployer --broadcast
///
/// The deployer needs a little test ETH: the WETH pools are funded with WETH_SEED_WEI of wrapped ether.
contract SeedTestnet is Script {
    using stdJson for string;

    error UnsupportedChain(uint256 chainId);

    uint24 internal constant FEE = 3000;
    int24 internal constant SPACING = 60;
    int24 internal constant HALF_RANGE = 12000; // about x3.3 up and down from the starting price
    uint256 internal constant WETH_SEED_WEI = 0.02 ether;

    struct Tokens {
        TestToken usdc; // 6 decimals
        TestToken dai; // 18
        TestToken wbtc; // 8
    }

    function run() external {
        uint256 id = block.chainid;
        if (!(id == 11155111 || id == 84532 || id == 421614 || id == 31337)) revert UnsupportedChain(id);

        string memory manifest = vm.readFile(string.concat("deployments/", vm.toString(id), ".json"));
        address weth = manifest.readAddress(".weth9");
        SwapexPositionManager pm = SwapexPositionManager(payable(manifest.readAddress(".positionManager")));

        vm.startBroadcast();
        Tokens memory t = Tokens({
            usdc: new TestToken("Test USD Coin", "tUSDC", 6, 10_000),
            dai: new TestToken("Test Dai", "tDAI", 18, 10_000),
            wbtc: new TestToken("Test Wrapped Bitcoin", "tWBTC", 8, 1)
        });
        address me = msg.sender;

        // price examples: 1 WETH = 3000 tUSDC; 1 tDAI = 1 tUSDC; 1 tWBTC = 20 WETH
        t.usdc.mint(me, 1_000_000e6);
        t.dai.mint(me, 1_000_000e18);
        t.wbtc.mint(me, 100e8);
        IWETH(weth).deposit{value: WETH_SEED_WEI * 4}(); // two WETH pools, each may use up to 2x the seed

        _approve(address(t.usdc), address(pm));
        _approve(address(t.dai), address(pm));
        _approve(address(t.wbtc), address(pm));
        _approve(weth, address(pm));

        // price is described as "amountA of tokenA buys amountB of tokenB"
        _seed(pm, weth, address(t.usdc), 1e18, 3000e6, WETH_SEED_WEI, me);
        _seed(pm, address(t.dai), address(t.usdc), 1e18, 1e6, 50_000e18, me);
        _seed(pm, weth, address(t.wbtc), 20e18, 1e8, WETH_SEED_WEI, me);
        vm.stopBroadcast();

        string memory json = string.concat(
            '{"tokens":[',
            _tokenJson(address(t.usdc)), ",",
            _tokenJson(address(t.dai)), ",",
            _tokenJson(address(t.wbtc)),
            '],"fee":', vm.toString(uint256(FEE)), "}"
        );
        vm.writeFile(string.concat("deployments/", vm.toString(id), ".seed.json"), json);
        console2.log("tUSDC", address(t.usdc));
        console2.log("tDAI", address(t.dai));
        console2.log("tWBTC", address(t.wbtc));
    }

    function _approve(address token, address spender) internal {
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, type(uint256).max));
        require(ok, "approve failed");
    }

    function _tokenJson(address token) internal view returns (string memory) {
        TestToken t = TestToken(token);
        return string.concat(
            '{"address":"', vm.toString(token), '","symbol":"', t.symbol(), '","name":"', t.name(),
            '","decimals":', vm.toString(uint256(t.decimals())), "}"
        );
    }

    /// @param amountA / amountB  an exchange rate: amountA of tokenA is worth amountB of tokenB
    /// @param budgetA            how much of tokenA to deposit (the other side follows from the price)
    function _seed(
        SwapexPositionManager pm,
        address tokenA,
        address tokenB,
        uint256 amountA,
        uint256 amountB,
        uint256 budgetA,
        address recipient
    ) internal {
        (address t0, address t1, uint256 a0, uint256 a1, uint256 budget0, uint256 budget1) = tokenA < tokenB
            ? (tokenA, tokenB, amountA, amountB, budgetA, FullMath.mulDiv(budgetA, amountB, amountA))
            : (tokenB, tokenA, amountB, amountA, FullMath.mulDiv(budgetA, amountB, amountA), budgetA);

        // price = token1 per token0 in raw units; sqrtPriceX96 = sqrt(price * 2^192)
        uint160 sqrtP = uint160(_sqrt(FullMath.mulDiv(a1, 1 << 192, a0)));
        pm.createAndInitializePoolIfNecessary(t0, t1, FEE, sqrtP);

        int24 tick = TickMath.getTickAtSqrtRatio(sqrtP);
        int24 center = (tick / SPACING) * SPACING;
        pm.mint(
            SwapexPositionManager.MintParams({
                token0: t0,
                token1: t1,
                fee: FEE,
                tickLower: center - HALF_RANGE,
                tickUpper: center + HALF_RANGE,
                amount0Desired: budget0 * 2,
                amount1Desired: budget1 * 2,
                amount0Min: 0,
                amount1Min: 0,
                recipient: recipient,
                deadline: block.timestamp + 1 hours
            })
        );
    }

    function _sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x;
        uint256 y = (x >> 1) + 1;
        while (y < z) {
            z = y;
            y = (x / y + y) >> 1;
        }
    }
}
