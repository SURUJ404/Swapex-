"""Reference model of the Swapex V3-style pool (single fee tier). Mirrors src/v3/SwapexPool.sol so
tests can compare exact integer results (golden vectors)."""
from refmath import *

M256 = 1 << 256


def msb(x):
    return x.bit_length() - 1


def lsb(x):
    return (x & -x).bit_length() - 1


class Pool:
    def __init__(self, fee, spacing, sqrt_price):
        self.fee, self.spacing = fee, spacing
        self.sqrt, self.tick = sqrt_price, tick_at_sqrt_ratio(sqrt_price)
        self.L = 0
        self.fg0 = self.fg1 = 0
        self.pf0 = self.pf1 = 0
        self.proto = 0  # protocol fee denominator (0 = off)
        self.ticks = {}  # tick -> dict(gross, net, fo0, fo1)
        self.bitmap = {}  # word -> int
        self.pos = {}  # (owner, lo, hi) -> dict
        self.bal0 = self.bal1 = 0

    # ---- bitmap ----
    def _position(self, compressed):
        return compressed >> 8, compressed & 0xFF

    def _flip(self, tick):
        assert tick % self.spacing == 0
        w, b = self._position(tick // self.spacing)
        self.bitmap[w] = self.bitmap.get(w, 0) ^ (1 << b)

    def _next(self, tick, lte):
        # Solidity int division truncates toward zero
        compressed = int(tick / self.spacing) if abs(tick) < 2**52 else None
        q = abs(tick) // self.spacing
        compressed = q if tick >= 0 else -q
        if tick < 0 and tick % self.spacing != 0 and (abs(tick) % self.spacing != 0):
            compressed -= 1
        if lte:
            w, b = self._position(compressed)
            mask = (1 << b) - 1 + (1 << b)
            masked = self.bitmap.get(w, 0) & mask
            if masked:
                return (compressed - (b - msb(masked))) * self.spacing, True
            return (compressed - b) * self.spacing, False
        w, b = self._position(compressed + 1)
        mask = ~((1 << b) - 1) & (M256 - 1)
        masked = self.bitmap.get(w, 0) & mask
        if masked:
            return (compressed + 1 + (lsb(masked) - b)) * self.spacing, True
        return (compressed + 1 + (255 - b)) * self.spacing, False

    # ---- ticks ----
    def _tick(self, t):
        return self.ticks.setdefault(t, dict(gross=0, net=0, fo0=0, fo1=0))

    def _fee_inside(self, lo, hi):
        l, u = self._tick(lo), self._tick(hi)
        if self.tick >= lo:
            b0, b1 = l['fo0'], l['fo1']
        else:
            b0, b1 = (self.fg0 - l['fo0']) % M256, (self.fg1 - l['fo1']) % M256
        if self.tick < hi:
            a0, a1 = u['fo0'], u['fo1']
        else:
            a0, a1 = (self.fg0 - u['fo0']) % M256, (self.fg1 - u['fo1']) % M256
        return (self.fg0 - b0 - a0) % M256, (self.fg1 - b1 - a1) % M256

    def _tick_update(self, t, delta, upper):
        info = self._tick(t)
        before = info['gross']
        after = before + delta
        assert 0 <= after < 2**128
        flipped = (after == 0) != (before == 0)
        if before == 0 and t <= self.tick:
            info['fo0'], info['fo1'] = self.fg0, self.fg1
        info['gross'] = after
        info['net'] = info['net'] - delta if upper else info['net'] + delta
        return flipped

    def _modify(self, owner, lo, hi, delta):
        assert lo < hi and MIN_TICK <= lo and hi <= MAX_TICK and lo % self.spacing == 0 and hi % self.spacing == 0
        key = (owner, lo, hi)
        p = self.pos.setdefault(key, dict(liq=0, f0=0, f1=0, o0=0, o1=0))
        fl = fu = False
        if delta != 0:
            fl = self._tick_update(lo, delta, False)
            fu = self._tick_update(hi, delta, True)
            if fl: self._flip(lo)
            if fu: self._flip(hi)
        in0, in1 = self._fee_inside(lo, hi)
        if delta == 0:
            assert p['liq'] > 0
        owed0 = mul_div((in0 - p['f0']) % M256, p['liq'], Q128)
        owed1 = mul_div((in1 - p['f1']) % M256, p['liq'], Q128)
        p['liq'] += delta
        p['f0'], p['f1'] = in0, in1
        p['o0'] += owed0
        p['o1'] += owed1
        if delta < 0:
            if fl: del self.ticks[lo]
            if fu: del self.ticks[hi]
        a0 = a1 = 0
        sl, su = sqrt_ratio_at_tick(lo), sqrt_ratio_at_tick(hi)
        if delta != 0:
            def d0(a, b, d):
                return -amount0_delta(a, b, -d, False) if d < 0 else amount0_delta(a, b, d, True)

            def d1(a, b, d):
                return -amount1_delta(a, b, -d, False) if d < 0 else amount1_delta(a, b, d, True)
            if self.tick < lo:
                a0 = d0(sl, su, delta)
            elif self.tick < hi:
                a0 = d0(self.sqrt, su, delta)
                a1 = d1(sl, self.sqrt, delta)
                self.L += delta
            else:
                a1 = d1(sl, su, delta)
        return p, a0, a1

    def mint(self, owner, lo, hi, amount):
        assert amount > 0
        _, a0, a1 = self._modify(owner, lo, hi, amount)
        self.bal0 += a0
        self.bal1 += a1
        return a0, a1

    def burn(self, owner, lo, hi, amount):
        p, a0, a1 = self._modify(owner, lo, hi, -amount)
        a0, a1 = -a0, -a1
        p['o0'] += a0
        p['o1'] += a1
        return a0, a1

    def collect(self, owner, lo, hi, r0=2**128 - 1, r1=2**128 - 1):
        p = self.pos[(owner, lo, hi)]
        c0, c1 = min(r0, p['o0']), min(r1, p['o1'])
        p['o0'] -= c0
        p['o1'] -= c1
        self.bal0 -= c0
        self.bal1 -= c1
        return c0, c1

    def swap(self, zfo, amount, limit):
        assert amount != 0
        assert (MIN_SQRT_RATIO < limit < self.sqrt) if zfo else (self.sqrt < limit < MAX_SQRT_RATIO)
        exact_in = amount > 0
        rem, calc = amount, 0
        sp, tick, L = self.sqrt, self.tick, self.L
        fg = self.fg0 if zfo else self.fg1
        pfee = 0
        while rem != 0 and sp != limit:
            start = sp
            tn, init = self._next(tick, zfo)
            tn = max(MIN_TICK, min(MAX_TICK, tn))
            snext = sqrt_ratio_at_tick(tn)
            tgt = limit if ((snext < limit) if zfo else (snext > limit)) else snext
            sp, ain, aout, fee_amt = swap_step(sp, tgt, L, rem, self.fee)
            if exact_in:
                rem -= ain + fee_amt
                calc -= aout
            else:
                rem += aout
                calc += ain + fee_amt
            if self.proto > 0:
                d = fee_amt // self.proto
                fee_amt -= d
                pfee += d
            if L > 0:
                fg = (fg + mul_div(fee_amt, Q128, L)) % M256
            if sp == snext:
                if init:
                    t = self._tick(tn)
                    if zfo:
                        t['fo0'] = (fg - t['fo0']) % M256
                        t['fo1'] = (self.fg1 - t['fo1']) % M256
                    else:
                        t['fo0'] = (self.fg0 - t['fo0']) % M256
                        t['fo1'] = (fg - t['fo1']) % M256
                    net = -t['net'] if zfo else t['net']
                    L += net
                    assert 0 <= L < 2**128
                tick = tn - 1 if zfo else tn
            elif sp != start:
                tick = tick_at_sqrt_ratio(sp)
        self.sqrt, self.tick, self.L = sp, tick, L
        if zfo:
            self.fg0 = fg
            self.pf0 += pfee
        else:
            self.fg1 = fg
            self.pf1 += pfee
        if zfo == exact_in:
            a0, a1 = amount - rem, calc
        else:
            a0, a1 = calc, amount - rem
        self.bal0 += a0
        self.bal1 += a1
        return a0, a1
