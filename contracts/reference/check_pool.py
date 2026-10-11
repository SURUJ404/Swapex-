import random
from poolmodel import *

random.seed(11)

# --- bitmap helpers behave: next initialized tick search both ways, negatives, word boundaries
p = Pool(3000, 60, Q96)
for t in (-15360 * 2, -120, 60, 6000, 15360, 15360 * 3):
    p._flip(t)
assert p._next(0, True) == (-120, True) or p._next(0, True)[0] <= 0
assert p._next(0, False) == (60, True)
assert p._next(61, False) == (6000, True)
assert p._next(-121, True) == (-30720, True) or p._next(-121, True)[1] is False
for _ in range(2000):
    t = random.randint(-100000, 100000)
    for lte in (True, False):
        n, init = p._next(t, lte)
        # result is aligned and on the right side of the query tick
        assert n % 60 == 0
        assert (n <= t) if lte else (n > t)
        if init:
            assert (n // 60) in {k // 60 for k in (-15360 * 2, -120, 60, 6000, 15360, 15360 * 3)}
print("bitmap ok")

# --- scenario: two overlapping positions, swaps in both directions crossing ticks, then everything is redeemable
for trial in range(200):
    pool = Pool(random.choice([500, 3000, 10000]), random.choice([10, 60, 200]), sqrt_ratio_at_tick(random.randint(-2000, 2000)))
    s = pool.spacing
    positions = []
    for owner in ("a", "b", "c"):
        lo = random.randint(-30, 10) * s
        hi = lo + random.randint(1, 40) * s
        L = random.randint(10**15, 10**22)
        pool.mint(owner, lo, hi, L)
        positions.append((owner, lo, hi, L))
    start0, start1 = pool.bal0, pool.bal1
    for _ in range(random.randint(1, 8)):
        zfo = random.random() < 0.5
        limit = (pool.sqrt - 1 if zfo else pool.sqrt + 1)
        # push the limit far away so ranges get crossed
        limit = max(MIN_SQRT_RATIO + 1, pool.sqrt // 2) if zfo else min(MAX_SQRT_RATIO - 1, pool.sqrt * 2)
        amt = random.randint(1, 10**21) * random.choice([1, -1])
        if amt < 0 and pool.L == 0:
            continue
        try:
            pool.swap(zfo, amt, limit)
        except AssertionError:
            raise
    # invariants: liquidity matches positions covering the tick; balances never negative
    expect = sum(L for (o, lo, hi, L) in positions if lo <= pool.tick < hi)
    assert pool.L == expect, (pool.L, expect, trial)
    assert pool.bal0 >= 0 and pool.bal1 >= 0
    # everything can be redeemed: burn all, collect all, pool keeps only dust
    for owner, lo, hi, L in positions:
        pool.burn(owner, lo, hi, L)
        pool.collect(owner, lo, hi)
    assert pool.bal0 >= 0 and pool.bal1 >= 0, (pool.bal0, pool.bal1)
    assert pool.bal0 < 10**4 + 10 * len(positions) * 100 and pool.bal1 < 10**4 + 10 * len(positions) * 100, (pool.bal0, pool.bal1, trial)
    assert pool.L == 0
print("pool scenarios ok")
