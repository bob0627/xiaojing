#!/usr/bin/env bash
# 检查 Key 是否可用：百度地点检索 1 次 + 大模型 1 次（千帆 ERNIE 优先，其次 OpenAI）。
# 只打印 OK/FAIL 和状态码，绝不打印 Key。用法：bash scripts/check-keys.sh
set -uo pipefail
python3 - <<'PY'
import json, os, urllib.request, urllib.parse, urllib.error, time
def req(url, data=None, headers=None, timeout=30):
    r = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp: return resp.status, resp.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e: return e.code, e.read().decode('utf-8', 'replace')
    except Exception as e: return -1, str(e)
rc = 0
# 1) 百度地图 · 地点检索 v2（服务端 AK）
ak = os.environ.get('BAIDU_MAP_AK', '')
if not ak:
    print('SKIP  百度地图 place/v2/search：未设置 BAIDU_MAP_AK')
else:
    q = urllib.parse.urlencode({'query': '酒店', 'location': '31.2285,121.4565', 'radius': 1000, 'output': 'json', 'page_size': 1, 'ak': ak})
    t = time.time(); code, body = req('https://api.map.baidu.com/place/v2/search?' + q)
    try: j = json.loads(body)
    except Exception: j = {'status': 'non-json', 'message': body[:80]}
    st = j.get('status'); ok = code == 200 and str(st) == '0'
    msg = (j.get('message') or j.get('msg') or '').replace(ak, '***')
    print(f"{'OK  ' if ok else 'FAIL'}  百度地图 place/v2/search：HTTP {code} · status {st}{' · ' + msg if msg else ''}{' · 返回 ' + str(len(j.get('results', []))) + ' 条' if ok else ''} · {int((time.time()-t)*1000)}ms")
    if not ok:
        rc = 1
        if str(st) == '240': print('      → 到 百度地图开放平台 控制台 → 应用管理 → 该 AK → 勾选「地点检索 / 路线规划 / 批量算路 / 地理编码」服务')
        if str(st) in ('210', '102'): print('      → AK 的 IP 白名单不包含本机出口 IP（或填 0.0.0.0/0 测试）')
        if str(st) == '220': print('      → 这是浏览器端 AK；后端需要「服务端」类型 AK')
# 2) 大模型
qf, oa = os.environ.get('QIANFAN_API_KEY', ''), os.environ.get('OPENAI_API_KEY', '')
force = os.environ.get('LLM_PROVIDER', '').lower()
if qf and force in ('', 'qianfan'):
    name, base, key, model = '千帆 · 文心 ERNIE', os.environ.get('QIANFAN_BASE_URL', 'https://qianfan.baidubce.com/v2'), qf, os.environ.get('QIANFAN_MODEL', 'ernie-4.5-turbo-128k')
elif oa:
    name, base, key, model = 'OpenAI', os.environ.get('OPENAI_BASE_URL', 'https://api.openai.com/v1'), oa, os.environ.get('OPENAI_MODEL', 'gpt-4o-mini')
else:
    name = None
if not name:
    print('SKIP  大模型：未设置 QIANFAN_API_KEY / OPENAI_API_KEY')
else:
    data = json.dumps({'model': model, 'messages': [{'role': 'user', 'content': '只回复 JSON：{"ok": true}'}], 'response_format': {'type': 'json_object'}, 'max_tokens': 20}).encode()
    t = time.time(); code, body = req(base.rstrip('/') + '/chat/completions', data, {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key}, 60)
    try: j = json.loads(body)
    except Exception: j = {}
    content = ((j.get('choices') or [{}])[0].get('message') or {}).get('content', '')
    err = j.get('error') or {}
    err = (err.get('message') or err.get('code') or '') if isinstance(err, dict) else str(err)
    ok = code == 200 and bool(content) and not err
    print(f"{'OK  ' if ok else 'FAIL'}  {name} chat/completions（{model}）：HTTP {code}{' · ' + str(err).replace(key, '***')[:160] if err else ''}{' · 回复 ' + content.strip()[:40] if ok else ''} · {int((time.time()-t)*1000)}ms")
    if not ok: rc = 1
print('浏览器端 AK：' + ('已设置（JS 地图需在浏览器里看是否加载成功）' if os.environ.get('BAIDU_MAP_BROWSER_AK') else '未设置（地图用 SVG 示意底图）'))
raise SystemExit(rc)
PY
