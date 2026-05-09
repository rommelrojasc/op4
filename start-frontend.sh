#!/bin/bash

# Start frontend development server

cd "$(dirname "$0")/frontend"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Start development server
echo "Starting React frontend on http://localhost:3000"
npm run dev
