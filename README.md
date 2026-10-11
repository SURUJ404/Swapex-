# Swapex

Monorepo for the Swapex DEX (written from scratch — not a fork of any existing protocol).

## Layout

- `contracts/` — Foundry project: V3-style concentrated-liquidity core (`src/v3`, `src/libraries`),
  Python reference model (`reference/`), tests (`test/`). See `contracts/README.md`.
- `apps/web/` — Next.js frontend. See `apps/web/README.md`.

## Development

Contracts (requires [Foundry](https://getfoundry.sh)):

    cd contracts
    forge install foundry-rs/forge-std --no-git
    forge build && forge test -vv

Web app:

    cd apps/web
    npm ci
    npm run dev
