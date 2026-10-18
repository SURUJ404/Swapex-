"""Reference model (arbitrary-precision ints) for the Swapex concentrated-liquidity math.
Everything the Solidity libraries do is mirrored here so results can be cross-checked and
golden vectors generated. Q96 = 2**96 sqrt-price format, Q128 fee-growth format."""
from decimal import Decimal, getcontext

getcontext().prec = 160

Q96 = 1 << 96
Q128 = 1 << 128
U256 = (1 << 256) - 1
U160 = (1 << 160) - 1
MIN_TICK, MAX_TICK = -887272, 887272

# c_i = floor(2^128 * 1.0001^(-2^i / 2)) : multiplying the Q128 ratio by c_i divides sqrtPrice by 1.0001^(2^i/2)
TICK_CONSTS = []
for i in range(20):
    e = -Decimal(2 ** i) / 2
    TICK_CONSTS.append(int((Decimal(2) ** 128) * (Decimal("1.0001") ** e)))


def sqrt_ratio_at_tick(tick):
    assert MIN_TICK <= tick <= MAX_TICK
    a = abs(tick)
    ratio = 1 << 128
    for i in range(20):
        if a & (1 << i):
            ratio = (ratio * TICK_CONSTS[i]) >> 128
    if tick > 0:
        ratio = U256 // ratio
    return (ratio >> 32) + (0 if ratio % (1 << 32) == 0 else 1)


MIN_SQRT_RATIO = sqrt_ratio_at_tick(MIN_TICK)
MAX_SQRT_RATIO = sqrt_ratio_at_tick(MAX_TICK)


def tick_at_sqrt_ratio(s):
    assert MIN_SQRT_RATIO <= s < MAX_SQRT_RATIO
    lo, hi = MIN_TICK, MAX_TICK  # find greatest tick with sqrt_ratio_at_tick(tick) <= s
    while lo < hi:
        mid = (lo + hi + 1) >> 1  # floor-safe for negatives via Python's >>
        if sqrt_ratio_at_tick(mid) <= s:
            lo = mid
        else:
            hi = mid - 1
    return lo


def mul_div(a, b, d):
    assert d > 0
    r = (a * b) // d
    assert r <= U256
    return r


def mul_div_up(a, b, d):
    r = mul_div(a, b, d)
    return r + 1 if (a * b) % d else r


def div_up(a, b):
    return a // b + (1 if a % b else 0)


def mul_div_512(a, b, d):
    """Port of the Solidity 512-bit mulDiv; must equal mul_div for all valid inputs."""
    M = 1 << 256
    mm = (a * b) % U256 if U256 else 0  # mulmod(a,b,2^256-1)
    prod0 = (a * b) % M
    prod1 = (mm - prod0 - (1 if mm < prod0 else 0)) % M
    if prod1 == 0:
        assert d > 0
        return prod0 // d
    assert d > prod1
    rem = (a * b) % d
    prod1 = (prod1 - (1 if rem > prod0 else 0)) % M
    prod0 = (prod0 - rem) % M
    twos = d & ((~d + 1) % M)
    d //= twos
    prod0 //= twos
    twos = ((0 - twos) % M) // twos + 1
    prod0 |= (prod1 * twos) % M
    inv = (3 * d) ^ 2
    for _ in range(6):
        inv = (inv * (2 - d * inv)) % M
    return (prod0 * inv) % M


def amount0_delta(sa, sb, L, up):
    if sa > sb:
        sa, sb = sb, sa
    assert sa > 0
    n1 = L << 96
    n2 = sb - sa
    if up:
        return div_up(mul_div_up(n1, n2, sb), sa)
    return mul_div(n1, n2, sb) // sa


def amount1_delta(sa, sb, L, up):
    if sa > sb:
        sa, sb = sb, sa
    return mul_div_up(L, sb - sa, Q96) if up else mul_div(L, sb - sa, Q96)


def next_price_from_amount0(sp, L, amt, add):
    if amt == 0:
        return sp
    n1 = L << 96
    if add:
        prod = amt * sp
        if prod <= U256 and (n1 + prod) <= U256:
            return mul_div_up(n1, sp, n1 + prod)
        return div_up(n1, n1 // sp + amt)
    prod = amt * sp
    assert prod <= U256 and n1 > prod
    return mul_div_up(n1, sp, n1 - prod)


def next_price_from_amount1(sp, L, amt, add):
    if add:
        q = (amt << 96) // L if amt <= U160 else mul_div(amt, Q96, L)
        r = sp + q
        assert r <= U160
        return r
    q = div_up(amt << 96, L) if amt <= U160 else mul_div_up(amt, Q96, L)
    assert sp > q
    return sp - q


def next_price_from_input(sp, L, amt_in, zero_for_one):
    assert sp > 0 and L > 0
    return next_price_from_amount0(sp, L, amt_in, True) if zero_for_one else next_price_from_amount1(sp, L, amt_in, True)


def next_price_from_output(sp, L, amt_out, zero_for_one):
    assert sp > 0 and L > 0
    return next_price_from_amount1(sp, L, amt_out, False) if zero_for_one else next_price_from_amount0(sp, L, amt_out, False)


def swap_step(sp, target, L, remaining, fee):
    """remaining > 0: exact input, remaining < 0: exact output. Returns (next, in, out, fee_amt)."""
    zfo = sp >= target
    exact_in = remaining >= 0
    if exact_in:
        less_fee = mul_div(remaining, 10**6 - fee, 10**6)
        amt_in = amount0_delta(target, sp, L, True) if zfo else amount1_delta(sp, target, L, True)
        if less_fee >= amt_in:
            nxt = target
        else:
            nxt = next_price_from_input(sp, L, less_fee, zfo)
    else:
        amt_out = amount1_delta(target, sp, L, False) if zfo else amount0_delta(sp, target, L, False)
        if -remaining >= amt_out:
            nxt = target
        else:
            nxt = next_price_from_output(sp, L, -remaining, zfo)
    reached = nxt == target
    if zfo:
        amt_in = amt_in if (reached and exact_in) else amount0_delta(nxt, sp, L, True)
        amt_out = amt_out if (reached and not exact_in) else amount1_delta(nxt, sp, L, False)
    else:
        amt_in = amt_in if (reached and exact_in) else amount1_delta(sp, nxt, L, True)
        amt_out = amt_out if (reached and not exact_in) else amount0_delta(sp, nxt, L, False)
    if not exact_in and amt_out > -remaining:
        amt_out = -remaining
    if exact_in and nxt != target:
        fee_amt = remaining - amt_in
    else:
        fee_amt = mul_div_up(amt_in, fee, 10**6 - fee)
    return nxt, amt_in, amt_out, fee_amt
