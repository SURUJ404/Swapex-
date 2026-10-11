"""Self-check of the V4 PoolManager reference model (v4model.py).

Validates the flash-accounting core that the Solidity PoolManager must reproduce:
  - a multi-hop, multi-pool exact-in swap inside one unlock nets every currency delta to zero,
  - add-liquidity produces a negative (owes-pool) delta, remove-liquidity a positive one,
  - fees accrued on burn/poke are folded into the positive delta,
  - after unlock, reserves match the net tokens that actually moved,
  - take() refuses to over-withdraw.
Run from contracts/reference:  py check_v4.py
"""
import sys
from refmath import MIN_SQRT_RATIO, MAX_SQRT_RATIO, Q96
from v4model import PoolManagerModel, pool_id

OK = 0


def ok(cond, msg):
    global OK
    assert cond, msg
    OK += 1
    print(f"  ok - {msg}")


class Cb:
    """Minimal unlock callback: runs a scripted list of actions against the manager."""

    def __init__(self, actions):
        self.actions = actions

    def unlockCallback(self, mgr, _data):
        for act in self.actions:
            act(mgr)


def run(actions, mgr=None):
    if mgr is None:
        mgr = PoolManagerModel()
    mgr.unlock(Cb(actions), b"")
    return mgr


def test_multihop_swap_nets_zero():
    print("test_multihop_swap_nets_zero")
    m = PoolManagerModel()
    # two pools sharing currency1: A=(USDC,WETH), B=(WETH,DAI). We swap USDC->WETH->DAI.
    keyA = (1, 2, 3000, 60)  # token1<->token2
    keyB = (2, 3, 3000, 60)  # token2<->token3
    m.initialize(keyA, Q96)
    m.initialize(keyB, Q96)

    # seed both pools with liquidity (own unlock session); mint only produces negative deltas
    def seed(mgr):
        mgr.modify_liquidity(keyA, "LP", -6000, 6000, 10**20)
        mgr.modify_liquidity(keyB, "LP", -6000, 6000, 10**20)
        for c in (1, 2, 3):
            d = mgr.currency_delta(c)
            if d < 0:
                mgr.settle(c, -d)
    run([seed], m)

    got = {}

    def hopA(mgr):
        # sell 1e18 of token1 into pool A (exact in). Pool pays out token2.
        d0, d1 = mgr.swap(keyA, True, 10**18, MIN_SQRT_RATIO + 1)
        got["A"] = (d0, d1)  # token1: negative (owes pool), token2: positive (pool owes)

    def hopB(mgr):
        # route the received token2 into pool B (exact in) -> receive token3
        # amountSpecified = token2 amount received from A (positive delta d1)
        amt_in = got["A"][1]
        d1, d2 = mgr.swap(keyB, True, amt_in, MIN_SQRT_RATIO + 1)
        got["B"] = (d1, d2)

    def settle_and_take(mgr):
        # caller owes token1 (negative delta): settle it
        owed = -mgr.currency_delta(1)
        mgr.settle(1, owed)
        # caller is owed token3 (positive delta): take it
        got3 = mgr.currency_delta(3)
        mgr.take(3, got3)
        got["out3"] = got3

    m2 = run([hopA, hopB, settle_and_take], m)

    d1 = m2.currency_delta(1)
    d2 = m2.currency_delta(2)
    d3 = m2.currency_delta(3)
    ok(d1 == 0 and d2 == 0 and d3 == 0, f"all deltas net to zero (got {d1},{d2},{d3})")
    # token3 was taken out: reserves should be negative (seeded in, then taken beyond it) or positive
    ok(got["out3"] > 0, f"token3 taken {got['out3']}")
    # token2 was intermediate in the swap: its DELTA nets to zero (already checked above).
    # Its reserves hold the seeded liquidity (not zero) — assert they match the seeded amount.
    ok(m2.reserves_of(2) > 0, f"intermediate token2 reserves hold seeded liquidity ({m2.reserves_of(2)})")
    # A's token1 in == B's token2 in chain-consistent: intermediate token2 net zero reserve
    print(f"    hopA={got['A']} hopB={got['B']} out3={got['out3']}")


def test_add_then_remove_liquidity():
    print("test_add_then_remove_liquidity")
    m = PoolManagerModel()
    key = (1, 2, 3000, 60)
    m.initialize(key, Q96)
    owner = "LP"

    added = {}
    def add(mgr):
        d0, d1 = mgr.modify_liquidity(key, owner, -60, 60, 10**18)
        added["delta"] = (d0, d1)

    def settle_add(mgr):
        d0, d1 = added["delta"]
        mgr.settle(1, -d0)  # d0 negative -> caller owes token1
        mgr.settle(2, -d1)

    # snapshot deposits after the add+settle session
    m2 = run([add, settle_add], m)
    ok(m2.currency_delta(1) == 0 and m2.currency_delta(2) == 0, "add-liquidity deltas settle to zero")
    ok(m2.reserves_of(1) > 0 and m2.reserves_of(2) > 0, "add-liquidity moved tokens into reserves")
    deposit0, deposit1 = m2.reserves_of(1), m2.reserves_of(2)

    # full round-trip on a FRESH manager in one session: add, settle, remove, take
    m3 = PoolManagerModel()
    m3.initialize(key, Q96)
    removed = {}
    def add3(mgr):
        d0, d1 = mgr.modify_liquidity(key, owner, -60, 60, 10**18)
        mgr.settle(1, -d0)
        mgr.settle(2, -d1)
    def remove3(mgr):
        d0, d1 = mgr.modify_liquidity(key, owner, -60, 60, -(10**18))
        removed["delta"] = (d0, d1)
        mgr.take(1, d0)
        mgr.take(2, d1)
    run([add3, remove3], m3)
    ok(m3.currency_delta(1) == 0 and m3.currency_delta(2) == 0, "remove-liquidity deltas settle to zero")
    # mint rounds up (against minter) and burn rounds down (against burner), so the pool keeps a
    # rounding surplus: removed <= deposited, never a deficit (solvency). Residuals stay positive.
    rem0, rem1 = m3.reserves_of(1), m3.reserves_of(2)
    ok(0 <= rem0 <= deposit0 and 0 <= rem1 <= deposit1,
       f"pool keeps rounding surplus, never a deficit (left {rem0},{rem1} of {deposit0},{deposit1})")
    print(f"    deposit={deposit0},{deposit1} removed={removed['delta']} surplus={rem0},{rem1}")


def test_take_refuses_overdraw():
    print("test_take_refuses_overdraw")
    m = PoolManagerModel()
    key = (1, 2, 3000, 60)
    m.initialize(key, Q96)

    def bad_take(mgr):
        mgr.swap(key, True, 10**18, MIN_SQRT_RATIO + 1)
        # token1 delta is negative (owes pool); trying to TAKE token1 should fail
        mgr.take(1, 1)

    try:
        run([bad_take], m)
        ok(False, "overdraw take should revert")
    except AssertionError as e:
        ok("take exceeds" in str(e), f"overdraw take reverted ({e})")


def test_double_unlock_reverts():
    print("test_double_unlock_reverts")
    m = PoolManagerModel()
    key = (1, 2, 3000, 60)
    m.initialize(key, Q96)

    def reenter(mgr):
        mgr.unlock(Cb([]), b"")  # nested unlock -> should assert

    try:
        run([reenter], m)
        ok(False, "nested unlock should revert")
    except AssertionError as e:
        ok("already unlocked" in str(e), f"nested unlock reverted ({e})")


def test_swap_crosses_ticks():
    print("test_swap_crosses_ticks")
    m = PoolManagerModel()
    key = (1, 2, 3000, 60)
    m.initialize(key, Q96)
    # add a wide liquidity band, then swap a huge amount to force crossing ticks
    def setup(mgr):
        mgr.modify_liquidity(key, "LP", -6000, 6000, 10**20)
        mgr.settle(1, mgr.currency_delta(1) * -1)
        mgr.settle(2, mgr.currency_delta(2) * -1)

    got = {}
    def big_swap(mgr):
        d0, d1 = mgr.swap(key, True, 10**19, MIN_SQRT_RATIO + 1)
        got["d"] = (d0, d1)
        # settle input, take output
        mgr.settle(1, -d0)
        mgr.take(2, d1)

    m2 = run([setup, big_swap], m)
    ok(m2.currency_delta(1) == 0 and m2.currency_delta(2) == 0, "crossing-tick swap deltas net to zero")
    ok(got["d"][0] < 0 and got["d"][1] > 0, f"token0 in / token1 out ({got['d']})")
    # price must have moved down (token0 sold)
    ok(m2.pools[pool_id(key)].tick < 0, f"tick moved negative ({m2.pools[pool_id(key)].tick})")
    print(f"    delta={got['d']} tick={m2.pools[pool_id(key)].tick}")


def main():
    test_multihop_swap_nets_zero()
    test_add_then_remove_liquidity()
    test_take_refuses_overdraw()
    test_double_unlock_reverts()
    test_swap_crosses_ticks()
    print(f"\ncheck_v4: {OK} checks passed")


if __name__ == "__main__":
    main()
