# swapex-indexer

Event indexer and HTTP API for the Swapex contracts: log sync into SQLite (reorg-safe,
idempotent, resumable), derived pool/token stats and candles, Fastify REST API with
zod-validated inputs, a CORS allowlist and rate limiting. Design and task list:
`../prompts/01-next-phase.md` (section 1); decisions: `../docs/DECISIONS.md`.

```bash
cp .env.example .env
npm install
npm test              # unit + API suite (no chain needed)
npm run typecheck
npm run test:integration   # anvil + contracts e2e-local.sh + API vs chain (foundry + Git Bash)
```

Run the API itself against a local chain (see `../dev.sh` for the stack):

```bash
CHAIN_ID=31337 RPC_URL=http://127.0.0.1:8545 npm start
```

| Endpoint | Purpose |
|---|---|
| `GET /health` | chain id + indexing cursor |
| `GET /tokens`, `/tokens/:address` | token metadata + USD price (stable-reference rule, `null` when unknown) |
| `GET /pools`, `/pools/:address` | pool stats: price, liquidity, 24h volume/fees/tx, reserves, TVL |
| `GET /pools/:address/candles?interval=1H\|1D` | OHLCV |
| `GET /pools/:address/swaps` | paginated swap history |
| `GET /positions?owner=0x…` | position NFTs by owner (from Transfer/liquidity events) |
| `POST /orders` | submit a signed limit order: EIP-712 re-verified on submit (EOA, then ERC-1271), pool/expiry/field checks mirrored from the contract, and - with a live RPC - rejects orders already filled or cancelled on chain. Requires `limitOrders` in the deployment manifest (503 otherwise). |
| `GET /orders?status=open\|filled\|cancelled\|expired\|all&maker=0x…` | stored orders with event-derived state; `status=open` is the keeper's work list. Fill/cancel state is computed from `OrderFilled`/`OrderCancelled` events, so it reorgs away with them. |

Limit orders need a filler: `../swapex-contracts/scripts/keeper-limit.sh` polls
`GET /orders?status=open` and sends `SwapexLimitOrders.fill` for each entry
(`RPC`, `INDEXER_URL`, `KEY`, optional `WATCH` seconds; anvil dev key #1 by default).

`NEXT_PUBLIC_INDEXER_URL` in the web app points here; unset means the UI shows
"indexer not connected" instead of data.
