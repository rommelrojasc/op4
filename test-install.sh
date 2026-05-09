#!/bin/bash

# Quick test to check Python environment

echo "Checking Python environment..."
echo ""

# Check Python version
echo "Python version:"
python3 --version
echo ""

# Check if we're in the right directory
echo "Current directory:"
pwd
echo ""

# Check if backend directory exists
if [ -d "backend" ]; then
    echo "✅ Backend directory found"
else
    echo "❌ Backend directory not found"
    exit 1
fi

# Check if venv exists
if [ -d "backend/venv" ]; then
    echo "✅ Virtual environment exists"
else
    echo "⏳ Virtual environment not created yet"
fi

echo ""
echo "Ready to install dependencies!"
echo "Run: ./install-backend.sh"
