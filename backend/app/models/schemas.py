"""Pydantic models for API requests and responses."""
from pydantic import BaseModel, Field
from typing import List, Optional


class Bar(BaseModel):
    """OHLCV bar data."""

    time: int = Field(..., description="Unix timestamp")
    open: float = Field(..., description="Opening price")
    high: float = Field(..., description="High price")
    low: float = Field(..., description="Low price")
    close: float = Field(..., description="Closing price")
    volume: int = Field(..., description="Volume")


class HistoricalDataRequest(BaseModel):
    """Request parameters for historical data."""

    symbol: str = Field(..., description="Stock symbol (e.g., SPY)")
    interval: str = Field(
        default="5m", description="Timeframe interval (e.g., 1m, 5m, 1h, 1d)"
    )
    bars_count: int = Field(
        default=500, description="Number of bars to fetch", ge=1, le=2000
    )


class HistoricalDataResponse(BaseModel):
    """Response containing historical bars."""

    symbol: str
    interval: str
    bars: List[Bar]
    count: int
    con_id: int | None = None


class ErrorResponse(BaseModel):
    """Error response model."""

    error: str
    detail: Optional[str] = None


class HealthResponse(BaseModel):
    """Health check response."""

    status: str
    ib_connected: bool
    message: Optional[str] = None


class OptionChainExpiration(BaseModel):
    """Option chain expirations with strikes."""

    date: str
    strikes: List[float]


class OptionChainResponse(BaseModel):
    """Option chain response."""

    symbol: str
    expirations: List[OptionChainExpiration]


class OptionQuote(BaseModel):
    """Option quote data."""

    strike: float
    right: str
    last: Optional[float] = None
    bid: Optional[float] = None
    ask: Optional[float] = None
    oi: Optional[int] = None
    iv: Optional[float] = None


class OptionQuotesResponse(BaseModel):
    """Option quotes response."""

    symbol: str
    expiration: str
    quotes: List[OptionQuote]


class FinvizRecomTargetResponse(BaseModel):
    """Finviz recommendation/target price response."""

    symbol: str
    recom: Optional[str] = None
    target_price: Optional[str] = None
    cached_at: Optional[str] = None


class EarningsResponse(BaseModel):
    """Earnings calendar response."""

    symbol: str
    earnings_date: Optional[str] = None
    cached_at: Optional[str] = None


class StrategySettingsResponse(BaseModel):
    """Strategy settings response."""

    symbol: str
    settings: Optional[dict] = None


class EarningsResponse(BaseModel):
    """Earnings calendar response."""

    symbol: str
    earnings_date: Optional[str] = None
    cached_at: Optional[str] = None


class OrderLogEntry(BaseModel):
    """Order log entry."""

    timestamp: int
    symbol: str
    action: str
    right: Optional[str] = None
    expiration: Optional[str] = None
    strike: Optional[float] = None
    quantity: int
    price: float
    status: Optional[str] = None
    strategy_id: Optional[str] = None
    signal_id: Optional[str] = None
    position_id: Optional[str] = None
    pnl: Optional[float] = None
    pnl_pct: Optional[float] = None
    type: Optional[str] = None
    entry_price: Optional[float] = None
    target_price: Optional[float] = None
    high_water_mark: Optional[float] = None
    close_reason: Optional[str] = None
    mode: Optional[str] = None


class TradeOrderRequest(BaseModel):
    """Trade order request."""

    symbol: str
    expiration: str
    strike: float
    right: str
    action: str
    quantity: int
    price: float
    status: Optional[str] = None
    strategy_id: Optional[str] = None
    signal_id: Optional[str] = None
    position_id: Optional[str] = None
    type: Optional[str] = None
    pnl: Optional[float] = None
    pnl_pct: Optional[float] = None
    entry_price: Optional[float] = None
    target_price: Optional[float] = None


class OrdersResponse(BaseModel):
    """Orders log response."""

    orders: List[OrderLogEntry]
    open_positions: List[OrderLogEntry]
    count: int


class OrdersSummaryResponse(BaseModel):
    """Orders P&L summary."""

    total_pnl: float
    daily_pnl: dict


class IbPosition(BaseModel):
    """IBKR position snapshot."""

    symbol: str
    sec_type: str
    local_symbol: str | None = None
    exchange: str | None = None
    currency: str | None = None
    con_id: int | None = None
    multiplier: float | None = None
    quantity: float
    avg_cost: float
    market_price: float | None = None
    market_value: float | None = None
    unrealized_pnl: float | None = None
    realized_pnl: float | None = None
    cost_basis: float | None = None
    pnl_pct: float | None = None
    right: str | None = None
    strike: float | None = None
    expiration: str | None = None
    days_to_expiry: int | None = None


class IbPositionsResponse(BaseModel):
    """IBKR positions response."""

    positions: List[IbPosition]


class IbAccountSummaryResponse(BaseModel):
    """IBKR account summary response."""

    account: Optional[str] = None
    available_funds: Optional[float] = None
    total_cash_value: Optional[float] = None
    net_liquidation: Optional[float] = None
    settle_cash: Optional[float] = None
    currency: Optional[str] = None


class IbOrder(BaseModel):
    """IBKR order history entry."""

    timestamp: Optional[int] = None
    symbol: Optional[str] = None
    sec_type: Optional[str] = None
    exchange: Optional[str] = None
    currency: Optional[str] = None
    action: Optional[str] = None
    right: Optional[str] = None
    strike: Optional[float] = None
    expiration: Optional[str] = None
    quantity: Optional[float] = None
    filled: Optional[float] = None
    avg_fill_price: Optional[float] = None
    last_fill_price: Optional[float] = None
    status: Optional[str] = None
    order_type: Optional[str] = None
    limit_price: Optional[float] = None
    aux_price: Optional[float] = None
    order_id: Optional[int] = None
    perm_id: Optional[int] = None
    client_id: Optional[int] = None


class IbOrdersResponse(BaseModel):
    """IBKR orders history response."""

    orders: List[IbOrder]


class AutoTraderStatusResponse(BaseModel):
    """Auto-trader status response."""

    running: bool
    interval_seconds: int
    rth_only: bool
    last_run_at: Optional[int] = None
    next_run_at: Optional[int] = None
    current_symbol: Optional[str] = None
    in_flight_symbols: Optional[List[str]] = None
    current_stage: Optional[str] = None
    current_strategy: Optional[str] = None
    current_started_at: Optional[int] = None
    last_symbol: Optional[str] = None
    current_index: Optional[int] = None
    current_total: Optional[int] = None
    trading_mode: Optional[str] = None
    capital_spent: Optional[float] = None
    scan_results: Optional[dict] = None


class AutoTraderEvent(BaseModel):
    """Auto-trader event entry."""

    timestamp: int
    type: str
    message: str
    details: Optional[dict] = None


class AutoTraderEventsResponse(BaseModel):
    """Auto-trader events response."""

    events: List[AutoTraderEvent]


class AutoTraderSettings(BaseModel):
    """Auto-trader settings."""

    enabled: bool = False
    intervalSeconds: int = 60
    tpCheckIntervalSeconds: int = 15
    rthOnly: bool = True
    profitTargetPct: float = 0.35
    useTrailingStop: bool = False
    trailingStopPct: float = 0.1
    maxTradesPerDay: int = 2
    useOptimalRange: bool = True
    skipEarningsDay: bool = True
    useMarketOrders: bool = True
    useLimitOrdersForTrailExit: bool = True
    useLimitOrdersForEntry: bool = False
    limitOrderTimeoutSecs: int = 30
    stopLossPct: float = 0.0
    signalMaxAgeSecs: int = 0
    onePositionPerSymbol: bool = False
    blockCounterTrend: bool = True
    maxConcurrentPositions: int = 20
    onlyFavorites: bool = False
    capitalLimit: float = 0.0
    capitalLimitEnabled: bool = False
    allowOpenPositions: bool = True
    openPositionsUntil: str = "14:30"
    allowClosePositions: bool = True
    expiryCloseTime: str = "14:00"
    overrides: dict = {}
    tickerSettings: dict = {}
    allowCalls: bool = True
    allowPuts: bool = True
    paperAccount: str = ""
    liveAccount: str = ""
    tradingMode: str = "paper"
    positionSizing: str = "hybrid"
    riskPerTrade: float = 300.0
    riskPctPerTrade: float = 2.0
    maxContractsPerTrade: int = 3
    minContractsPerTrade: int = 1
    strikeWindow: int = 12
    filterBySpread: bool = True
    maxSpreadPct: float = 20.0
    maxSpreadDollar: float = 0.30
    preferTightSpreads: bool = True
    staleAfterMinutes: float = 0
    staleMinGainPct: float = 0.10
    trailingTiers: list = []
    slippageBufferPct: float = 0.08
    limitOrderBias: float = 0.25
    chopFilterEnabled: bool = True
    chopFilterAdxThreshold: float = 20
    chopFilterTimeframe: str = "5m"
    chopFilterDiGap: float = 10
    maxDailyLossDollar: float = 0
    strategySettings: dict = {}


class AutoTraderSettingsResponse(BaseModel):
    """Auto-trader settings response."""

    settings: AutoTraderSettings


class ClosePositionRequest(BaseModel):
    """Request to close a position (stock or option)."""

    symbol: str
    sec_type: str
    quantity: float
    exchange: Optional[str] = "SMART"
    currency: Optional[str] = "USD"
    expiration: Optional[str] = None
    strike: Optional[float] = None
    right: Optional[str] = None


class ClosePositionResponse(BaseModel):
    """Response after closing a position."""

    symbol: str
    sec_type: str
    action: str
    quantity: int
    order_id: Optional[int] = None
    status: Optional[str] = None


class CloseAllPositionsResult(BaseModel):
    """Result for a single position in a close-all operation."""

    symbol: str
    sec_type: str
    status: str
    error: Optional[str] = None


class CloseAllPositionsResponse(BaseModel):
    """Response after closing all positions."""

    results: List[CloseAllPositionsResult]


class FavoritesPayload(BaseModel):
    """Favorites payload."""

    favorites: List[str]


class FavoritesResponse(BaseModel):
    """Favorites response."""

    favorites: List[str]


class IbAccountInfo(BaseModel):
    """Account ID with its type (cash, margin, etc.)."""

    account: str
    account_type: Optional[str] = None  # e.g. INDIVIDUAL, INDIVIDUAL_MARGIN


class TradingAccountsResponse(BaseModel):
    """Available managed accounts for the current IB connection."""

    accounts: List[IbAccountInfo]
    current_mode: str


class SwitchModeRequest(BaseModel):
    """Request to switch between paper and live trading."""

    mode: str  # "paper" | "live"


class SwitchModeResponse(BaseModel):
    """Response after switching trading mode."""

    mode: str
    port: int
    connected: bool
