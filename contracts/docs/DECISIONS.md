# Decision log — Swapex V3 core

Append-only record of design decisions and their rationale. Newest last.

## D1 — Reference model is the source of truth
**Decision:** Build `contracts/reference/` (Python) first and treat it as the math oracle.
Solidity must match it operation-for-operation; golden vectors are *generated* from it.
**Rationale:** Concentrated-liquidity math is dense and easy to get subtly wrong. An
independent, exact-integer Python model lets us prove the Solidity rather than eyeball it.
We never edit expected values to make a test pass — if Solidity and Python disagree, one of
them has a bug and we find it.

## D2 — License stays GPL-2.0-or-later
**Decision:** Keep SPDX `GPL-2.0-or-later` on all contracts (ask before changing).
**Rationale:** Matches the intended licensing; changing it is a scope/legal decision, not an
engineering default.

## D3 — `getTickAtSqrtRatio` via log2 + bounded snap
**Decision:** Replace the binary search with a Q96 `log2`-based candidate plus a snap loop
bounded to one correction up/down. Keep the binary search as a test-only oracle
(`_tickAtSqrtRatioBinarySearch`).
**Rationale:** A Python prototype (`proto_log2.py`, since removed) proved over 40k samples
that the log2 candidate is always within 1 of the exact tick (max correction distance 1, 0
mismatches). So the snap loop provably terminates in ≤1 iteration and is bit-identical to
the oracle. Saves ~1–1.5k gas per call (the binary search did ~20 `getSqrtRatioAtTick`
calls; log2 does ~96 cheap muls + ≤2 of them), compounding across tick crossings (pool
scenario −28k gas). Differential fuzz (2 tests × 10k runs) plus round-trip, monotonic, and
golden-vector tests all pass.

## D4 — `unchecked` justification policy
**Decision:** Every `unchecked` block carries a comment explaining why overflow is
impossible or why wrap-around is intended. Default is checked math.
**Rationale:** Checked math silently documents bounds; `unchecked` is only for (a) proven-safe
hot paths and (b) intentional wrapping cumulatives (fee growth, seconds-per-liquidity).

## D5 — TWAP: write observations on every state change, at pre-operation state
**Decision:** `SwapexPool` appends an observation in `swap`, and in `_modifyPosition`
(shared by mint/burn), using the *current* (pre-op) tick and liquidity before mutating any
state.
**Rationale:** The interval since the last observation had constant tick and liquidity (any
change would itself have written an observation). Capturing the pre-op state makes each
inter-observation interval single-valued, so `observe()`'s linear interpolation of
`tickCumulative` is *exact*, not an approximation.

## D6 — `secondsPerLiquidityCumulativeX128` wraps; `tickCumulative` stays checked
**Decision:** The seconds-per-liquidity cumulative accumulates in `unchecked` (wraps like fee
growth). `tickCumulative` stays checked.
**Rationale:** seconds-per-liquidity can grow unboundedly for a low-liquidity pool over long
time; wrapping is the standard, DoS-safe behavior (users take *differences*, which remain
correct across a single wrap). `tickCumulative` is bounded by `|tick| ≤ 887272` and the
`uint32` time range, so checked math is safe and an out-of-range input reverts rather than
corrupting the oracle. The Python model uses unbounded ints and matches bit-for-bit until a
wrap (never reached in tests).

## D7 — Truncation over revert for out-of-window `observe`
**Decision:** If a requested target predates the oldest retained observation, return the
oldest cumulative instead of reverting.
**Rationale:** A ring buffer of finite cardinality cannot serve arbitrarily old windows.
Returning the oldest value (a documented truncation) is more usable than bricking a consumer
whose window slightly exceeds retained history, and it mirrors the Python model. This fix
also removed a real underflow: `target - beforeOrAt.blockTimestamp` (uint32) panicked when
`target` was older than `beforeOrAt`; the `target <= beforeOrAt.blockTimestamp` guard now
returns early. Regression test: `test_oracle_truncationReturnsOldestNotRevert`.

## D8 — `cardinalityNext` grows lazily; default 1
**Decision:** `observationCardinalityNext` starts at 1 and grows only via
`increaseObservationCardinalityNext`. `observationCardinality` (retained count) grows by one
per write, capped at `cardinalityNext`, as the buffer fills.
**Rationale:** Zero extra storage/gas until someone actually wants a TWAP window; keeps the
default swap path cheap. Consumers that need history call `increaseObservationCardinalityNext`
once and pay for it only as observations fill.

## D9 — Fixed `Observation[65535]` storage array (not a mapping)
**Decision:** `observations` is a fixed-size storage array `Observation[65535]`; the library
operates on an `Observation[65535] storage` pointer.
**Rationale:** Storage is sparse in the EVM, so the large fixed length costs nothing until
written. A storage pointer avoids copying the array to memory. `cardinalityNext ≤ 65535`.

## D10 — Slither over Aderyn for static analysis (Aderyn is CI-only here)
**Decision:** Use Slither locally; Aderyn is documented but only runnable in CI (Linux).
**Rationale:** Aderyn ships no Windows binary and its crates.io build fails on an upstream
`svm-rs` duplicate-const error. Slither 0.11.6 runs fine and its 20 findings were triaged in
`docs/SECURITY.md`. The one real issue found (factory `setOwner` missing a zero-address
check) was fixed with a regression test.

## D11 — Foundry `vm.warp` in oracle tests uses absolute timestamps
**Decision:** Oracle behavioural tests warp with absolute values (`vm.warp(10 * (i + 1))`)
rather than `vm.warp(block.timestamp + N)`.
**Rationale:** In this environment the relative form did not accumulate (every call behaved
as an absolute warp to the first computed value), which left `block.timestamp` stuck and
caused `time - secondsAgo` to underflow in `observe`. Absolute warps are unambiguous and
robust regardless of cheatcode behavior.

## D12 — PoolManager reuses the V3 math libraries verbatim
**Decision:** The V4-style singleton re-keys per-pool state under `PoolId` but calls the
Phase 1 libraries (`Tick`, `TickBitmap`, `Position`, `SqrtPriceMath`, `SwapMath`, `FullMath`,
`LiquidityMath`, `SafeCast`) unchanged.
**Rationale:** Those libraries are the reference-checked core of Phase 1 (golden vectors +
differential tests). Re-writing them for the manager would duplicate ~1000 lines of dense
math and risk divergence for zero benefit. Only the *orchestration* (flash-accounting deltas,
singleton storage layout) is new.

## D13 — Transient storage via inline `tstore`/`tload` (solc 0.8.26 has no `transient` keyword)
**Decision:** The per-currency delta and the `unlocked` reentrancy lock live in transient
storage, addressed with inline-assembly `tstore`/`tload` at keccak-derived / fixed slots.
**Rationale:** Flash-accounting deltas are hot (read/written many times per swap) and are
guaranteed zero at the end of every `unlock`, so transient storage avoids repeated cold
SSTOREs and is cleared automatically at tx end. solc 0.8.26 supports the `tstore`/`tload`
opcodes (cancun) but not the high-level `transient` state-variable keyword or `transient`
mappings (those arrived in 0.8.28), so the accessors are hand-written assembly with a salt to
avoid cross-contract slot collisions.

## D14 — Flash-accounting safety: net-zero sweep over touched currencies
**Decision:** `unlock` records every currency whose delta becomes non-zero and, before
releasing the lock, iterates them and reverts `UnsettledDelta` unless each delta is exactly
zero.
**Rationale:** This is the core flash-accounting invariant. Without it, a callback could
`take` tokens and leave the corresponding negative (owed) delta unsettled, effectively
stealing from the pool. Checking only the *sum* is insufficient (a +X on one currency and −X
on another would net to zero while both are wrong), so the sweep is per-currency. The
touched-list is persistent only for the duration of the session and is reset each time; the
deltas themselves are transient. Verified by `test_unsettledDelta_reverts` and the
`check_v4.py` multihop net-to-zero check.

## D15 — `BalanceDelta` / `currencyDelta` use the caller-owes sign convention
**Decision:** A positive delta means the pool owes the caller (the caller may `take`); a
negative delta means the caller owes the pool (the caller must `settle`). The V3-style swap
amounts (positive = caller owes) are negated once when folded into `currencyDelta`.
**Rationale:** This matches the reference model (`v4model.py`), the V4 design doc, and the
golden-vector differential, so the Solidity and Python agree bit-for-bit. Keeping a single
convention end-to-end (rather than switching between "pool-receives" and "caller-owes") avoids
the classic sign bugs in multi-hop settlement; the one place V3's convention appears (the swap
loop's raw amounts) is isolated and negated exactly once with a comment.

## D16 — Native settle uses payable `msg.value`, not a sync/balance-diff
**Decision:** `PoolManager.settle` is `payable`. For an ERC-20 it `transferFrom`s the caller as
before; for the native currency (`address(0)`) it requires `msg.value == amount` owed and treats
the ETH as already received. `take` sends ETH via the currency helper for native.
**Rationale:** The V4-style `sync`/balance-diff pattern (snapshot balance, send ETH, settle the
delta) needs extra state and is easier to get wrong. Requiring an exact `msg.value` is simpler,
cannot be under- or over-paid (mismatch reverts `NativeSettleAmountMismatch`), and keeps a single
settlement code path for both currency kinds. A native pool always sorts `address(0)` as
`currency0`, so the delta/settle/take math is identical to ERC-20 — only the transfer mechanism
branches.

## D17 — Hooks are gated by mined address bits and are untrusted
**Decision:** A hook's permissions are the low bits of its contract address (deployer mines a
CREATE2 salt). The manager calls a hook function only when the matching flag is set, so a hook
implements only what it flags. `initialize` runs `Hooks.validate` to reject non-mined addresses.
**Rationale:** Encoding permissions in the address (rather than an on-chain registry or a flag on
the pool) makes "does this pool have hook X at point Y" a pure address check with no storage
read, and it is the scheme the V4 design doc calls for. The manager treats hooks as untrusted:
value safety never depends on hook honesty — `swap`/`modifyLiquidity` are `onlyUnlocked`, so a
re-entering hook acts inside the same flash-accounting session, and the net-zero sweep guarantees
no delta is left non-zero. Address mining is an off-chain concern; on-chain validation only
rejects obviously-unmined addresses (a stray bit in the reserved low 3 bits).

## D18 — Dynamic fee via a dedicated `getSwapFee` getter (return-delta deferred)
**Decision:** When a hook's address carries the `DYNAMIC_FEE` flag, the manager queries
`IHooks.getSwapFee(key)` and charges that lp fee for the swap instead of `key.fee`. The V4-style
"beforeSwap returns a BalanceDelta that adjusts settlement" (hook donates/takes tokens) is **not**
wired and is a documented follow-up.
**Rationale:** A dedicated getter is simple, testable (the dynamic-fee hook test asserts a higher
fee reduces output), and cannot accidentally entangle hook accounting with the caller's delta.
Return-delta settlement touches the core flash-accounting path and deserves its own
reference-checked increment rather than being bolted on; deferring it keeps Phase 3 correct.

## D19 — Router holds input tokens momentarily (pull → approve → settle)
**Decision:** For an ERC-20 input the user approves the **Router**. Inside the unlock callback the
Router pulls the input from the user, approves the manager, and calls `settle` (which pulls
Router→manager). Native input is sent as `msg.value` and settled from the Router's balance.
**Rationale:** The manager's `settle` pulls from `msg.sender` (the Router), so the Router must
momentarily hold the tokens. This is the standard periphery pattern (Uniswap V2/V3/V4 routers all
do this) and means users approve one trusted Router rather than the core manager. Multi-hop is
chained by reading each hop's intermediate delta after it executes, so intermediate currencies net
to zero and only the first input / last output move.

## D20 — `sync` is intentionally omitted (superseded by D16)
**Decision:** The V4-style `sync(currency)` balance-snapshot is **not** implemented. Native settle
uses the payable-`msg.value` path from D16, which makes the balance-diff mechanism `sync` exists to
serve unnecessary.
**Rationale:** `sync` only adds value as the companion to a balance-diff `settle`. Since D16 chose
`msg.value == amount` (a single, simpler settlement path for both currency kinds), a balance snapshot
would be dead state. The design surface listed `sync`, but D16 is a later, deliberate choice that
supersedes it; adding an unused `sync` would be dead code.

## D21 — Hook return-delta is donation-only (`beforeSwapDelta`)
**Decision:** A hook flagged `BEFORE_SWAP_DELTA` (bit 12) may return a **non-positive** `BalanceDelta`
from `beforeSwapDelta`. The manager burns the hook's ERC-6909 claims to fund it and credits the
donation to the swap caller (who settles less). A positive component reverts `InvalidHookDelta`; an
under-funded donation reverts `InsufficientClaim`.
**Rationale:** The transient delta ledger is keyed by **currency only**, so a hook cannot settle an
independent delta. Folding a hook delta into the caller's settlement is only sound when the hook's
contribution is pre-funded — here via claims (backed 1:1 by `reserves`). Restricting to donations
(negative deltas) means a hook can only put value in, never take it out: a positive delta would mint
unbacked claims and is rejected. Net-zero and solvency are preserved because the hook's claims are
already backed by real tokens; burning them frees those tokens to the pool and the caller's
obligation shrinks by the same amount.

## D22 — ERC-6909 claims are backed 1:1 by `reserves`; claim settle/take reclassify deltas
**Decision:** `claims[c][a]` is `a`'s ownership of tokens the manager already holds (`reserves`).
`mint` (deposit) pulls real tokens (`reserves +=`, `claims +=`); `burn` (redeem) sends them out
(`reserves -=`, `claims -=`). `settleViaClaim` burns the caller's claims to clear a negative delta
and `takeViaClaim` mints claims to clear a positive delta — neither moves tokens, so `reserves` is
unchanged and still covers the reclassified obligation.
**Rationale:** Tying every claim to real tokens in `reserves` keeps the solvency invariant
`reserves[c] >= claims[c] + positiveDeltas[c]` inductively maintainable: `mint`/`burn` move both
sides together; the claim variants shift an obligation between the delta ledger and the claims
ledger by equal amounts. This lets the manager support gas-efficient claim-based settlement without
ever issuing an unbacked IOU.

## D23 — Protocol fee is a carve-out of the lp fee, not an extra charge on the trader
**Decision:** `protocolFee` (in 1e6) is the share of the lp fee routed to the protocol per swap. The
trader pays the same total (the fee is still `input * lpFee / 1e6`); only the split between LP
accrual and protocol accrual changes. The protocol cut accrues per-currency (input token) to
`protocolFees0/1` and is owner-withdrawable via `collectProtocol`.
**Rationale:** Making the protocol fee a carve-out (rather than a surcharge) means enabling it never
changes execution price for traders, so it can be turned on for live pools without surprising users.
It is read once per swap and applied in the existing fee-accrual block, so the swap loop and the
`FG` accounting are untouched apart from subtracting the protocol portion before the LP update.

## D24 — Off-chain quotes come from a revert-based `Quoter`, not a JS math port
**Decision:** A new periphery `Quoter.quoteExactInputSingle(key, sp)` simulates an exact-input swap
inside a throwaway `unlock` session whose callback reverts with the encoded `(amount0, amount1)`.
The outer call catches the revert, decodes the `Quoted(int256,int256)` payload, and returns it.
**Rationale:** The frontend needs an accurate output quote before a user swaps. Porting the
concentrated-liquidity swap loop (tick bitmap traversal + `SwapMath` + 512-bit `FullMath`) to JS is
hundreds of lines of high-risk fixed-point code needing its own golden-vector suite. Because
`PoolManager.unlock` has no try/catch, a callback revert unwinds the entire session — including the
transient flash-accounting deltas (EIP-1153) — so the Quoter commits no state, needs no balance or
allowance, and is safe to `eth_call`. `QuoterTest.test_quoteMatchesActualSwapOutput` asserts the
quote equals the real swap's output token balance delta bit-for-bit.

## D25 — Slippage protection is an `amountOutMin` floor on the Router that reverts, not a bare price limit
**Decision:** `Router.exactInputSingle` now takes `minAmountOut` and reverts with
`InsufficientOutputAmount` inside the callback if the swap's positive (output) delta is below it.
`minAmountOut == 0` disables the check; `exactInput` (multi-hop) is unchanged.
**Rationale:** The natural alternative — tightening `sqrtPriceLimitX96` for slippage — only bounds how
far the price may move; when a swap hits the limit early it returns a *partial fill* (fewer tokens
out, only part of the input spent) rather than reverting, which is poor UX and can strand dust. A
minimum-output floor gives "all-or-nothing": either the trade clears the user's price or the whole
transaction reverts. It is purely additive (a zero floor reproduces prior behavior exactly), so
existing call sites only needed the extra argument.


## D26 - Router tracks per-user position liquidity so Remove is attributable
**Decision:** The Router keeps a `mapping(address => mapping(bytes32 => uint128))` registry of the
liquidity each wallet contributed to a position slot, updated in `modifyLiquidity` (credited on add,
debited on remove, reverting `InsufficientPositionLiquidity` on over-removal). Exposed via
`getPositionLiquidity(user, key, tickLower, tickUpper)`.
**Rationale:** PoolManager keys a position by the *caller* of `modifyLiquidity` (address(this) == the
Router), so every user's liquidity merges into one on-chain slot per (pool, range). Without a
per-user registry a front-end could not know how much liquidity a wallet owns and could not size a
correct removal. Known limitation: trading fees still accrue to the *merged* slot, so the first user
to remove sweeps the whole slot's accrued fees; a full per-user PositionManager (tracking fees per
beneficiary) is future work. For the single-provider local demo this is sufficient.

## D27 — Users grant bounded, expiring allowances to the Router through `AllowanceTransfer`, verified with OpenZeppelin's `SignatureChecker`
**Decision:** New `src/v4/periphery/AllowanceTransfer.sol` (EIP-712 domain "Swapex AllowanceTransfer"
v1) holds per-`(owner, token, spender)` grants as `PermitDetails{uint160 amount, uint48 expiration,
uint48 nonce}` with a 256-bit nonce bitmap. Grants are established two ways — off-chain via
`permit(owner, PermitSingle, sig)` (the `PermitSingle` struct carries `details`, `spender` **and
`sigDeadline`**; see D28) or on-chain with no signature at all via
`setAllowance(...)` — and spent by `transferFrom`, which only the named spender may call.
`Router` now takes the `AllowanceTransfer` as a constructor dependency and settles through
`at.transferFrom(_payer, address(this), …)` instead of reading a raw ERC-20 allowance; it also gains
`exactInputSingleWithPermit`, which submits a signed grant and the swap atomically. Verification is
`SignatureChecker.isValidSignatureNow` — OpenZeppelin picks the EOA path (`ECDSA.tryRecover`, so
high-`s`/`address(0)`/length are rejected for us) or the ERC-1271 path purely from
`signer.code.length`, giving smart-account support with no branch of our own. Grant signing accepts
only the canonical **65-byte** `(r, s, v)` encoding: OZ's `tryRecover(bytes)` rejects 64-byte
EIP-2098, and unpacking `(r, vs)` ourselves would violate the "never implement a primitive by hand"
rule for a format ethers/viem never emit.
**Rationale:** Approving a DEX with an unlimited, never-expiring ERC-20 allowance before swapping is
the standing drain risk (the approval outlives the front end). A bounded, expiring, per-spender,
nonce-counted, chain-and-contract-separated grant removes that, and doing it with pinned OpenZeppelin
primitives keeps us out of hand-rolled signature code. Two quirks are deliberate: because submitting
a grant is permissionless and it can be relayed ahead of the user's swap, `exactInputSingleWithPermit`
skips the permit when `isNonceUsed` already shows the nonce spent (a `try/catch` would behave
identically, so the cheaper pre-check is used) instead of reverting on `NonceAlreadyUsed`; and the
Router rejects a grant whose `spender` is not itself (`InvalidPermitSpender`) rather than letting a
mismatched grant burn a nonce and fail at settlement. Wiring the AllowanceTransfer in before the
Router shifts every subsequent `CREATE` address in `Deploy.s.sol` — the explicit `new
AllowanceTransfer()` was kept over a self-deploying Router so the dependency stays visible and
injectable, and the recorded addresses in the web app and smoke scripts were updated to match.
Full threat model, rejected alternatives and what breaks: `docs/CRYPTO_DECISIONS.md` (A.1, A.2).

## D28 — `sigDeadline` is part of the *signed* `PermitSingle`, not a bare `permit()` argument
**Decision:** `PermitSingle` now carries `uint256 sigDeadline` as a struct field,
`PERMIT_SINGLE_TYPEHASH` covers it, and `permit(owner, permitSingle, signature)` takes three
arguments (`exactInputSingleWithPermit` no longer threads a separate deadline either).
**Rationale:** The A.1 implementation accepted `sigDeadline` as an *unsigned* function parameter
while the EIP-712 digest covered only `{details, spender}`. The submitter therefore controlled the
very bound that was supposed to limit *when the signature could be submitted* — passing
`type(uint256).max` silently voided the signer's deadline, so the documented "replay window bound"
was advisory only. (Replay itself was already blocked by the nonce bitmap and the signed
`expiration` still capped the resulting allowance, but the property the interface promised was not
enforced, violating the deadline rule in `docs/CRYPTO_DECISIONS.md`.) Permit2 signs this field;
so do we now. The struct change shifts CREATE addresses again, so the local deployment and the
recorded web addresses were rotated once more. Tests:
`test_permit_expiredSignatureDeadline_reverts` (past signed deadline → `SignatureExpired`) and
`test_permit_submitterCannotExtendTheSignedDeadline_reverts` (deadline extended by the submitter →
`InvalidSignature`, because the digest changed).


## D29 � Two-step ownership on both core contracts, with the PoolManager owned by an OpenZeppelin `TimelockController`
**Decision:** `PoolManager` and `SwapexFactory` now inherit OpenZeppelin `Ownable2Step` with an
explicit `constructor(address initialOwner)`; the custom `owner`/`onlyOwner`/`NotOwner`,
`setOwner` and `OwnerChanged` code is deleted in favour of OZ's `OwnableUnauthorizedAccount` /
`OwnableInvalidOwner` and `OwnershipTransferred`/`OwnershipTransferStarted`. `Deploy.s.sol`
deploys a `TimelockController(2 days, proposers=[deployer], executors=[deployer], admin=deployer)`
*first* and passes it as the manager's initial owner, so the owner is the timelock from genesis �
never a pending-transfer state. `LimitOrders` is also deployed there now. The remaining privileged
actions are `PoolManager.setProtocolFee`/`collectProtocol` and `SwapexFactory.enableFeeAmount`;
the multisig � not the deployer � is documented as the timelock's final admin/owner for any real
deployment (testnet keeps the anvil deployer for operability; see `docs/TESTNET_SECURITY.md`).
**Rationale:** One-step `setOwner` meant a single signed transaction could move protocol-fee
admin to any address (including one with no key) with no confirmation step, and an EOA owner
made fee changes instantaneous and uncancellable. `Ownable2Step` removes the stranded-owner class
of bug outright (OZ v5 even allows `transferOwnership(address(0))` to *cancel* a pending transfer,
so no input can brick ownership), and the timelock makes every admin change delayed and
cancellable by role � the concrete threat being a compromised admin key able to redirect protocol
fees (or a hostile fee tier) before anyone can react. `new PoolManager(address(timelock))` instead
of constructor-then-`transferOwnership` was required precisely because two-step transfer would
have left the manager pending-owner for the whole delay; passing the owner at construction keeps
the invariant "owner is either correct or the contract does not exist". Deploying the timelock
first shifts every subsequent `CREATE` address (rotation #4). Verification: `forge test` 188/188
(new `test/Admin.t.sol`: two-step accept/zero-cancels-pending, direct admin calls rejected,
early execute reverts, post-delay execute applies, sub-min-delay schedule reverts, cancellation
kills a queued op), plus an on-chain read after `--broadcast`: `pm.owner() == timelock`,
`pendingOwner == 0`, `getMinDelay == 2 days`.


## D30 � Signed deployment manifests (F.2) and explorer source verification (F.3)
**Decision:** `deployments/<chainId>.json` records, for a `Deploy.s.sol` broadcast: every contract's
address(es), the git commit, the compiler settings parsed from `foundry.toml` (solc 0.8.26, runs
800, via_ir, cancun, `bytecode_hash=none`, `cbor_metadata=false`), and three keccak256 hashes per
contract � init code, local artifact deployed code, and the *live on-chain* runtime code.
Tooling lives beside the smoke scripts in `apps/web/scripts/` (the stack's ethers v5 does the
hashing/signing): `build-manifest.mjs` (reads broadcast + artifacts + `eth_getCode` + git),
`sign-manifest.mjs` (EIP-191 over the file's exact bytes -> `<chainId>.json.sig`),
`verify-manifest.mjs` (signature, recorded-commit-is-ancestor, settings-vs-foundry.toml warning,
and `eth_getCode` hash comparison when `--rpc` is given), and `deploy.mjs` � the canonical deploy
flow that broadcasts, refreshes the manifest, and passes `forge script --verify` through to the
explorer on non-local chains (`ETHERSCAN_API_KEY` required; loud skip on 31337, which has no
explorer). CI runs the signature/commit/settings verification in the web job.
**Rationale:** The threat is *undetected divergence* between what the repo claims is deployed and
what a chain actually runs � a stale or doctored address list, a rebuild with drifted compiler
settings, or bytecode that does not match the audited source. A signed manifest turns "trust the
last person who edited constants" into a checkable statement: the signature fails on any byte of
tamper, the codehash check fails on any bytecode mismatch, and the settings record ties the
bytecode back to `foundry.toml`. The on-chain hash is stored alongside the artifact hash because
artifacts cannot verify deployed code directly: `immutableReferences` slots are zero in
`deployedBytecode`, so Router/Quoter/LimitOrders-style contracts would always mismatch. On chainId
31337 the signing key is anvil dev key #0 � public by design; that key proves *integrity and
publication*, never authorship, and is useless on any chain where the key is not public knowledge
(documented in the script headers; a real release signs with a maintained key via `PRIVATE_KEY`).
Source verification (F.3) is deliberately delegated to forge's built-in `--verify` rather than a
hand-rolled explorer client, and cannot be executed against a real explorer from this environment
(no API key, testnet-only scope) � the wrapper's local path is exercised end-to-end instead.
Verification run: build -> sign -> verify against the live rotation-#5 deployment
(all PASS), tampered-manifest verify (FAIL, exit 1), `deploy.mjs` simulate (exit 0),
`deploy.mjs --broadcast` (rotation #5 + manifest refresh), both smokes PASS, `npm test`,
`npm run lint` (0 errors), `npm run build`, Playwright e2e 1 passed.

## D31 - Every Router entry takes a tx deadline and (swaps/liquidity) amount bounds (B.1)

**Context:** B of the A-I hardening list. A survey of every externally-callable entry found that
*no* contract enforced a deadline (the web UI collected one but `lib/config.js` literally
commented "the V4 router has no deadline" - it was cosmetic), the multi-hop `exactInput` had **no**
`minAmountOut` parameter at all, and `modifyLiquidity` had neither bounds nor a deadline. A tx
sitting in the mempool therefore executed whenever it was mined, at whatever price existed then.

**Decision:** `Router.sol` - all four entries (`exactInputSingle`, `exactInputSingleWithPermit`,
`exactInput`, `modifyLiquidity`) take an absolute `uint256 deadline`, checked by
`_enforceDeadline` as the *first* statement of each entry (`block.timestamp > deadline` reverts
`TransactionTooOld(deadline, block.timestamp)`) before any session state is written. `exactInput`
gained `minAmountOut`, enforced in the unlock callback on the final hop's delta (positive side =
final output) via the same `_enforceMinOut` used by the single-pool path (refactored to pick the
positive delta instead of trusting a `zeroForOne` flag - identical semantics, works for both
paths). `modifyLiquidity` gained
`LiquidityBounds{amount0Min, amount1Min, amount0Max, amount1Max}`, sign-aware against the caller's
*net* delta inside the unlock callback: negative (caller pays) sides must be <= Max, positive
(caller receives) sides must be >= Min (`AmountAboveMax`/`AmountBelowMin`, currency index in the
error). Fees accrued to the position are a separate delta and deliberately unbound - they are
already the caller's balance and cannot be moved by a third party. `minAmountOut == 0` remains an
explicit, documented opt-out (matches Uniswap semantics; the Quoter-parity test relies on it); a
deadline of 0 is *not* an opt-out - it is simply always in the past.

**Callers updated (breaking ABI change):** `LimitOrders.fillOrder` passes the order's signed
`deadline` (already validated before the router call, so this is defense in depth);
`Deploy.s.sol` seeds pass unbounded bounds + `block.timestamp + 1 hours`; the web SwapWidget
passes `deadlineFromNow(deadlineMin)` from the slippage settings, AddLiquidity passes the typed
amounts as Maxes, RemoveLiquidity passes `minAfterSlippage(quoted, DEFAULT_SLIPPAGE_BPS)` as Mins;
both smoke scripts use chain time + 20 min. Router ABI regenerated; redeploy required, so this is
**rotation #6** (all five address files + manifest).

**Verification:** +9 tests in `Router.t.sol` (expired-deadline revert on each of the four entries
with exact-arg `TransactionTooOld`, boundary `deadline == now` passes, multi-hop impossible-floor
revert, add-above-Max / remove-below-Min reverts, in-bounds add succeeds, minOut-zero opt-out)
=> `forge test` 197 passed; fuzz x5000 (AllowanceTransfer 31 + LimitOrders 28 - now flowing
through the changed Router); both smokes PASS on rotation #6; e2e 1 passed; lint 0 errors;
build ok; manifest verify PASS (signature/ancestry/settings/codehash).

## D32 - Commit-reveal for large swaps: evaluated and rejected (B.2)

**Context:** B.2 was marked *optional* and required an honest "what it does and does not stop"
document either way.

**Analysis:** on a public mempool, a commit-reveal scheme does not hide the trade from searchers:
the *reveal* transaction carries the same observable parameters a plain swap would, and searchers
see it in the mempool exactly as they would a normal tx. They can sandwich the reveal precisely
because they can see it - the commit phase only delays the moment of visibility, it does not
remove it. The only variants that actually hide intent require a private relay or encrypted
mempool for the reveal, at which point the *relay* (not the commit) provides the protection. A
commit contract also needs either escrowed funds (a new custody surface holding user money between
commit and reveal) or a second grant to a new spender (UX + attack surface), plus bond economics
whose only griefing target is the committer themselves. Against that cost: D31's bounds already
revert any reveal executed at an unacceptable price, and B.3's private-orderflow guidance removes
mempool exposure entirely on the networks where MEV matters.

**Decision:** not built. Recorded here and in `docs/MEV.md` (the honest evaluation B.2 asked for)
and `docs/CRYPTO_DECISIONS.md` (rejected-alternatives row). What stops sandwiching in this repo is
D31 bounds + deadlines now, and private RPC submission on real networks later (B.3 docs).

## D33 - TWAP oracle hardening: creation-stamped bootstrap + TwapGuard read policy (D)

**Context:** D of the A-I list (min window, cardinality, no-spot-read rule, flash-loan push
test). Survey: the V3 pools carry the real oracle (`Observations` ring, D5-D11); V4 core has no
observation ring at all (deliberately hooks-based); `OracleHook` advertised a "TWAP-style feed"
while storing only the latest post-swap spot price.

**Findings:**

1. `Observations.initialize()` stamped the bootstrap observation at `blockTimestamp: 0` (unix
   epoch) instead of pool creation time. On any live chain (timestamp >> 0) a window older than
   a young pool's history did *not* truncate to the bootstrap the way D7 intended - it
   interpolated between the epoch-0 bootstrap and the first real write, treating the
   initialization tick as if it had held since 1970: a silent wrong value, invisible to tests
   that genesis at `vm.warp(0)` (both oracle suites do).
2. The raw `observe*` API cannot tell a caller whether the ring actually covers the requested
   window (D7 truncation returns a value either way). A consumer dividing by the *requested*
   window length has no error signal - the classic silent-truncation oracle hazard.
3. Nothing in-repo consumed spot for value decisions (web quotes are spot-by-design but settle
   through D31 bounds), so the enforceable rule could live entirely in a guarded reader.

**Decision:**

* `Observations.initialize(time)` now stamps `blockTimestamp: time`;
  `SwapexPool.initialize` passes `uint32(block.timestamp)`. The bootstrap *is* the pool's
  creation time; windows older than the pool truncate to zeroed cumulatives (D7 restored for
  real timestamps; golden vectors genesis at `vm.warp(0)` and are unaffected).
* New `src/v3/TwapGuard.sol` - the enforceable no-spot-read + min-window + coverage rule for
  anything that would move money on the oracle. `consult(pool, window)` refuses
  `window < TWAP_MIN_WINDOW` (30 minutes, `OracleWindowTooShort`), refuses windows reaching
  before the oldest retained observation (`OracleWindowNotCovered(requested, covered)` - the
  oldest observation is what defines coverage, so it is checked directly against the ring, not
  inferred), refuses uninitialized pools, and only then returns the time-weighted average tick
  from two `observeSingle` reads. No `slot0` read anywhere on the path.
* `OracleHook` demoted in name and contract: `priceAtPoolId`/`lastPrice` ->
  `lastSwapSqrtPriceAtPoolId`/`lastSwapSqrtPrice`; the header states it is a spot recorder,
  not an oracle, and points at `TwapGuard` for time-weighted reads.
* Cardinality policy unchanged (D8 stands): default 1, lazy permissionless growth. TwapGuard
  turns "not grown far enough" into an explicit revert instead of a wrong number, which is the
  part that actually needed enforcing.

**Verification:** +7 tests in `TwapGuard.t.sol` (min-window floor pinned to 1800, coverage
revert with exact `covered` seconds, held-twap-through-guard, same-block slam-and-return moves
spot while the guarded TWAP moves <= 1 tick, creation-stamped bootstrap + fake-epoch regression
where `observeSingle` must return 0 rather than `6000 * 998300`, uninitialized-pool revert)
=> `forge test` 204 passed; OracleGolden still green; Slither Phase 8: 53 contracts, 82 results
(+4, all inside `TwapGuard.consult`, accepted - `SECURITY.md` Phase 8). No manifest rotation:
none of the changed contracts is deployed by `Deploy.s.sol`.

## D34 - Supply chain: SHA-pinned Actions, committed SBOM, double-build reproducibility (H)

**Context:** H of the A-I list (npm provenance, SBOM, Sigstore, SHA-pinned Actions,
double-build reproducibility). Threat-first: CI is part of the trusted computing base -
everything it runs (actions, toolchains, dependencies) can rewrite what ships.

**Findings:**

1. `.github/workflows/ci.yml` used moving tags (`actions/checkout@v4`, `actions/setup-node@v4`,
   `foundry-rs/foundry-toolchain@v1`): a re-pointed tag - compromise, insider or upstream
   mistake - silently changes what runs on every future build.
2. No SBOM existed: the web app's exact dependency set was only implicit in
   `package-lock.json`, invisible to review as such.
3. No reproducibility gate: nothing proved the build lacks nondeterminism (embedded timestamps,
   absolute-path leakage), which is the foundation of every artifact-hash claim (F.2 manifests).

**Decision:**

* Every `uses:` pinned to a full 40-char commit SHA resolved from the GitHub API against the
  current major-tag targets, tag kept in a trailing comment for humans: `checkout` v4.4.0 =
  `11d5960a326750d5838078e36cf38b85af677262`, `setup-node` v4.4.0 =
  `49933ea5288caeca8642d1e84afbd3f7d6820020`, `foundry-toolchain` v1.9.1 =
  `908c540300062bd5a7e473851cdb4282204cee09`, `upload-artifact` v4.6.2 =
  `ea165f8d65b6e75b540449e92b4886f43607fa02`.
* `apps/web/sbom.cdx.json` committed as the reviewable CycloneDX 1.5 baseline (620 components),
  generated with npm's built-in `npm sbom` - shipped by the pinned Node toolchain, so the
  generator itself is not a new supply-chain actor (`@cyclonedx/cyclonedx-npm` was tried first
  and aborts on this tree's honest peer-range mismatches: `@reach/*` declares react ^16/^17).
  CI regenerates from the committed lockfile on every run and uploads it as a build artifact;
  `serialNumber`/`timestamp` differ per run by design, so compare the `components` array.
* CI contracts job gains a double-build gate: hash all `out/**` artifacts, `forge build
  --force`, hash again, `diff` must be empty. Verified locally: 154/154 artifacts
  byte-identical across two forced builds.
* npm provenance (`npm publish --provenance`) and Sigstore tag signing are **documented, not
  buildable from this environment** (no npm publish, no GitHub OIDC/token - rule 6: no secrets
  in the repo). Exact commands recorded in `docs/CRYPTO_DECISIONS.md` section H for when a real
  release exists.

**Verification:** workflow YAML parses; SBOM parses (CycloneDX 1.5, 620 components, 621
dependency edges); local double-build diff empty; full battery green (forge 204, fuzz x5000,
npm test 22, lint 0 errors, build ok, e2e 1, both smokes PASS, manifest verify OK).

## D35 - Merkle allowlist distributions (C)

**Context:** C of the A-I list (allowlists / incentivized distributions). Threat-first: an
allowlist decides who gets paid, so it must resist forged membership (second-preimage and
proof forgery), duplicate claims, and silent root swaps; and the item's acceptance criteria
demand a TypeScript generator plus a test proving forged proofs and duplicate claims fail.

**Findings:**

1. No allowlist feature existed yet (the hooks allowlist defers to E's code-hash registry), so
   the scope decision was to build ONE distribution primitive now - tested, timelocked,
   documented - instead of inventing an ad-hoc tree per future feature.
2. A naive `keccak256(abi.encode(index, account, amount))` leaf is second-preimage-vulnerable:
   any 32-byte internal tree node can be replayed as a "leaf" of the same tree class, because
   nodes and leaves share a preimage length.
3. The root is the security boundary: whoever can rotate it can redirect the entire payout,
   so a root update must not be a single-key instant action.

**Decision:**

* `src/v4/periphery/MerkleDistributor.sol` - `claim(index, account, amount, proof)` verified by
  OpenZeppelin `MerkleProof` v5.2 (its `commutativeKeccak256` = sorted-pair hashing; no
  hand-rolled hash anywhere). Leaves are DOUBLE-hashed in one canonical place,
  `leafOf = keccak256(bytes.concat(keccak256(abi.encode(...))))`, so an internal node can never
  be reinterpreted as a claim leaf.
* Claims tracked in a 256-per-word bitmap (`isClaimed`), marked BEFORE the transfer (CEI - a
  reentrant token hits `AlreadyClaimed`); `claim` is permissionless but always pays the leaf's
  `account` - a relayer can neither redirect nor inflate.
* Root rotation: `setRoot` is `onlyOwner`, and deployments pass the `TimelockController` as
  constructor owner (D29) - schedule, delay, cancel-during-delay, then execute; zero roots
  rejected at construction and rotation.
* Generator: `apps/web/scripts/merkle.ts`, TypeScript as the item requires, zero new
  dependencies (hashing via the already-pinned ethers v5, `typescript` was already a devDep;
  CLI = `npm run merkle` = tsc-compile + node, output committed to
  `contracts/test/fixtures/merkle.json`). `foundry.toml` gains read-only `fs_permissions` for
  `./test/fixtures` so the forge suite consumes the SAME artifact the generator wrote - that is
  the cross-language proof: JS-built proofs must satisfy the audited Solidity verifier.

**Verification:** +26 tests in `MerkleDistributor.t.sol` (JS-fixture claims, permissionless
relay, duplicates, bitmap word boundary incl. index 256, tampered/empty/truncated/stale/cross
proofs, single-hash tree rejection, double-hash-vs-internal-node disjointness, fuzzed forgery
x5000, timelocked schedule/execute/cancel, constructor + input guards, reentrant token) =>
`forge test` 230 passed; +8 tests in `apps/web/tests/merkle.test.ts` (independent fold verifier,
tamper matrix, odd-tree carry, byte-for-byte fixture reproduction) => npm 30; Slither Phase 9:
56 contracts, 82 results - ZERO referencing `MerkleDistributor`. Caught by inspection before
commit: the generator's first draft dropped upper-level proof siblings for right-child leaves
(member-set fix; the fixture-reproduction and fold tests now pin it).
**Deployment:** `Deploy.s.sol` reads the committed fixture root (so deployed root, fixture
proofs, and tests cannot drift), deploys the distributor LAST (earlier CREATE order intact),
and mints the 10 SWA the fixture promises - rotation #7 signed; `smoke.mjs` claims slot 0 with
the fixture proof on-chain and asserts the duplicate call reverts `AlreadyClaimed`.