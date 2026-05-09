#!/bin/bash

# Start backend development server

echo "========================================"
echo "Starting Trading Platform Backend"
echo "========================================"
echo ""

cd "$(dirname "$0")/backend"

find_python_cmd() {
    for cmd in /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11 /opt/homebrew/bin/python3.10 python3.12 python3.11 python3.10; do
        if [ -x "$cmd" ] && "$cmd" -c 'import sys; raise SystemExit(0 if (3, 10) <= sys.version_info[:2] <= (3, 12) else 1)' 2>/dev/null; then
            echo "$cmd"
            return 0
        fi
    done
    return 1
}

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    PYTHON_CMD="$(find_python_cmd)" || {
        echo "❌ Could not find Python 3.10-3.12 on this machine."
        echo "   This backend currently depends on packages that do not install cleanly on Python 3.14."
        exit 1
    }
    echo "📦 Creating virtual environment with $("$PYTHON_CMD" --version 2>&1)..."
    "$PYTHON_CMD" -m venv venv
    echo "✅ Virtual environment created"
fi

# Ensure the existing virtual environment is using a compatible Python version
if ! venv/bin/python -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'; then
    echo ""
    echo "❌ Incompatible Python in backend/venv"
    echo "   Found: $(venv/bin/python --version 2>&1)"
    echo "   Required: Python 3.10+"
    echo ""
    echo "Recreate the virtual environment with Python 3.10-3.12, for example:"
    echo "  cd op3/backend"
    echo "  rm -rf venv"
    echo "  /opt/homebrew/bin/python3.12 -m venv venv"
    echo "  source venv/bin/activate"
    echo "  pip install -r requirements.txt"
    exit 1
fi

# Activate virtual environment
echo "🔧 Activating virtual environment..."
source venv/bin/activate

# Install dependencies if needed
if [ ! -f "venv/.installed" ]; then
    echo ""
    echo "📥 Installing dependencies (this may take 2-5 minutes)..."
    echo "   Please wait while we download and install packages..."
    pip install --upgrade pip -q
    pip install -r requirements.txt
    touch venv/.installed
    echo "✅ Dependencies installed successfully"
fi

# Start server
echo ""
echo "========================================"
echo "🚀 Starting FastAPI backend..."
echo "========================================"
echo "📍 Backend API: http://localhost:8000"
echo "📚 API Docs: http://localhost:8000/docs"
echo "❤️  Health Check: http://localhost:8000/health"
echo ""
echo "⚠️  Make sure IB Gateway is running on port 4002 for paper trading"
echo ""
echo "Press Ctrl+C to stop the server"
echo "========================================"
echo ""

python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
