"""FastAPI application entry point."""
import logging
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.services.ib.gateway import ib_manager
from app.services.ib.trading import start_account_summary_listener, stop_account_summary_listener
from app.services.auto_trader import auto_trader
from app.api.v1 import market_data
from app.api.v1 import alerts
from app.models.schemas import HealthResponse

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan events."""
    # Startup
    logger.info("Starting application...")
    try:
        await ib_manager.connect()
        logger.info("IB Gateway connection established")
        asyncio.create_task(start_account_summary_listener())
    except Exception as e:
        logger.error(f"Failed to connect to IB Gateway on startup: {e}")
        logger.warning("Application will continue, but IB features may not work")

    yield

    # Shutdown
    logger.info("Shutting down application...")
    if auto_trader.status().get("running"):
        await auto_trader.stop()
    await stop_account_summary_listener()
    await ib_manager.disconnect()
    logger.info("Application shutdown complete")


# Create FastAPI app
app = FastAPI(
    title=settings.PROJECT_NAME,
    version="1.0.0",
    description="TradingView-style trading platform API",
    lifespan=lifespan,
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(market_data.router, prefix=settings.API_V1_PREFIX)
app.include_router(alerts.router, prefix=settings.API_V1_PREFIX)


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint."""
    is_connected = ib_manager.is_connected()
    return HealthResponse(
        status="healthy" if is_connected else "degraded",
        ib_connected=is_connected,
        message="IB Gateway connected" if is_connected else "IB Gateway not connected",
    )


@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "name": settings.PROJECT_NAME,
        "version": "1.0.0",
        "status": "running",
        "docs": "/docs",
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info",
    )
