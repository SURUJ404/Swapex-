"""Validate the TWAP observation model in poolmodel.py against brute-force integration.

tickCumulative is integrated exactly (tick constant within each inter-observation
interval), so we can compare observe() to a direct sum over the recorded segments
at arbitrary target times. secondsPerLiquidityCumulative uses floor division and the
observe() path linearly interpolates between stored endpoints, so we only assert it
exactly at write timestamps (where observe() returns the stored value with no interp),
plus monotonicity/bounds at arbitrary times. We also assert the core manipulation-
resistance property: price moves that happen with zero elapsed time cannot move the
time-weighted average tick.
"""
import random
from poolmodel import *

random.seed(7)


def expected_tick_cum(pool, target):
    """Brute-force cumulative tick*time up to `target` from recorded segments."""
    total = 0
    for (s, e, tick, L) in pool.ground_truth:
        lo, hi = max(s, 0), min(e, target)
        if hi > lo:
            total += tick * (hi - lo)
    newest = pool.obs[pool.obs_index]
    if target > newest['ts']:
        total += pool.tick * (target - newest['ts'])
    return total


def expected_spl_cum_at_write(pool, target):
    """Brute-force seconds-per-liquidity up to a write timestamp `target`."""
    total = 0
    for (s, e, tick, L) in pool.ground_truth:
        if e <= target:
            if L > 0 and e > s:
                total += ((e - s) << 128) // L
        else:
            break
    return total


def run_random_walk(trial):
    fee = random.choice([500, 3000, 10000])
    spacing = random.choice([10, 60, 200])
    start_tick = random.randint(-500, 500)
    card_next = random.choice([1, 2, 5, 16, 100])
    pool = Pool(fee, spacing, sqrt_ratio_at_tick(start_tick), card_next)
    s = spacing
    # seed liquidity so swaps move the price
    pool.mint("a", start_tick // s * s - 40 * s, start_tick // s * s + 40 * s, 10**20)
    pool.mint("a", start_tick // s * s - 200 * s, start_tick // s * s + 200 * s, 10**19)

    write_ts = [0]  # times at which an observation was written
    for step in range(random.randint(3, 12)):
        pool.now += random.randint(1, 500)  # advance block time
        zfo = random.random() < 0.5
        limit = (max(MIN_SQRT_RATIO + 1, pool.sqrt // 2) if zfo
                 else min(MAX_SQRT_RATIO - 1, pool.sqrt * 2))
        amt = random.randint(1, 10**18) * random.choice([1, -1])
        if amt < 0 and pool.L == 0:
            continue
        pool.swap(zfo, amt, limit)
        write_ts.append(pool.now)

    # Only validate within the retained ring window: older observations are overwritten.
    oldest_ts = pool._obs_list()[0]['ts']

    # 1) tickCumulative matches brute force at arbitrary times inside the window
    for _ in range(40):
        target = random.randint(oldest_ts, pool.now)
        got = pool._observe_single(target)[0]
        assert got == expected_tick_cum(pool, target), (
            "tickCum", trial, target, got, expected_tick_cum(pool, target))

    # 2) secondsPerLiquidityCumulative exact at write timestamps inside the window
    for ts in write_ts:
        if ts < oldest_ts:
            continue
        got = pool._observe_single(ts)[1]
        want = expected_spl_cum_at_write(pool, ts)
        assert got == want, ("spl", trial, ts, got, want)

    # 3) secondsPerLiquidityCumulative monotonic non-decreasing in time
    prev = -1
    for target in range(0, pool.now + 1, max(1, pool.now // 50 or 1)):
        v = pool._observe_single(target)[1]
        assert v >= prev, ("spl monotonic", trial, target, v, prev)
        prev = v

    # 4) observe() array form is consistent with _observe_single
    agos = sorted([random.randint(0, pool.now) for _ in range(6)], reverse=True)
    tc, spl = pool.observe(agos)
    for ago, t_c, s_c in zip(agos, tc, spl):
        gt_c, gt_s = pool._observe_single(pool.now - ago)
        assert t_c == gt_c and s_c == gt_s, ("observe[]", trial, ago)


# ---- manipulation resistance: same-timestamp price swings don't move the TWAP ----
def check_manipulation_resistance():
    pool = Pool(3000, 60, sqrt_ratio_at_tick(0), 100)
    pool.mint("a", -1200, 1200, 10**21)
    # let a real price history build up over many blocks
    for i in range(20):
        pool.now += 10
        pool.swap(True if i % 2 == 0 else False,
                  10**16 * (i + 1),
                  max(MIN_SQRT_RATIO + 1, pool.sqrt // 2) if i % 2 == 0
                  else min(MAX_SQRT_RATIO - 1, pool.sqrt * 2))
    window = 100
    twap_before = pool.twap_tick(window)

    # attacker moves price hard in a SINGLE block (no time advance), then reverts it
    # in the same block: both swaps occur at pool.now, so dt=0 for the manipulated leg.
    entry_tick = pool.tick
    entry_sqrt = pool.sqrt
    pool.swap(True, 10**21, max(MIN_SQRT_RATIO + 1, pool.sqrt // 4))  # slam price down
    slammed_tick = pool.tick
    pool.swap(False, 10**21, min(MAX_SQRT_RATIO - 1, pool.sqrt * 4))  # push back up
    pool.now += 1  # one block later, observation reflects the recovery
    pool.swap(True, 1, max(MIN_SQRT_RATIO + 1, pool.sqrt - 1))  # touch to flush an observation

    twap_after = pool.twap_tick(window)
    # The multi-block TWAP must be essentially unchanged: the manipulation occupied
    # zero elapsed time, so it cannot shift a time-weighted average over `window`.
    assert slammed_tick != entry_tick, "attack should have moved the spot price"
    assert abs(twap_after - twap_before) <= 1, (twap_before, twap_after)
    # spot DID move (manipulation happened) but the time-weighted average did not
    print(f"  manipulation: spot {entry_tick} -> {slammed_tick}, "
          f"twap {twap_before} -> {twap_after} (unchanged within 1 tick)")


for trial in range(120):
    run_random_walk(trial)
print("oracle tickCum/spl observe vs brute force ok")

check_manipulation_resistance()
print("manipulation resistance ok")
