#!/usr/bin/env python3
# Quick test to simulate the bug pattern

class Entry:
    def __init__(self, sha):
        self.sha = sha
        self.ai = {}

# Simulate reading changelog
entries = [Entry(f"abc{idx:08x}") for idx in range(5)]
existing = [{"sha": e.sha, "ai": e.ai.copy()} for e in entries]  # Deep copy would be better

print("Before enrichment:")
print(f"  entries[0].ai = {entries[0].ai}")
print(f"  existing[0]['ai'] = {existing[0]['ai']}")

# Simulate enriching entries in-place
for i, e in enumerate(entries[:3]):
    e.ai['title'] = f"Title {i}"
    e.ai['summary'] = f"Summary {i}"

print("\nAfter entry enrichment:")
print(f"  entries[0].ai = {entries[0].ai}")
print(f"  existing[0]['ai'] = {existing[0]['ai']} (STALE!)")

# Now try to add eli5 to entries
for e in entries[:3]:
    e.ai['eli5'] = f"Eli5 {e.sha}"

print("\nAfter ELI5 enrichment:")
print(f"  entries[0].ai = {entries[0].ai} (has eli5)")
print(f"  existing[0]['ai'] = {existing[0]['ai']} (NO eli5 - BUG!)")

print("\nBug confirmed: persisting 'existing' drops all changes!")
