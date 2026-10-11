# SwapEx

SwapEx is an MVP decentralized exchange (DEX) that enables users to create tokens and swap them seamlessly on-chain.

## MVP Features

- Token creation and deployment
- Token-to-token swaps
- Wallet connection
- Basic liquidity management
- Transaction history

## Tech Stack

- Next.js
- React
- Solidity
- Ethers.js
- Web3 Wallet Integration

## Getting Started

    npm install
    npm run dev      # http://localhost:3000
    npm test         # unit tests for the math / error helpers
    npm run lint
    npm run build

Open http://localhost:3000 to access the application.

## Layout

- `lib/` pure logic: amount parsing, slippage (integer basis points), routing, errors, tx history
- `hooks/` balances, allowances, approvals, transaction runner
- `components/` forms (Swap, Add/Remove liquidity, Send, Create) and shared UI
- `context/Web3Context.js` wallet + network state (wrong-network detection and switching)

## Config

- `NEXT_PUBLIC_CHAIN_ID` (default `1`). Contract addresses must match the chain.

## Vision

Our goal is to simplify tokenization and decentralized trading through a fast, secure, and user-friendly platform.

## Roadmap

See the Uniswap-parity plan: own contracts (Foundry), indexer/subgraph, smart order router,
Permit2, multi-chain, audits.
