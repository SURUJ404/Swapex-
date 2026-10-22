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
| /explore/tokens, /explore/pools | /explore | Indexer: volume, TVL, price change, sortable/searchable tables (no per-row sparkline — N+1 candle fetches; the chart lives on the detail page) |
| /explore/tokens/:chain/:addr | /explore/tokens/:addr | Indexer: price, pools list, deep links to swap/add |
| /explore/pools/:chain/:addr | /explore/pools/:addr | Indexer: stats (price, TVL, 24h volume), hand-rolled SVG price chart (1D/1W/1M from candles), recent swaps |
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
- W2 App shell (done): top nav (Swap, Explore, Portfolio/Positions, network + wallet), mobile
  bottom bar, search (token/pool/address), footer.
- W3 Swap page: token inputs with balance and max, flip, token select modal with search
  and import warning, route/price details accordion, confirm modal, pending/success states.
- W4 Explore (done): tokens and pools tables (sort, search), detail pages with hand-rolled SVG price charts.
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
- Done: positions UI against SwapexPositionManager: /pool (your positions, from NFT Transfer
  events or the indexer's /positions?owner= when connected),
  /add (pair, fee tier, price range or full range, starting price for a new pool, deposits that follow the
  range, approvals, native ETH, one-transaction pool creation + mint), /pool/<id> (value, collect, add,
  remove with optional receive-ETH, close). Range math is tested and matches the contract to about 1e-10.
- Done: Explore against the local indexer: /explore (tokens + pools tables, sort, search),
  /explore/tokens/<addr>, /explore/pools/<addr> (stats, 1D/1W/1M SVG price chart from indexer
  candles, recent swaps). Honest empty/error/not-connected states everywhere; no fake numbers.
- Done: top-nav search (symbol, pool pair, or 0x address) routing to explore detail pages or
  the filtered list; positions discovery prefers the indexer with ownerOf verification and a
  cursor-gap Transfer scan, full event scan as fallback.
- Done: Playwright browser e2e (`npm run e2e`, 5 specs against a running local stack): connect
  through the wallet modal via the injected provider, swap through the confirm modal, add a
  full-range position, remove an owned position, explore with indexer data (token cells, pool
  cells, pool search narrowing).
- Done (2026-10-22): `/limit` limit orders - ERC-20 pair, limit price, approve-then-place,
  EIP-712 signing, my/open orders with live status, cancel by nonce - and (2026-10-20) the
  viem + wagmi migration (W8).
- Removed: the old V2 add/remove/create/pool forms. /remove and /create redirect to /pool and /add.

## Honest status
- Contracts: compiled and tested here with Foundry (104 tests pass) and exercised end to end on a local anvil node.
- Web app: `npm ci`, `npm test` (190 pass across 19 files: logic + jsdom component tests covering ConfirmSwapModal,
  TokenSelectModal, NetworkGuard, PositionsList, LimitOrderForm, LimitOrdersTable), `npm run lint` (0 errors, pre-existing `<img>` warnings only) and
  `npm run build` all pass on Node 24. Swap, positions, Explore (tokens + pools tables + detail
  pages with charts), and limit orders are verified against a live local stack: anvil + indexer + `next start`, including
  the top-nav search routes (symbol/pair/address, ambiguous and no-match fallbacks, indexer-down banner)
  and position ids from the indexer cross-checked against on-chain `ownerOf`. Browser e2e
  (`npm run e2e`: 6 Playwright specs) runs the wallet path headless against that stack -
  injected-provider connect plus swap/add/remove transactions and limit-order place+cancel on an
  anvil with unlocked dev accounts. A real MetaMask extension (lock state, signing prompts, network-switch UX) is still
  a manual check against the local anvil stack (`dev.sh`).
- Indexer: `npm test` (63 pass), `npm run typecheck`, and the anvil-backed integration suite (9 pass)
  clean on Node 24. Verified live against anvil with
  real Swap events (timestamps spread across an hour to produce multi-point candles).
- Screens whose contracts or indexer do not exist yet ship disabled with a clear message.
