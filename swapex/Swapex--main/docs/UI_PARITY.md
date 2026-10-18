# UI parity plan: Swapex vs the Uniswap interface

Reference studied: github.com/Uniswap/interface (apps/web). It is an Nx monorepo
(Vite, React Router, Tamagui, Redux, GraphQL, its own hosted data and routing APIs).
Swapex stays Next.js. We copy the *experience*, not the code.

## Licensing and branding rules
- apps/web is GPL-3.0-or-later. Reading it for layout and flows is fine. Copying or
  closely translating its code would make Swapex GPL-3.0 too. Decision: write every
  component ourselves. Changing the Swapex license needs the owner's explicit OK.
- Do not use Uniswap's name, logo, unicorn art, icons or token lists, or its wordmark.
  Swapex keeps its own brand and palette.
- Do not call Uniswap's hosted APIs (trading, GraphQL). They are not ours and not
  guaranteed. Our data comes from Swapex contracts and our own indexer.

## Page map (Uniswap route -> Swapex route -> data source)
| Uniswap | Swapex | Needs |
|---|---|---|
| /swap | /swap | Router quote (single and multi-hop), permit signing, slippage bps, price impact |
| /limit | /limit | Signed limit orders contract (crypto prompt item A.3) + order indexer |
| /send | /send | ERC-20 transfer, ENS resolve |
| /explore/tokens, /explore/pools | /explore | Indexer: volume, TVL, price change, sparkline per token and pool |
| /explore/tokens/:chain/:addr | /explore/tokens/:chain/:addr | Indexer: price chart, pools list, transactions |
| /explore/pools/:chain/:addr | /explore/pools/:chain/:addr | Pool state (slot0, liquidity), liquidity chart by tick, fee tier, recent swaps |
| /positions, /positions/:id | /positions | NonfungiblePositionManager-style periphery (not written yet) + position reads |
| /add, /increase, /remove | /positions/new etc. | Range picker (ticks), fee tier select, V3 mint/increase/decrease/collect |
| /portfolio | /portfolio | Balances, positions, activity from wallet + indexer |
| settings, network menu, testnet banner | same | Already exist (SlippageSettings, NetworkGuard, TestnetBanner) |

## Backend each screen depends on (build order)
1. Periphery contracts: SwapRouter, QuoterV2, PositionManager (NFT). Without these the
   swap, add liquidity and positions screens cannot be real.
2. Deployment manifest (deployments/<chainId>.json) read by lib/config.js, so addresses
   are never hardcoded.
3. Indexer (subgraph or a small service) for explore, charts, history. Until it exists
   those screens show an explicit "indexer not connected" state, never fake numbers.
4. V4-style PoolManager and hook view (after V3 periphery).

## Work packages
- W1 Design system: tokens (color, radius, spacing, type), dark/light, Button, Card,
  Input, Modal, Tabs, Skeleton, Toast. Own palette, same density and layout as the reference.
- W2 App shell: top nav (Swap, Explore, Portfolio/Positions, network + wallet), mobile
  bottom bar, search (token/pool/address), footer.
- W3 Swap page: token inputs with balance and max, flip, token select modal with search
  and import warning, route/price details accordion, confirm modal, pending/success states.
- W4 Explore: tokens and pools tables (sort, search, chain filter), detail pages with charts.
- W5 Positions (done): list, range picker with liquidity histogram, create/increase/remove/collect.
- W6 Portfolio and activity.
- W7 Limit and send.
- W8 Migrate to viem + wagmi (replaces ethers v5 and web3-react v6).
- W9 Tests: Vitest for logic, Playwright against a local anvil with deployed contracts.

## Status (updated)
- Done: periphery contracts (router, quoter, position manager, NFT) with 34 Foundry tests, deploy and
  seed scripts, local end-to-end script, ABIs and manifests exported to lib/abi and lib/deployments.
- Done: swap page talks to the router and quoter (best route over fee tiers and via WETH, ETH in and out,
  slippage, deadline, price impact, contract errors decoded).
- Done: positions UI against SwapexPositionManager: /pool (your positions, read from NFT Transfer events),
  /add (pair, fee tier, price range or full range, starting price for a new pool, deposits that follow the
  range, approvals, native ETH, one-transaction pool creation + mint), /pool/<id> (value, collect, add,
  remove with optional receive-ETH, close). Range math is tested and matches the contract to about 1e-10.
- Next: Explore (needs the indexer), limit orders, viem + wagmi migration, a swap confirmation modal.
- Removed: the old V2 add/remove/create/pool forms. /remove and /create redirect to /pool and /add.

## Honest status
- Contracts: compiled and tested here with Foundry (80 tests pass) and exercised end to end on a local anvil node.
- Web app: every file parses (checked with a JS transpiler) and the path-encoding tests pass, but `npm install`
  is blocked in this sandbox, so `npm run build`, `npm test` and a browser run have not happened. Run them first.
- Screens whose contracts or indexer do not exist yet ship disabled with a clear message.
