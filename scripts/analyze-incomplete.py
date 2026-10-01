#!/usr/bin/env python3
"""Analyze changelog entries for incomplete LLM generation."""
import json
from pathlib import Path

# Load changelog
with open('data/changelog.json', 'r') as f:
    changelog_data = json.load(f)

entries = changelog_data.get('entries') or changelog_data.get('rows', [])
print(f"\n📊 Changelog Analysis Report")
print(f"Total entries: {len(entries):,}")
print(f"Generated at: {changelog_data.get('generatedAt')}")
print(f"Head SHA: {changelog_data.get('headSha')}\n")

categories = {
    'no_ai': 0,           # No AI data at all
    'partial': 0,         # Some but not all fields present
    'full': 0,            # Complete title + summary + eli5
}

missing_only_fields = {
    'title_and_summary_no_eli5': [],
    'just_title': [],
    'just_summary': [],
    'just_eli5': []
}

for entry in entries:
    ai = entry.get('ai')
    has_title = bool(ai and ai.get('title'))
    has_summary = bool(ai and ai.get('summary'))
    has_eli5 = bool(entry.get('eli5') and entry['eli5'].get('text'))
    
    if not ai:
        categories['no_ai'] += 1
        continue
    
    if has_title and has_summary and has_eli5:
        categories['full'] += 1
    else:
        categories['partial'] += 1
        
        if has_title and has_summary and not has_eli5:
            missing_only_fields['title_and_summary_no_eli5'].append({
                'sha': entry['sha'][:12],
                'title': ai['title'],
                'date': entry.get('date', '')[:10]
            })
        elif has_title and not has_summary and not has_eli5:
            missing_only_fields['just_title'].append(entry['sha'][:12])
        elif has_summary and not has_title and not has_eli5:
            missing_only_fields['just_summary'].append(entry['sha'][:12])

# Calculate percentages
total = len(entries)
pct_full = (categories['full'] / total * 100) if total > 0 else 0
pct_partial = (categories['partial'] / total * 100) if total > 0 else 0
pct_no_ai = (categories['no_ai'] / total * 100) if total > 0 else 0

print("=" * 60)
print("=== CATEGORIES ===")
print(f"✓ Full (title+summary+eli5):     {categories['full']:>10,} ({pct_full:>6.2f}%)")
print(f"✗ Partial/Incomplete:            {categories['partial']:>10,} ({pct_partial:>6.2f}%)")
print(f"  └─ Missing ELI5 only:          {len(missing_only_fields['title_and_summary_no_eli5']):>10,}")
print(f"✗ No AI data:                    {categories['no_ai']:>10,} ({pct_no_ai:>6.2f}%)\n")

print("=== MISSING-ONLY BREAKDOWN ===")
title_sum_eli5_list = missing_only_fields['title_and_summary_no_eli5']
print(f"📝 Only missing ELI5 (title+summary): {len(title_sum_eli5_list)} examples:")
for item in title_sum_eli5_list[:10]:
    print(f"  • {item['sha']} - {item['title'][:80]}... ({item['date']})")

print("\n✅ Sample complete entries:")
completed = [e for e in entries if e.get('ai', {}).get('title') and e.get('ai', {}).get('summary') and e.get('eli5') and e.get('eli5', {}).get('text')][:2]
if completed:
    for e in completed:
        print(f"  • {e['sha'][:12]}: {e['ai']['title']}")
        print(f"    Eli5: {e['eli5']['text'][:100]}...")
else:
    print("  None found!")

# Check ai-summaries cache
try:
    with open('data/ai-summaries.json', 'r') as f:
        cache_data = json.load(f)
    print(f"\n🗃️ Cache Stats: {len(cache_data):,} cached entries\n")
    
    # Count error entries
    error_count = 0
    transient_count = 0
    permanent_count = 0
    
    for key, val in cache_data.items():
        if isinstance(val, dict) and val.get('error'):
            error_count += 1
            if val.get('transient'):
                transient_count += 1
            else:
                permanent_count += 1
    
    print("Cache errors:")
    print(f"  Total errors:        {error_count:,}")
    print(f"  Transient (retryable): {transient_count:,}")
    print(f"  Permanent:           {permanent_count:,}\n")
    
    if transient_count > 0:
        print("Sample transient errors (should be retriable after 5 min cooldown):")
        sample_errors = [(k, v) for k, v in cache_data.items() 
                        if isinstance(v, dict) and v.get('error') and v.get('transient')][:3]
        for key, val in sample_errors:
            err_msg = val.get('error', '')[:100]
            print(f"  • {key[:40]}...: {err_msg}")
    
    if permanent_count > 0:
        print(f"\n⚠️ Permanent errors detected (parked on 1-hour cooldown):")
        perm_sample = [(k, v) for k, v in cache_data.items() 
                      if isinstance(v, dict) and v.get('error') and not v.get('transient')][:3]
        for key, val in perm_sample:
            err_msg = val.get('error', '')[:100]
            det_str = " [DETERMINISTIC]" if val.get('deterministic') else ""
            print(f"  • {key[:40]}...{det_str}: {err_msg}")
            
except Exception as err:
    print(f"❌ Could not read ai-summaries.json: {err}\n")

# Summary and recommendations
print("=" * 60)
print("=== RECOMMENDATIONS ===")
if pct_partial > 10 or categories['no_ai'] > 0:
    print("🚨 Significant issues detected!")
    print()
    if categories['no_ai'] > 0:
        print(f"• {categories['no_ai']:,} entries have NO AI data at all")
        print("  → Run: npm run generate (ensures baseline enrichment)")
    if len(title_sum_eli5_list) > 0:
        print(f"• {len(title_sum_eli5_list):,} entries have title+summary but missing ELI5")
        print("  → This is likely due to:")
        print("    - Gateway failures (3 consecutive 5xx skipped rest of queue)")
        print("    - Request budget exhaustion (summary pass consumed cycle budget)")
        print("    - Deterministic model refusals (need prompt version bump)")
        print()
        print("  → FIX OPTIONS:")
        print("    1. Increase limits: Set CHANGELOG_LLM_LIMIT=50 CHANGELOG_LLM_CONCURRENCY=4")
        print("    2. Force retry: rm .cache/generator.lock; npm run backfill")
        print("    3. Check provider health: Verify LLM_API_KEY and endpoint uptime")
        print("    4. Escalate determinism: Change PROMPT_V or use enrich-all --rewrite-stale")
else:
    print("✓ Changelog entries look healthy (>90% complete)")
