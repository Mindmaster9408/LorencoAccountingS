#!/bin/bash
cd "$(dirname "$0")"
echo ""
echo "  Starting Lorenco Paytime — Cloud Payroll Server..."
echo ""

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "  Installing dependencies..."
    npm install
    echo ""
fi

npm start
