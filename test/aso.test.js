import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toReport, diff, shared, openings, climbers, fallers, toCsv, toMarkdown, toChat, popularity, popularityText, opportunity } from '../aso.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8'));
const ex = load('aso.json');
const prev = load('previous.json');

test('reads one response or several', () => {
  const rep = toReport(ex);
  assert.deepEqual(rep.apps.map((a) => a.name), ['Example Calorie Tracker', 'Example Macro Counter']);
  assert.equal(toReport(ex[0]).apps.length, 1);
  assert.equal(toReport(rep), rep); // a saved report passes through
  assert.throws(() => toReport({ hello: 1 }), /Expected GET/);
});

test('popularity: Apple score, PeekPanda estimate tier, or unavailable', () => {
  assert.deepEqual(popularity({ demand: { score: 63, tier: 3 } }).score, 63);
  const est = popularity({ demand: null, popularityEstimate: { tier: 'very_low' } });
  assert.equal(est.kind, 'estimate');
  assert.equal(popularityText(est), 'est. very low');
  assert.equal(popularityText(popularity({})), '—');
  // Opportunity only from a numeric Apple score and a difficulty.
  assert.equal(opportunity(popularity({ demand: { score: 63 } }), 71), 18);
  assert.equal(opportunity(est, 20), null);
  assert.equal(opportunity(popularity({ demand: { score: 63 } }), null), null);
});

test('moves come from the previous collection run in history', () => {
  const app = toReport(ex).apps[0];
  const ct = app.keywords.find((k) => k.query === 'calorie tracker');
  assert.equal(ct.previousPosition, 7);
  assert.equal(ct.move, 3);
  assert.equal(app.keywords.find((k) => k.query === 'meal log').move, null); // one run only
  assert.deepEqual(climbers(app).map((k) => k.query), ['food diary', 'calorie tracker', 'weight loss food log']);
  assert.deepEqual(fallers(app).map((k) => k.query), ['calorie counter']);
  assert.equal(ct.topRival.name, 'Example Food Diary Pro');
});

test('openings skip the top 10 and keywords without opportunity', () => {
  const app = toReport(ex).apps[0];
  assert.deepEqual(openings(app).map((k) => k.query), ['macro tracker', 'food diary', 'meal log']);
});

test('shared searches across apps', () => {
  const sh = shared(toReport(ex));
  assert.deepEqual(sh.map((s) => s.query), ['calorie tracker', 'macro tracker']);
  assert.equal(shared(toReport(ex[0])).length, 0);
});

test('diff: new, gone and moved searches since the saved run', () => {
  const d = diff(toReport(ex), prev);
  const a = d.apps['1000000301'];
  assert.deepEqual(a.added.map((k) => k.query), ['meal log']);
  assert.deepEqual(a.dropped.map((k) => k.query), ['diet app']);
  assert.deepEqual(a.changed.map((k) => `${k.query}:${k.from}>${k.to}`), ['calorie tracker:7>4', 'calorie counter:5>6']);
  assert.equal(diff(toReport(ex), { kind: 'peekpanda-aso-keyword-snapshot', apps: [] }).apps['1000000301'].firstRun, true);
  assert.equal(diff(toReport(ex), null), null);
});

test('markdown, csv and chat output', () => {
  const rep = toReport(ex);
  const md = toMarkdown(rep, diff(rep, prev));
  assert.match(md, /Side by side/);
  assert.match(md, /🆕 Newly observed in: "meal log" \(#17\)/);
  assert.match(md, /est\. low/);
  const csv = toCsv(rep).split('\n');
  assert.equal(csv.length, 1 + 7 + 4);
  assert.match(csv[0], /^store_id,app,query,position/);
  assert.match(toChat(rep, diff(rep, prev)), /gone: "diet app"/);
});
