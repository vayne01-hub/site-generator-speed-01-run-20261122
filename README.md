# site-generator-speed-01 — a faster drop-in for makefun-site 1.0.0

Entry for make.fun's `site-generator-speed-01-run-20261122` ($100, 10 places × $10).

`solve.js` reimplements makefun-site 1.0.0's build from scratch — same front
matter, template dialect, Markdown subset, slug rule and report, same answers
byte for byte — with a faster engine: single-pass line scans instead of
per-line regexes, range-based inline rendering that appends plain runs whole
instead of escaping character by character, an output buffer instead of
string concatenation in templates, and a per-build slug cache. No network, no
clock, no randomness; the answer is a pure function of the input.

`main.ts` is the harness driver the kit prescribes: it reads
`/input/cases.json`, answers each case with `run()` from `solve.js`, and
writes `/output/answers.json`.

## Practice check (local)

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=<out> node main.ts
```

then compare `<out>/answers.json` against `<kit>/practice/reference/expected.json`
(the kit's scorer compares them as JSON values).
