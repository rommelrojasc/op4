"""Symbol list used for backend scans/trading worker.

0DTE tickers (SPX, SPY, QQQ, IWM) are listed first because they have
the tightest time constraints — narrow operating windows (e.g. CT15
09:30-09:47) and same-day expiry.  With IB_CLIENT_POOL_SIZE=1 the
scanner processes symbols sequentially, so order matters.
"""

SYMBOLS = [
    # ── 0DTE / index tickers (scan first) ─────────────────────────
    "SPX",
    "SPY",
    "QQQ",
    "IWM",
    # ── Leveraged ETFs ────────────────────────────────────────────
    "SOXL",
    "TNA",
    "DIA",
    # ── Individual stocks ─────────────────────────────────────────
    "AMZN",
    "AAPL",
    "GOOG",
    "META",
    "MSFT",
    "NFLX",
    "TSLA",
    "PLTR",
    "ORCL",
    "AMD",
    "MU",
    "NVDA",
    "QCOM",
    "AVGO",
    "DASH",
    "LYFT",
    "UBER",
    "HD",
    "LOW",
    "WMT",
    "AXP",
    "C",
    "MA",
    "PYPL",
    "V",
    "BABA",
    "LI",
    "NIO",
    "XPEV",
    "GLD",
    "SLV",
    "USO",
    "COIN",
    "HOOD",
    "CVS",
    "MRNA",
    "PFE",
    "BA",
    "URA",
]
