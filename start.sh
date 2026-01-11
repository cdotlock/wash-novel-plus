#!/bin/bash
# Wash 2.0 Startup Script
# 使用方法: ./start.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🚀 Starting Wash 2.0 System..."

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker first."
    exit 1
fi

# Start Docker services if not running
echo "📦 Checking Docker services..."
docker-compose up -d

# Wait for services to be healthy
echo "⏳ Waiting for PostgreSQL..."
until docker exec wash-postgres pg_isready -U wash > /dev/null 2>&1; do
    sleep 1
done
echo "✅ PostgreSQL is ready"

echo "⏳ Waiting for Redis..."
until docker exec wash-redis redis-cli ping > /dev/null 2>&1; do
    sleep 1
done
echo "✅ Redis is ready"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Generate Prisma client if needed
if [ ! -d "node_modules/.prisma" ]; then
    echo "🔧 Generating Prisma client..."
    npx prisma generate
fi

# Push database schema
echo "🗄️ Syncing database schema..."
npx prisma db push --accept-data-loss 2>/dev/null || true

# Start services in background
echo ""
# Start Frontend in background
echo "🌐 Starting Frontend..."
cd web-ui && npm run dev &
FRONTEND_PID=$!

# Start Backend
echo "🌐 Starting API Server..."
npm run dev &
API_PID=$!

sleep 2

echo "⚙️ Starting Workers..."
npm run worker:dev &
WORKER_PID=$!

echo ""
echo "════════════════════════════════════════════════════════"
echo "  ✅ Wash 2.0 System Running!"
echo "════════════════════════════════════════════════════════"
echo ""
echo "  🌐 API Server:    http://localhost:3000"
echo "  📋 Health Check:  http://localhost:3000/health"
echo ""
echo "  Press Ctrl+C to stop all services"
echo ""
echo "════════════════════════════════════════════════════════"

# Handle Ctrl+C
cleanup() {
    echo ""
    echo "🛑 Stopping services..."
    kill $API_PID 2>/dev/null || true
    kill $WORKER_PID 2>/dev/null || true
    echo "👋 Goodbye!"
    exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for processes
wait
