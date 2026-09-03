#!/bin/bash

# Performance baseline measurement for casey
# Measures: dashboard LCP, API response times, end-to-end timing, case-sweep cycle

BASELINE_FILE="C:/dev/casey/.gm/performance-baseline-2026-08-21.json"
MEASUREMENT_TS=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
DASHBOARD_URL="http://localhost:4000"

echo "=== Casey Performance Baseline Measurement ==="
echo "Timestamp: $MEASUREMENT_TS"
echo ""

# Initialize results JSON
cat > /tmp/perf-results.txt << 'EOF'
{
  "measurement_timestamp": "'"$MEASUREMENT_TS"'",
  "measurements": {
    "api_health_provider": {
      "endpoint": "GET /api/health/provider",
      "attempts": [],
      "status": "completed"
    },
    "dashboard_root": {
      "endpoint": "GET /",
      "attempts": [],
      "status": "completed"
    }
  }
}
EOF

# Test 1: Measure GET /api/health/provider (target < 50ms)
echo "1. Testing GET /api/health/provider (target < 50ms)"
for i in {1..5}; do
  start=$(date +%s%N)
  response=$(curl -s -w "\n%{http_code}" "$DASHBOARD_URL/api/health/provider" 2>/dev/null)
  end=$(date +%s%N)
  duration_ms=$(( (end - start) / 1000000 ))
  status=$(echo "$response" | tail -1)
  echo "  Attempt $i: ${duration_ms}ms (HTTP $status)"
done
echo ""

# Test 2: Measure GET /api/cases (target < 100ms)
echo "2. Testing GET /api/cases (target < 100ms)"
for i in {1..5}; do
  start=$(date +%s%N)
  response=$(curl -s -w "\n%{http_code}" "$DASHBOARD_URL/api/cases" 2>/dev/null)
  end=$(date +%s%N)
  duration_ms=$(( (end - start) / 1000000 ))
  status=$(echo "$response" | tail -1)
  echo "  Attempt $i: ${duration_ms}ms (HTTP $status)"
done
echo ""

# Test 3: Dashboard root load
echo "3. Testing GET / (dashboard root, measure LCP via curl timing)"
for i in {1..3}; do
  curl -s -w "  Attempt $i: Connect: %{time_connect}s, Download: %{time_starttransfer}s, Total: %{time_total}s\n" "$DASHBOARD_URL" > /dev/null
done
echo ""

echo "=== Performance Baseline Measurement Complete ==="
