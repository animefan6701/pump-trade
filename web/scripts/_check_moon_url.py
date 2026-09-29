from pathlib import Path
import re
import sys

p = Path(sys.argv[1])
t = p.read_text(encoding="utf-8", errors="ignore")
print("len", len(t))
needles = [
    "Mooncat",
    "MCAT",
    "241aTY",
    "Trading made simple",
    "latest coins",
    "og:url",
    "og:title",
]
for s in needles:
    print(s, t.lower().find(s.lower()))
for m in re.finditer(r"<title[^>]*>([^<]+)", t):
    print("title", m.group(1))
for m in re.finditer(r'property="og:([^"]+)"[^>]*content="([^"]+)"', t):
    print("og", m.group(1), m.group(2)[:180])
print("canonical", re.findall(r'rel="canonical"[^>]*href="([^"]+)"', t)[:3])
