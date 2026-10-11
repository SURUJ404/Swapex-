"""Reference model of a Swapex V4-style singleton PoolManager (flash accounting).

Reuses the validated single-pool `Pool` from poolmodel.py for per-pool math and layers the
singleton + flash-accounting behaviour on top:

  - one manager holds many pools keyed by PoolId,
  - inside an `unlock` session, swaps / liquidity changes accumulate per-currency deltas
    (what the pool owes the caller, positive, or the caller owes the pool, negative),
  - the caller `settle`s negative deltas (pays tokens in) and `take`s positive deltas
    (withdraws tokens) inside the callback,
  - when the session ends every currency delta must be exactly zero (flash accounting),
    so multi-hop swaps across pools move no tokens until the end.

Delta sign convention (matches the Solidity): a currency delta is the amount the POOL owes
the CALLER for that currency. Positive => caller may `take`; negative => caller must `settle`.
"""
from poolmodel import Pool, sqrt_ratio_at_tick, Q96, MIN_SQRT_RATIO, MAX_SQRT_RATIO


def pool_id(key):
    """Deterministic id for a pool key (currency0, currency1, fee, tickSpacing)."""
    c0, c1, fee, spacing = key
    assert c0 < c1, "currency0 must sort below currency1"
    return (c0, c1, fee, spacing)


class PoolManagerModel:
    def __init__(self):
        self.pools = {}  # id -> Pool
        self.keys = {}  # id -> key tuple
        self.delta = {}  # currency -> int (pool owes caller; transient in Solidity)
        self.touched = set()  # currencies with a non-zero delta this unlock
        self.unlocked = False
        self.reserves = {}  # currency -> uint256 tokens held by the manager
        # callbacks: the test supplies an object with unlockCallback(data) that drives the session
        self._callback = None

    # ---- internal delta accounting ----
    def _account(self, currency, amount):
        """Accumulate `amount` (signed) into the currency delta and track it as touched."""
        if amount == 0:
            return
        self.delta[currency] = self.delta.get(currency, 0) + amount
        if self.delta[currency] == 0:
            self.touched.discard(currency)
        else:
            self.touched.add(currency)

    # ---- unlock session ----
    def unlock(self, callback, data):
        assert not self.unlocked, "already unlocked"
        self.unlocked = True
        self._callback = callback
        try:
            callback.unlockCallback(self, data)
        finally:
            self._callback = None
            # flash accounting: every currency delta must net to zero before closing
            for c in list(self.touched):
                assert self.delta.get(c, 0) == 0, f"unsettled delta for {c}: {self.delta.get(c, 0)}"
            self.delta.clear()
            self.touched.clear()
            self.unlocked = False

    def require_unlocked(self):
        assert self.unlocked, "not unlocked"

    # ---- pool lifecycle ----
    def initialize(self, key, sqrt_price):
        pid = pool_id(key)
        assert pid not in self.pools, "pool already initialized"
        c0, c1, fee, spacing = key
        self.pools[pid] = Pool(fee, spacing, sqrt_price)
        self.keys[pid] = key
        return self.pools[pid].tick

    def _pool(self, key):
        pid = pool_id(key)
        assert pid in self.pools, "pool not initialized"
        return pid, self.pools[pid]

    # ---- swap: returns (amount0, amount1) in the caller-owes convention ----
    def swap(self, key, zero_for_one, amount_specified, sqrt_price_limit):
        self.require_unlocked()
        _, pool = self._pool(key)
        c0, c1, _, _ = key
        # Pool.swap takes (zfo, amount, limit) with amount>0 exact-in; returns (a0,a1) as the
        # pool's balance change (positive = pool received). Convert to caller-owes: negate.
        a0, a1 = pool.swap(zero_for_one, amount_specified, sqrt_price_limit)
        self._account(c0, -a0)
        self._account(c1, -a1)
        return -a0, -a1

    # ---- liquidity ----
    def modify_liquidity(self, key, owner, tick_lower, tick_upper, liquidity_delta):
        """Apply a liquidity change. Returns (callerDelta0, callerDelta1) in the caller-owes
        convention (negative = caller owes pool, positive = pool owes caller). Fees accrued on
        the position since its last touch are folded into the returned delta (V4 behaviour)."""
        self.require_unlocked()
        _, pool = self._pool(key)
        c0, c1, _, _ = key
        if liquidity_delta > 0:
            # mint: caller deposits principal; pool receives => caller owes => negative deltas
            a0, a1 = pool.mint(owner, tick_lower, tick_upper, liquidity_delta)
            self._account(c0, -a0)
            self._account(c1, -a1)
            return -a0, -a1
        # burn (amount > 0) or poke (amount == 0): both credit principal + accrued fees into the
        # position's tokensOwed; a following collect withdraws them all => positive deltas.
        pool.burn(owner, tick_lower, tick_upper, -liquidity_delta)  # -(-L)=L for remove; 0 for poke
        c0paid, c1paid = pool.collect(owner, tick_lower, tick_upper)  # withdraw principal+fees
        self._account(c0, c0paid)
        self._account(c1, c1paid)
        return c0paid, c1paid

    def collect(self, key, owner, tick_lower, tick_upper):
        """Withdraw accrued fees/tokens from a position and credit them as positive deltas."""
        self.require_unlocked()
        _, pool = self._pool(key)
        c0, c1, _, _ = key
        f0, f1 = pool.collect(owner, tick_lower, tick_upper)
        self._account(c0, f0)
        self._account(c1, f1)
        return f0, f1

    # ---- token movement (flash accounting settlement) ----
    def settle(self, currency, amount):
        """Caller pays `amount` of `currency` into the manager (already transferred). Reduces a
        negative delta toward zero and increases reserves."""
        self.require_unlocked()
        self.reserves[currency] = self.reserves.get(currency, 0) + amount
        self._account(currency, amount)

    def take(self, currency, amount):
        """Caller withdraws `amount` of `currency`. Reduces a positive delta toward zero and
        decreases reserves."""
        self.require_unlocked()
        assert self.delta.get(currency, 0) >= amount, "take exceeds available delta"
        self.reserves[currency] = self.reserves.get(currency, 0) - amount
        self._account(currency, -amount)

    # ---- views ----
    def currency_delta(self, currency):
        return self.delta.get(currency, 0)

    def reserves_of(self, currency):
        return self.reserves.get(currency, 0)
