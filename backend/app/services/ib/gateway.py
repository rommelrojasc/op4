"""IB Gateway connection manager with singleton pattern."""
import asyncio
import logging
from typing import Optional, List
from ib_insync import IB, util
from app.core.config import settings

logger = logging.getLogger(__name__)


PAPER_PORT = 4002
LIVE_PORT = 4001


class IBGatewayManager:
    """
    Singleton manager for IB Gateway connection.
    Ensures only one connection is maintained across the application.
    """

    _instance: Optional["IBGatewayManager"] = None
    _ib: Optional[IB] = None
    _pool: List[IB] = []
    _pool_index: int = 0
    _lock = asyncio.Lock()
    _connection_lock = asyncio.Lock()
    _active_port: Optional[int] = None  # None = use settings.IB_PORT

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    async def connect(self) -> IB:
        """
        Get or create IB Gateway connection.

        Returns:
            IB: Connected IB instance

        Raises:
            ConnectionError: If connection fails
        """
        async with self._connection_lock:
            pool_size = max(1, int(settings.IB_CLIENT_POOL_SIZE))
            if self._pool and any(ib.isConnected() for ib in self._pool):
                return self._pick_from_pool()

            self._pool = []
            self._pool_index = 0
            port = self._active_port if self._active_port is not None else settings.IB_PORT
            for offset in range(pool_size):
                ib = IB()
                client_id = settings.IB_CLIENT_ID + offset
                try:
                    await ib.connectAsync(
                        host=settings.IB_HOST,
                        port=port,
                        clientId=client_id,
                        timeout=20,
                        readonly=settings.IB_READONLY,
                    )
                    ib.reqMarketDataType(1)  # Request live (not delayed) market data

                    # Log IB errors with severity-based routing
                    def _on_error(reqId, errorCode, errorString, contract, cid=client_id):
                        # Delayed data warnings
                        if errorCode in (10167, 10197, 10168):
                            logger.warning(
                                "IB DELAYED DATA (clientId=%s): code=%s %s",
                                cid, errorCode, errorString,
                            )
                        # Order rejections and account errors (important for diagnostics)
                        elif errorCode in (
                            201,   # Order rejected
                            202,   # Order cancelled
                            203,   # Security not available
                            399,   # Order message (warning about order)
                            404,   # Order held while securities are located
                            434,   # Order size exceeds buying power
                            10147, # Order rejected - not enough settled cash
                        ):
                            contract_str = f" contract={contract}" if contract else ""
                            logger.error(
                                "IB ORDER REJECTED (clientId=%s, reqId=%s): code=%s %s%s",
                                cid, reqId, errorCode, errorString, contract_str,
                            )
                        # Skip noisy data farm connection info
                        elif errorCode not in (2104, 2106, 2158):
                            logger.info(
                                "IB error (clientId=%s): code=%s %s",
                                cid, errorCode, errorString,
                            )
                    ib.errorEvent += _on_error

                    self._pool.append(ib)
                    logger.info(
                        "Connected to IB Gateway at %s:%s (clientId=%s, port=%s)",
                        settings.IB_HOST,
                        port,
                        client_id,
                        port,
                    )
                except Exception as e:
                    logger.error(
                        "Failed to connect to IB Gateway for clientId %s: %s",
                        client_id,
                        e,
                    )

            if not self._pool:
                raise ConnectionError("IB Gateway connection failed: no clients connected")

            self._ib = self._pool[0]
            return self._pick_from_pool()

    async def disconnect(self):
        """Disconnect from IB Gateway."""
        async with self._connection_lock:
            for ib in self._pool:
                if ib.isConnected():
                    ib.disconnect()
            if self._pool:
                logger.info("Disconnected from IB Gateway")
            self._pool = []
            self._ib = None
            self._pool_index = 0

    async def get_connection(self) -> IB:
        """
        Get the current IB connection, reconnecting if necessary.

        Returns:
            IB: Active IB connection
        """
        if not self._pool or not any(ib.isConnected() for ib in self._pool):
            await self.connect()
        return self._pick_from_pool()

    def is_connected(self) -> bool:
        """Check if IB Gateway is connected."""
        return any(ib.isConnected() for ib in self._pool)

    @property
    def active_port(self) -> int:
        return self._active_port if self._active_port is not None else settings.IB_PORT

    @property
    def active_mode(self) -> str:
        return "paper" if self.active_port == PAPER_PORT else "live"

    async def switch_port(self, new_port: int) -> None:
        """Disconnect, update the active port, then reconnect."""
        await self.disconnect()
        self._active_port = new_port
        await self.connect()

    async def get_primary_connection(self) -> IB:
        """Get the primary (first) IB client.

        Portfolio data and account updates are only pushed to the client
        that placed the order or explicitly subscribed. Using a stable
        primary client for portfolio reads avoids round-robin misses.
        """
        if not self._pool or not any(ib.isConnected() for ib in self._pool):
            await self.connect()
        if self._pool and self._pool[0].isConnected():
            return self._pool[0]
        # Fallback: return any connected client
        return self._pick_from_pool()

    def _pick_from_pool(self) -> IB:
        if not self._pool:
            raise ConnectionError("IB Gateway connection failed: pool is empty")
        start_index = self._pool_index
        for _ in range(len(self._pool)):
            ib = self._pool[self._pool_index % len(self._pool)]
            self._pool_index = (self._pool_index + 1) % len(self._pool)
            if ib.isConnected():
                return ib
        self._pool_index = start_index
        raise ConnectionError("IB Gateway connection failed: no connected clients")


# Global singleton instance
ib_manager = IBGatewayManager()
