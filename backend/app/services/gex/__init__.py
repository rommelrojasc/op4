"""Source-agnostic GEX data layer.

The rest of the codebase calls `get_gex_levels(symbol, source=...)` and gets
back the same dict shape regardless of where the numbers come from.
"""
from app.services.gex.dispatcher import get_gex_levels  # noqa: F401
