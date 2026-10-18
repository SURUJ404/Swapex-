# Security policy

## Status
Swapex is **experimental, unaudited software running on testnets only**. Testnet tokens have no
value. Do not use it with funds you cannot afford to lose, and do not deploy it to mainnet.

## Reporting a vulnerability
Please report privately; do not open a public issue.

- Use GitHub's **"Report a vulnerability"** button (Security tab, private advisory), or
- email **security@YOUR-DOMAIN** (replace with a real address before publishing).

Include what you found, how to reproduce it, and the affected files or contracts. We aim to reply
within 3 business days and to fix confirmed issues before disclosing details.

## Scope
In scope: the contracts in `swapex-contracts`, the web app, and their build/deploy configuration
(CI, scripts, headers). Out of scope: third-party wallets, RPC providers, testnet faucets, and
anything that needs a compromised user device.

## Rewards
There is no bounty while the project is testnet-only. Credit in the advisory is offered if you want it.

## Safe harbor
Good-faith research that avoids harming other users, does not disrupt shared testnet services, and
reports privately will not be pursued.

## Secrets
If you find a committed key, token or mnemonic, report it the same way. Treat it as compromised.
