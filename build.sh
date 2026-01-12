#!/bin/bash
set -e

echo "🔨 Building SpotiFLAC..."

# Check prerequisites
if ! command -v go &> /dev/null; then
    echo "❌ Go is not installed"
    exit 1
fi

if ! command -v pnpm &> /dev/null; then
    echo "❌ pnpm is not installed"
    exit 1
fi

WAILS_CMD="$HOME/go/bin/wails"
if [ ! -f "$WAILS_CMD" ]; then
    echo "📦 Installing Wails CLI..."
    go install github.com/wailsapp/wails/v2/cmd/wails@latest
fi

# Navigate to project root
cd "$(dirname "$0")"

echo "📝 Generating bindings..."
$WAILS_CMD generate module

echo "📦 Installing frontend dependencies..."
cd frontend
pnpm install

echo "🏗️  Building frontend..."
pnpm run build

echo "🔨 Building application..."
cd ..
$WAILS_CMD build -platform linux/amd64

echo "✅ Build complete! Executable: build/bin/SpotiFLAC"
echo "📊 File size: $(ls -lh build/bin/SpotiFLAC | awk '{print $5}')"

