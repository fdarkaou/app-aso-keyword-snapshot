# app-aso-keyword-snapshot

A keyword snapshot for one or more iOS apps. For each app it lists every US App Store search the app has been observed in, with its position, the move since the previous collection run, popularity, difficulty, opportunity and the strongest other app in that result. It picks out climbers, fallers and the best openings outside the top 10. With two or more apps (yours and your rivals) it adds a side-by-side summary and the searches more than one of them appears in. Run it weekly with `--state` and it shows which searches are new, which are gone and which moved since your last run. Output is Markdown, CSV or JSON, and it can post a short summary to Slack or Discord.

Use it to see where a rival is gaining search ground, to check a metadata change against the searches you actually show up in, or to shortlist phrases with demand that nobody strong owns yet.

Node 18+, no dependencies. There is also a [browser version](https://fdarkaou.github.io/app-aso-keyword-snapshot/) that renders pasted responses and never sends them anywhere.

```
### Example Calorie Tracker (1000000301)

7 searches observed (US, en_us), latest 2026-11-01, 12 observations. Top 3: 2, top 10: 4, top 50: 7, best #1 for "calorie tracker for teens", median #6.

🆕 Newly observed in: "meal log" (#17)
No longer observed in: "diet app" (was #38)
Position changes since last run: "calorie tracker" #7 → #4, "calorie counter" #5 → #6

Climbed since the previous collection run: "food diary" ▲6 to #12, "calorie tracker" ▲3 to #4, "weight loss food log" ▲1 to #2
Highest opportunity outside the top 10: "macro tracker" (21, #23), "food diary" (20, #12), "meal log" (15, #17)

| Search | Position | Move | Popularity | Difficulty | Opportunity | Top other app | Results | Observed |
| --- | ---: | --- | --- | ---: | ---: | --- | ---: | --- |
| calorie tracker | #4 | ▲3 | 63 (tier 3) | 71 | 18 | #1 Example Food Diary Pro (912k ratings) | 200 | 2026-11-01 |
| food diary | #12 | ▲6 | 41 (tier 3) | 52 | 20 | #1 Example Food Diary Pro (912k ratings) | 200 | 2026-11-01 |
| weight loss food log | #2 | ▲1 | est. low | 18 | — | #1 Example Meal Snap (48k ratings) | 60 | 2026-11-01 |
```

(Example data from `examples/`, not real apps.)

## Where the data comes from

The data comes from [PeekPanda](https://peekpanda.com), an iOS competitor catalogue that keeps dated App Store evidence for each app. The tool calls [`GET /v1/competitors/ios/{storeId}/aso`](https://peekpanda.com/docs/get-competitor-aso) once per app. Over MCP the same read is the `get_app` tool with action `aso`. It needs the `context:read` scope and returns stored observations: it does not start a new collection.

The fields it reads are the ones that page documents: `coverage` (searches matched, country, language, latest observation), `summary` (top 3 / top 10 / top 50 counts, best and median position), and per search `position`, `history`, `resultCount`, `apps` (the observed result with ratings), `demand`, `popularityEstimate` and `difficulty`, plus `insights`. `rivals` and `keywordIdeas` are only counted.

You need a PeekPanda account and an API key. Each app is one call against your plan's daily API and MCP allowance (30 calls a day on Peek, 1,000 on Panda, reset at 00:00 UTC).

## Use it

```bash
git clone https://github.com/fdarkaou/app-aso-keyword-snapshot && cd app-aso-keyword-snapshot
export PEEKPANDA_TOKEN=...   # API key from Account → API keys. Keep it out of source control.

node cli.js --app 1234567890                                   # one app (1 call)
node cli.js --app https://apps.apple.com/us/app/name/id1234567890,2345678901   # your app and a rival (2 calls)
node cli.js --app 1234567890 --top 40                          # more rows per app in Markdown
node cli.js --app 1234567890 --state aso-state.json            # new, gone and moved searches since the last run
node cli.js --app 1234567890 --archive history                 # also keep history/aso-<day>.json
node cli.js --app 1234567890 --format csv > aso-keywords.csv   # one row per app and search
node cli.js --app 1234567890 --webhook "$SLACK_WEBHOOK_URL"    # Discord webhook URLs work too
```

Try it without an account on the bundled example:

```bash
node cli.js --file examples/aso.json
cp examples/previous.json /tmp/state.json && node cli.js --file examples/aso.json --state /tmp/state.json
npm test
```

Options: `--app <ids or links>`, `--top <n>`, `--state <path>`, `--archive <dir>`, `--format md|csv|json`, `--webhook <url>`, `--file <path>` (one response, an array of them, or a saved report), `--tenancy`, `--api`. On a `429 rate_limited` with a short `Retry-After` it waits and retries once; on `daily_call_limit` it stops.

## Ask an assistant instead

If your assistant is connected to the PeekPanda MCP server (`https://mcp.peekpanda.com/mcp`, OAuth sign-in or an API key; see [MCP setup](https://peekpanda.com/docs/mcp)), ask it to call `get_app` once per app:

```json
{ "request": { "action": "aso", "params": { "platform": "ios", "storeId": "1234567890" } } }
```

Save the results as a JSON array and run `node cli.js --file`, or paste them into the browser version.

## How to read it

- Position is the app's place in the observed App Store Search API result for a US English search. It is not the native App Store rank and not search volume.
- Move compares the latest position with the newest earlier collection run in `history`. A search with one run shows no move; PeekPanda notes that position changes need at least two runs. `--state` compares with your own last run instead.
- Popularity is Apple's weekly search popularity for the phrase (1 to 100, with Apple's 1 to 5 tier) when PeekPanda collected it. Where Apple reports nothing, it is PeekPanda's own estimate tier ("est. low"), never a number on Apple's scale. Neither is a search count. A dash means unavailable, not zero.
- Difficulty is directional: how established the leading apps in the observed result look. Opportunity is `popularity × (100 − difficulty) ÷ 100`, as defined in [keyword metrics explained](https://peekpanda.com/docs/keyword-metrics-explained). The tool only computes it from Apple's numeric score, so searches with an estimate tier have no opportunity.
- "Top other app" is the best-placed other app in the stored result, with its rating count.
- An app with no observed searches is not proof that it ranks for nothing.

To page through every observed search with only position and popularity, see [browse observed competitor ASO keywords](https://peekpanda.com/docs/browse-competitor-aso-keywords).

## Weekly post in GitHub Actions

`.github/workflows/weekly-aso-snapshot.yml` is an example job that runs every Monday, keeps last week's report in the Actions cache, writes the snapshot to the run summary, posts a short summary to a webhook and saves a CSV and a dated history as an artifact. Add `PEEKPANDA_TOKEN` and `ASO_WEBHOOK_URL` as repository secrets, set the repository variable `ENABLE_ASO_SNAPSHOT` to `true`, and put your app and rival ids in the job.

## License

MIT
