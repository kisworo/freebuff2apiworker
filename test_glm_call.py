import urllib.request, json

# Read API key
with open('/home/ubuntu/freebuff2apiworker/.dev.vars') as f:
    for line in f:
        if line.startswith('FREEBUFF_API_KEY='):
            key = line.split('=', 1)[1].strip()
            break

# Test GLM-5.2
url = "https://buff.eyasin.com/v1/chat/completions"
payload = json.dumps({
    "model": "z-ai/glm-5.2",
    "messages": [{"role": "user", "content": "Halo, balas 1 kata"}],
    "max_tokens": 20
}).encode()

req = urllib.request.Request(url, data=payload, headers={
    "Authorization": f"Bearer {key}",
    "Content-Type": "application/json",
})

try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
        print(f"Status: {resp.status}")
        print(f"Response: {json.dumps(data, indent=2, ensure_ascii=False)}")
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print(f"Error {e.code}:")
    print(body)
except Exception as e:
    print(f"Error: {e}")
