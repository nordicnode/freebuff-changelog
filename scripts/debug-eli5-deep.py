#!/usr/bin/env python3
"""Deep dive into ELI5 eligibility failures."""
import json
import re

with open('data/changelog.json', 'r') as f:
    changelog_data = json.load(f)

entries = changelog_data.get('entries') or changelog_data.get('rows', [])
print(f"🔍 Deep ELI5 Analysis")
print(f"Total entries: {len(entries):,}\n")

# Check what fields exist in partial AI data
ai_field_patterns = {}
sample_incomplete = []

for entry in entries:
    ai = entry.get('ai')
    if not ai:
        continue
    
    has_title = bool(ai.get('title'))
    has_summary = bool(ai.get('summary'))
    has_eli5 = bool(ai.get('eli5'))
    
    # Count field combinations
    combo = tuple(sorted([k for k, v in [('title', has_title), ('summary', has_summary), ('eli5', has_eli5)] if v]))
    key = 'none' if len(combo) == 0 else '-'.join(combo)
    ai_field_patterns[key] = ai_field_patterns.get(key, 0) + 1
    
    # Sample some incomplete ones
    if not has_eli5 and has_title and has_summary:
        if len(sample_incomplete) < 10:
            sample_incomplete.append({
                'sha': entry['sha'][:12],
                'date': entry.get('date', '')[:10],
                'title': ai.get('title', '')[:60],
                'has_eli5_v': bool(eli5 := ai.get('eli5')) and isinstance(eli5, dict) and eli5.get('v'),
                'ai_object_type': str(type(ai)),
            })

print("=== AI FIELD COMBINATIONS ===")
for key, count in sorted(ai_field_patterns.items(), key=lambda x: -x[1]):
    print(f"{key:>20}: {count:,} ({count/len(entries)*100:>5.2f}%)")

print("\n" + "=" * 80)
print("Sample entries with title+summary but NO eli5:")
for item in sample_incomplete:
    print(f"\n  SHA: {item['sha']}")
    print(f"  Date: {item['date']}")
    print(f"  Title: {item['title']}...")
    print(f"  Has eli5.v field: {item['has_eli5_v']}")
    print(f"  Full ai object preview:")
    print(f"  {json.dumps(item, indent=4)}")

# Check if any entries HAVE an eli5 field at all
any_with_eli5 = [e for e in entries if e.get('ai', {}).get('eli5')]
print(f"\n\n✅ Entries WITH complete eli5: {len(any_with_eli5)}")
if any_with_eli5:
    e = any_with_eli5[0]
    print(f"Example:")
    print(f"  SHA: {e['sha'][:12]}")
    print(f"  Title: {e['ai']['title']}")
    print(f"  Summary: {e['ai']['summary'][:80]}...")
    print(f"  ELI5: {e['ai']['eli5'].get('text', 'MISSING TEXT')}")
    print(f"  ELI5 metadata: {json.dumps(e['ai']['eli5'], indent=4)}")
