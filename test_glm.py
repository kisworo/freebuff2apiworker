import subprocess
import json

# Read token
with open('/home/ubuntu/freebuff2apiworker/.dev.vars') as f:
    for line in f:
        if line.startswith('FREEBUFF_TOKEN='):
            token = line.split('=')[1].strip().split(',')[0].strip()
            break

print(f"Token: {token[:8]}...")

# 1. Try creating a session with z-ai/glm-5.2 directly via Codebuff
url = "https://www.codebuff.com/api/v1/freebuff/session"
headers = {
    "Authorization": f"Bearer {token}",
    "x-freebuff-model": "z-ai/glm-5.2",
    "Accept": "*/*",
    "User-Agent": "Bun/1.3.11",
    "Content-Type": "application/json",
}

import urllib.request
req = urllib.request.Request(url, data=b"{}", headers=headers, method="POST")
try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())
        print(f"\n=== Session create response ===")
        print(f"Status: {resp.status}")
        print(json.dumps(data, indent=2))
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print(f"\n=== Error {e.code} ===")
    print(body)
except Exception as e:
    print(f"\n=== Error ===")
    print(str(e))

# 2. Also try with a known-working model for comparison
req2 = urllib.request.Request(url, data=b"{}", headers={
    "Authorization": f"Bearer {token}",
    "x-freebuff-model": "deepseek/deepseek-v4-flash",
    "Accept": "*/*",
    "User-Agent": "Bun/1.3.11",
    "Content-Type": "application/json",
}, method="POST")
try:
    with urllib.request.urlopen(req2, timeout=15) as resp:
        data = json.loads(resp.read())
        print(f"\n=== Known model (deepseek) response ===")
        print(json.dumps(data, indent=2))
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print(f"\n=== Known model Error {e.code} ===")
    print(body)
except Exception as e:
    print(f"\n=== Known model Error ===")
    print(str(e))
