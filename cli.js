#!/usr/bin/env node
// Per-app App Store keyword snapshot on the PeekPanda API. Node 18+, no dependencies.
// Calls GET /v1/competitors/ios/{storeId}/aso once per app.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { toReport, toMarkdown, toCsv, toChat, diff } from './aso.js';

const HELP = `Usage:
  PEEKPANDA_TOKEN=... node cli.js --app <storeId|App Store link>[,...] [options]
  node cli.js --file responses.json [options]

Options:
  --app <ids>              one or more App Store ids or apps.apple.com links, comma separated (one API call each)
  --top <n>                searches per app in Markdown (default 15; CSV and JSON keep every row)
  --state <path>           compare with the report saved at this path (new, gone and moved searches), then save this run there
  --archive <dir>          also save this run as <dir>/aso-<latest observed day>.json
  --format md|csv|json     output format (default md; json is this tool's report, which --file and --state accept)
  --webhook <url>          also POST a short summary to a Slack or Discord incoming webhook
  --tenancy <value>        x-genviral-tenancy header (default personal)
  --api <url>              API base (default https://api.peekpanda.com)
  --file <path>            read saved responses (one, an array, or a saved report) instead of calling the API

Positions are observed US English search-result order, not native App Store rank.`;

function parse(argv) {
  const o = { format: 'md', tenancy: 'personal', api: 'https://api.peekpanda.com', top: '15' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
    else throw new Error(`Unexpected argument "${a}". See --help.`);
  }
  return o;
}

// Accepts 1234567890 or https://apps.apple.com/us/app/name/id1234567890
function storeIdOf(s) {
  const t = String(s).trim();
  if (/^\d+$/.test(t)) return t;
  const m = t.match(/\/id(\d+)/);
  if (m) return m[1];
  throw new Error(`"${t}" is not an App Store id or apps.apple.com link`);
}

async function getAso(o, storeId, retried = false) {
  const token = process.env.PEEKPANDA_TOKEN;
  if (!token) throw new Error('Set PEEKPANDA_TOKEN to a PeekPanda API key (Account → API keys). Never commit it.');
  const url = new URL(`/v1/competitors/ios/${storeId}/aso`, o.api);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'x-genviral-tenancy': o.tenancy, Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const code = body?.error?.code ?? '';
    const retry = Number(res.headers.get('retry-after'));
    // 429 rate_limited: honor a short Retry-After once. daily_call_limit: the plan's calls are used until 00:00 UTC, so stop.
    if (res.status === 429 && code !== 'daily_call_limit' && !retried && retry > 0 && retry <= 60) {
      await new Promise((r) => setTimeout(r, retry * 1000));
      return getAso(o, storeId, true);
    }
    throw new Error(`PeekPanda API ${res.status} ${code} (app ${storeId}): ${body?.error?.message ?? res.statusText}`);
  }
  return res.json();
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.help) { console.log(HELP); return; }
  const top = Number(o.top);
  if (!Number.isInteger(top) || top < 1) throw new Error('--top must be a whole number of 1 or more');
  if (!['md', 'csv', 'json'].includes(o.format)) throw new Error('--format must be md, csv or json');

  let input;
  if (o.file) input = JSON.parse(await readFile(o.file, 'utf8'));
  else {
    if (!o.app) throw new Error('Pass --app with one or more App Store ids or links, or --file. See --help.');
    const ids = [...new Set(o.app.split(',').filter((s) => s.trim()).map(storeIdOf))];
    if (ids.length > 30) console.error(`Note: this run makes ${ids.length} API calls. The Peek plan allows 30 a day, Panda 1,000 (shared with MCP).`);
    input = [];
    for (const id of ids) input.push(await getAso(o, id));
  }
  const report = toReport(input, { fetchedAt: o.file ? null : new Date().toISOString() });

  let d = null;
  if (o.state) {
    const prev = await readFile(o.state, 'utf8').then(JSON.parse).catch(() => null);
    d = diff(report, prev);
    await writeFile(o.state, JSON.stringify(report, null, 2));
  }
  if (o.archive) {
    await mkdir(o.archive, { recursive: true });
    const latest = report.apps.map((a) => a.coverage?.latestObservedAt).filter(Boolean).sort().pop()?.slice(0, 10) ?? 'unknown';
    await writeFile(join(o.archive, `aso-${latest}.json`), JSON.stringify(report, null, 2));
  }

  if (o.format === 'json') console.log(JSON.stringify(report, null, 2));
  else if (o.format === 'csv') console.log(toCsv(report));
  else console.log(toMarkdown(report, d, top) + '\n\nPositions are observed US English search-result order, not native App Store rank. Popularity is Apple\'s weekly score (1-100, tier 1-5) or, where Apple reports nothing, PeekPanda\'s estimate tier; neither is a search count. Difficulty and opportunity are directional. A dash means unavailable, not zero.');

  if (o.webhook) {
    const text = toChat(report, d);
    const isDiscord = /discord(app)?\.com\/api\/webhooks/.test(o.webhook);
    const r = await fetch(o.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(isDiscord ? { content: text.slice(0, 1900) } : { text }) });
    if (!r.ok) throw new Error(`Webhook returned ${r.status}`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
