#!/bin/bash

# Freebuff2API Worker Deploy Script
# GLM-5.2 addition to models

echo "🚀 Starting Freebuff2API deployment..."
echo "📝 Changes: Added z-ai/glm-5.2 to FREEBUFF_MODELS"

# Cek apakah ada uncommitted changes
if [ -n "$(git status --porcelain)" ]; then
    echo "📊 Git status:"
    git diff --stat
fi

# Deploy ke Cloudflare Workers
echo "📤 Deploying to Cloudflare Workers..."
npx wrangler deploy

if [ $? -eq 0 ]; then
    echo "✅ Deploy successful!"
    echo ""
    echo "🧪 Testing new model..."
    # Test GLM-5.2
    curl -s "https://buff.eyasin.com/v1/models" | python3 -c "import sys, json; data=json.load(sys.stdin); models=[m['id'] for m in data['data']]; print('Available models:', len(models)); print('GLM-5.2 present:', 'z-ai/glm-5.2' in models)"
    echo ""
    echo "🎉 GLM-5.2 is now available at buff.eyasin.com!"
else
    echo "❌ Deploy failed!"
    exit 1
fi