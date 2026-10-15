---
title: "Benchmarks"
description: "How to run the performance benchmark suite and interpret its results."
---

::: v-pre

# Benchmarks

```bash
npm run build -w @testpion/shared -w @testpion/core
npm run bench                               # 10,000 HTTP tests, 100 workers
npm run bench -- --tests 100000 --workers 200 --records 1000000
```

The benchmark reports total duration, tests per second, p50/p95/p99, failures, peak memory, peak CPU, dataset streaming rate and large-JSON parse time.

Reference run (8-core laptop, Node 26):

| Metric | Value |
|---|---|
| 10,000 HTTP tests, 100 workers | 3.3 s (≈3,000 tests/s), 0 failures |
| p50 / p95 / p99 | 18 / 37 / 75 ms |
| Peak memory | ≈290 MB |
| Dataset streaming | ≈570,000 JSONL records/s |

These figures are measurements from one machine, not guarantees; run the benchmark on your own hardware.

:::
