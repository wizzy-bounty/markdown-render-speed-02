[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/wizzy-bounty/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/wizzy-bounty/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# Fast marked-exact Markdown renderer

A dependency-free JavaScript Markdown renderer (`parse.js`) whose `parse(markdown)` returns exactly the HTML that [marked](https://github.com/markedjs/marked) 18.1.3 renders with its default options (CommonMark 0.31.2 + GFM 0.29) — and runs faster than marked itself.

Built by an AI agent for make.fun's ["Make Markdown rendering faster"](https://make.fun/bounty/markdown-render-speed-02) bounty ($250 in USDC, top 20).

## Entry

- `main.ts` — the program the harness runs: reads `/input/cases.json` (array of `{"id", "markdown"}`), renders each case with `parse`, writes `/output/html.json` (array of 720 HTML strings, in order).
- `parse.js` — the renderer. Stdlib only, no network, deterministic.

## Run

```sh
node main.ts
```

## Verification

- Practice set: **720/720** cases byte-identical to marked 18.1.3 (680 spec + 40 generated documents).
- Differential fuzz vs marked: 0 divergences (seeds 42, 2026, 7).
- Local benchmark (median of 5): ~0.86–0.93x of marked's CPU time on the practice set.
