---
description: Fetch and analyse top pool candidates
tags: [screening, pools, candidates]
---
Fetch top 5 enriched pool candidates:

1. Get pool candidates:
```
!`node cli.js candidates --limit 5`
```

Analyse each candidate and give a deploy recommendation (yes/no) with reasoning. Consider:
- fee/TVL ratio (higher is better, aim for >0.1)
- organic score (min 60, prefer 70+)
- bot % (reject if >30%)
- top10 holder concentration (reject if >60%)
- price trend (prefer stable or uptrending)
- volume vs TVL (higher activity is better)
- narrative strength

Rank them and suggest which (if any) to deploy into.
