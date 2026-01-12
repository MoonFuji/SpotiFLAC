# Build Instructions for SpotiFLAC

## Prerequisites

### Required Software

1. **Go** (version 1.25.5 or compatible)
   ```bash
   # Check if installed
   go version
   
   # If not installed, download from: https://go.dev/dl/
   ```

2. **Node.js and pnpm** (for frontend)
   ```bash
   # Check if installed
   node --version
   pnpm --version
   
   # Install pnpm if needed
   npm install -g pnpm
   ```

3. **Wails CLI**
   ```bash
   # Install Wails CLI
   go install github.com/wailsapp/wails/v2/cmd/wails@latest
   
   # Verify installation (should be in ~/go/bin/wails)
   ~/go/bin/wails version
   ```

### Linux-Specific Dependencies

For building on Linux, you need GTK3 and WebKit2GTK development libraries:

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev

# Create symlink for WebKit compatibility (if needed)
sudo ln -sf /usr/lib/x86_64-linux-gnu/pkgconfig/webkit2gtk-4.1.pc \
            /usr/lib/x86_64-linux-gnu/pkgconfig/webkit2gtk-4.0.pc
```

---

## Build Steps

### Quick Build (All-in-One)

```bash
cd /home/mouncef/Desktop/SpotiFLAC
~/go/bin/wails build -platform linux/amd64
```

The executable will be created at: `build/bin/SpotiFLAC`

### Step-by-Step Build Process

#### 1. Generate TypeScript Bindings

```bash
cd /home/mouncef/Desktop/SpotiFLAC
~/go/bin/wails generate module
```

**What this does:**
- Generates TypeScript types from Go structs
- Creates `frontend/wailsjs/` directory with bindings
- Required before frontend can build

#### 2. Install Frontend Dependencies

```bash
cd /home/mouncef/Desktop/SpotiFLAC/frontend
pnpm install
```

**What this does:**
- Installs all npm packages
- Runs postinstall scripts (icon generation)

#### 3. Build Frontend

```bash
cd /home/mouncef/Desktop/SpotiFLAC/frontend
pnpm run build
```

**What this does:**
- Compiles TypeScript
- Bundles React app with Vite
- Creates `frontend/dist/` directory
- Output: `dist/index.html` and bundled assets

#### 4. Build Application

```bash
cd /home/mouncef/Desktop/SpotiFLAC
~/go/bin/wails build -platform linux/amd64
```

**What this does:**
- Compiles Go backend
- Embeds frontend dist files
- Links GTK/WebKit libraries
- Creates final executable

---

## Build Options

### Platform Targets

```bash
# Linux (64-bit)
~/go/bin/wails build -platform linux/amd64

# Linux (ARM64)
~/go/bin/wails build -platform linux/arm64

# Windows (64-bit)
~/go/bin/wails build -platform windows/amd64

# macOS (Intel)
~/go/bin/wails build -platform darwin/amd64

# macOS (Apple Silicon)
~/go/bin/wails build -platform darwin/arm64
```

### Other Options

```bash
# Skip frontend build (use existing dist/)
~/go/bin/wails build -skipfrontend

# Skip bindings generation
~/go/bin/wails build -skipbindings

# Clean build directory first
~/go/bin/wails build -clean

# Compress executable
~/go/bin/wails build -compress

# Development build (with devtools)
~/go/bin/wails build -dev
```

---

## Troubleshooting

### Error: "Package webkit2gtk-4.0 was not found"

**Solution:**
```bash
# Install WebKit development package
sudo apt-get install -y libwebkit2gtk-4.1-dev

# Create symlink
sudo ln -sf /usr/lib/x86_64-linux-gnu/pkgconfig/webkit2gtk-4.1.pc \
            /usr/lib/x86_64-linux-gnu/pkgconfig/webkit2gtk-4.0.pc
```

### Error: "Cannot find module '../wailsjs/go/main/App'"

**Solution:**
```bash
# Generate bindings first
~/go/bin/wails generate module
```

### Error: "pattern all:frontend/dist: no matching files found"

**Solution:**
```bash
# Build frontend first
cd frontend && pnpm run build
```

### Error: TypeScript compilation errors

**Solution:**
```bash
# Check for TypeScript errors
cd frontend
pnpm run build

# Fix any errors shown, then rebuild
```

### Error: Go compilation errors

**Solution:**
```bash
# Check Go code
go build ./...

# Fix any errors shown
```

---

## Development Workflow

### Making Changes

1. **Backend Changes (Go):**
   ```bash
   # Edit Go files in backend/ or app.go
   # Regenerate bindings
   ~/go/bin/wails generate module
   
   # Rebuild
   ~/go/bin/wails build -platform linux/amd64
   ```

2. **Frontend Changes (TypeScript/React):**
   ```bash
   # Edit files in frontend/src/
   # Rebuild frontend
   cd frontend && pnpm run build
   
   # Rebuild app
   cd .. && ~/go/bin/wails build -platform linux/amd64
   ```

### Development Mode (Hot Reload)

For faster development with hot reload:

```bash
# Terminal 1: Start Wails dev server
~/go/bin/wails dev

# This will:
# - Watch for file changes
# - Auto-reload frontend
# - Show console output
```

---

## Build Output

After successful build:

- **Executable:** `build/bin/SpotiFLAC`
- **Size:** ~12 MB (Linux)
- **Type:** ELF 64-bit executable

### Running the App

```bash
# Make executable (if needed)
chmod +x build/bin/SpotiFLAC

# Run
./build/bin/SpotiFLAC
```

---

## Complete Build Script

Here's a complete build script you can save as `build.sh`:

```bash
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
```

Make it executable:
```bash
chmod +x build.sh
./build.sh
```

---

## Platform-Specific Notes

### Linux

- Requires GTK3 and WebKit2GTK libraries
- May need symlink for WebKit version compatibility
- Tested on Ubuntu/Debian-based systems

### Windows

- Requires Visual Studio Build Tools or MinGW
- May need additional C++ runtime libraries

### macOS

- Requires Xcode Command Line Tools
- May need to sign executable for distribution

---

## Verification

After building, verify the executable:

```bash
# Check file type
file build/bin/SpotiFLAC

# Check if executable
ls -lh build/bin/SpotiFLAC

# Test run (if in GUI environment)
./build/bin/SpotiFLAC
```

---

## Common Build Commands Reference

```bash
# Full rebuild (clean everything)
rm -rf frontend/dist build/bin
~/go/bin/wails build -platform linux/amd64 -clean

# Quick rebuild (incremental)
~/go/bin/wails build -platform linux/amd64

# Development mode
~/go/bin/wails dev

# Check for errors only
cd frontend && pnpm run build
cd .. && go build ./...
```

---

## Notes

- First build may take longer (downloading dependencies)
- Subsequent builds are faster (incremental)
- Frontend build outputs warnings about chunk size (can be ignored)
- The app embeds the frontend dist files, so frontend must be built first

