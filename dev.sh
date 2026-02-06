#!/bin/bash

# SpotiFLAC Development Runner
# This script runs the app in dev mode with full terminal output
# so you can see crash logs and errors directly

set -e

cd "$(dirname "$0")"

echo "🚀 Starting SpotiFLAC in development mode..."
echo "📋 All logs will appear in this terminal"
echo "🛑 Press Ctrl+C to stop"
echo ""
echo "================================================"
echo ""

# Check if wails is installed
WAILS_CMD="$HOME/go/bin/wails"
if [ ! -f "$WAILS_CMD" ]; then
    echo "❌ Wails CLI not found. Installing..."
    go install github.com/wailsapp/wails/v2/cmd/wails@latest
fi

# Run in dev mode with verbose logging
$WAILS_CMD dev -loglevel debug
