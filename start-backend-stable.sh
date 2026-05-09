#!/bin/bash

echo "========================================"
echo "Starting Trading Platform Backend"
echo "========================================"
echo ""

cd "$(dirname "$0")/backend"

# Activate virtual environment
echo "🔧 Activating virtual environment..."
source venv/bin/activate

echo ""
echo "========================================"
echo "🚀 Starting FastAPI backend (no auto-reload)..."
echo "========================================"
echo "📍 Backend API: http://localhost:8000"
echo "📚 API Docs: http://localhost:8000/docs"
echo "❤️  Health Check: http://localhost:8000/health"
echo ""
echo "⚠️  Make sure IB Gateway API is configured!"
echo "    See IB_GATEWAY_SETUP.md for instructions"
echo ""
echo "Press Ctrl+C to stop the server"
echo "========================================"
echo ""

# Start without auto-reload to avoid venv watching issues
uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-reload
