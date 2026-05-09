#!/bin/bash

# Install backend dependencies manually (with visible progress)

echo "========================================"
echo "Installing Backend Dependencies"
echo "========================================"
echo ""

cd "$(dirname "$0")/backend"

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "📦 Creating virtual environment with Python 3.11..."
    /opt/homebrew/bin/python3.11 -m venv venv
    echo "✅ Virtual environment created"
    echo ""
fi

# Activate virtual environment
echo "🔧 Activating virtual environment..."
source venv/bin/activate
echo ""

# Upgrade pip
echo "📥 Upgrading pip..."
pip install --upgrade pip
echo ""

# Install dependencies with progress
echo "📥 Installing Python packages (this will take 2-5 minutes)..."
echo "   You will see download progress below:"
echo ""
pip install -r requirements.txt --verbose

# Mark as installed
touch venv/.installed

echo ""
echo "========================================"
echo "✅ Installation Complete!"
echo "========================================"
echo ""
echo "You can now start the backend with:"
echo "  ./start-backend.sh"
echo ""
