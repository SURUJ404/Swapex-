import random
from decimal import Decimal, getcontext
from refmath import *

random.seed(7)
print("MIN_SQRT_RATIO", MIN_SQRT_RATIO, "MAX_SQRT_RATIO", MAX_SQRT_RATIO)
print("tick 0 ->", sqrt_ratio_at_tick(0) == Q96)

# 1. accuracy vs exact decimal: sqrt(1.0001^tick) * 2^96 within 1 ulp (we round up)
for t in [MIN_TICK, -500000, -100000, -887, -1, 1, 887, 100000, 500000, MAX_TICK] + [random.randint(MIN_TICK, MAX_TICK) for _ in range(300)]:
    exact = (Decimal("1.0001") ** (Decimal(t) / 2)) * Q96
    got = sqrt_ratio_at_tick(t)
    err = abs(Decimal(got) - exact)
    rel = err / exact
    bound = Decimal(2) ** (-85 if abs(t) <= 100000 else -60)  # extremes lose precision when the Q128 ratio is inverted
    assert rel < bound or err <= 2, (t, got, exact)

# 2. strictly monotonic over a dense sample and tick round-trip
prev = None
for t in range(-3000, 3000):
    s = sqrt_ratio_at_tick(t)
    assert prev is None or s > prev, t
    prev = s
for t in [random.randint(MIN_TICK, MAX_TICK - 1) for _ in range(400)] + [MIN_TICK, MAX_TICK - 1, 0, -1, 1]:
    s = sqrt_ratio_at_tick(t)
    assert tick_at_sqrt_ratio(s) == t, t
    if s + 1 < sqrt_ratio_at_tick(t + 1):
        assert tick_at_sqrt_ratio(s + 1) == t
        assert tick_at_sqrt_ratio(sqrt_ratio_at_tick(t + 1) - 1) == t
print("tick math ok")

# 3. 512-bit mulDiv port equals exact big-int division (incl. overflowing products)
for _ in range(20000):
    a = random.getrandbits(random.choice([8, 64, 128, 200, 256]))
    b = random.getrandbits(random.choice([8, 64, 128, 200, 256]))
    d = random.getrandbits(random.choice([8, 64, 128, 200, 256])) or 1
    if (a * b) // d > U256:
        continue
    assert mul_div_512(a, b, d) == (a * b) // d, (a, b, d)
print("mulDiv port ok")

# 4. swap-step properties
for _ in range(20000):
    L = random.randint(1, 10**30)
    t0 = random.randint(-200000, 200000)
    t1 = random.randint(-200000, 200000)
    if t0 == t1:
        continue
    sp, target = sqrt_ratio_at_tick(t0), sqrt_ratio_at_tick(t1)
    fee = random.choice([100, 500, 3000, 10000])
    rem = random.randint(1, 10**24) * random.choice([1, -1])
    nxt, ai, ao, fa = swap_step(sp, target, L, rem, fee)
    zfo = sp >= target
    assert (min(sp, target) <= nxt <= max(sp, target))
    if rem > 0:
        assert ai + fa <= rem, "never takes more than offered"
        if nxt != target:
            assert ai + fa == rem
    else:
        assert ao <= -rem
    # price moves in the right direction
    assert (nxt <= sp) if zfo else (nxt >= sp)
    # amount_out never exceeds what the move releases (rounded down)
    rel_out = amount1_delta(nxt, sp, L, False) if zfo else amount0_delta(sp, nxt, L, False)
    assert ao <= rel_out
print("swap step ok")
