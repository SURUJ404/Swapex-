# Swapex — testnet security posture

Swapex is **open source and testnet-only**. Nothing in this repository has been deployed to mainnet,
and nothing should be until the audit checklist at the bottom is closed.

## 1. No real value

* Deployments use public testnets (and a local `anvil` chain id `31337`) whose tokens are worthless.
* The two local tokens (`SWA`/`SWB`/`SWC`) are `MockERC20`/`MockERC20Permit` with an open `mint`.
  **These contracts must never be deployed where they hold real value.**
* `contracts/test/mocks/*` exists only for tests; deployment scripts deploy mocks deliberately.

## 2. Keys and secrets

* **No private key, seed phrase, RPC secret or API token is committed to this repository.**
* Local development uses `anvil`'s well-known default accounts — public knowledge by design, they
  can hold nothing.
* Testnet deployment keys live in a keystore / environment variable **outside** the repo
  (git-ignored `.env.local` holds only *public* addresses and endpoints).
* Anything mainnet-bound must move to a hardware wallet or KMS/HSM with a policy — never a
  plaintext key file, never in CI.

## 3. Admin ownership (two-step + timelock)

* `PoolManager` and `SwapexFactory` use OpenZeppelin `Ownable2Step` with an explicit initial
  owner (D29): a transfer only *names* a pending owner until that owner calls
  `acceptOwnership()`, so a mistyped transfer can never strand either contract, and no input can
  produce a zero-address owner.
* The deployed `PoolManager` is owned by a `TimelockController` with a **2-day delay**. The
  privileged actions — `setProtocolFee`, `collectProtocol`, `enableFeeAmount` — are therefore
  scheduled, delayed and cancellable (`cancel`) before they can execute; direct calls from any
  address other than the timelock itself revert.
* **Local anvil:** the deployer (anvil account #0, a publicly known key) is the timelock's
  proposer, executor and admin — fine only because the chain holds no value.
* **Any shared testnet / pre-mainnet:** the timelock's admin, proposer roles must be a **multisig**
  (e.g. Safe), and the deployer must renounce `DEFAULT_ADMIN_ROLE` on the timelock after setup.
  An EOA-only timelock admin collapses the delay guarantee back to a single key.

## 4. Dependency pinning

`contracts/lib/` is git-ignored, so CI installs every dependency fresh **by explicit tag**:

```
forge install foundry-rs/forge-std --no-git
forge install OpenZeppelin/openzeppelin-contracts@v5.2.0 --no-git
```

Signature/nonce code is **not written by hand** — see [`docs/CRYPTO_DECISIONS.md`](./CRYPTO_DECISIONS.md).

## 5. Contracts that cannot be trusted as deployed

* `PoolManager` exceeds the EIP-170 size limit (24,576 bytes) and is deployed locally with
  `anvil --code-size-limit 131072`. This is a known, documented deviation — CI warns rather than
  fails on `forge build --sizes`. Deploying it to a public network as-is is impossible.
* Optimizer `runs = 800` trades a little runtime gas for size; changing it changes deployed bytecode
  and invalidates recorded init-code hashes.

## 6. Before any mainnet deployment (checklist)

1. Resolve the EIP-170 size violation (split/upgrade path), not the size-gate waiver.
2. Fix or formally justify every Slither/Aderyn finding in `contracts/docs/SECURITY.md`.
3. Close the fee-attribution limitation recorded in `contracts/docs/DECISIONS.md` (D26) with a real
   per-user `PositionManager`, or ship without pooled fee accounting.
4. External audit of `PoolManager` + `Router` + `AllowanceTransfer` + `LimitOrders`.
5. Permanently remove all `Mock*` deployment paths and open `mint`s.
6. Point the timelock at a multisig admin/proposer and renounce the deployer's timelock roles
   (section 3) — verify `PoolManager.owner()` is the timelock before anything else ships.
7. Re-run `forge test` (with the 5000-run signature fuzz), `npm test`, and the Playwright
   typed-data sign tests against the **actual** target chain — replay and wrong-chain signatures must
   fail there too.
8. A secrets scan of the full history, and confirmation that no deployer key is recoverable from the
   repository.

## 7. Incident contact

Security reports go to the repository's issue tracker (this project is a public testnet demo).
Do not include exploit details for systems that hold real funds — there are none yet.
