// Pure helpers for the per-app ASO keyword snapshot. Works in Node and in the browser (index.html imports it).
// Input: GET /v1/competitors/ios/{storeId}/aso responses (one per app). Output: a dated report, Markdown, CSV, chat text, diff.

export const KIND = 'peekpanda-aso-keyword-snapshot';
const num = (v) => (Number.isFinite(v) ? v : null);
const day = (iso) => (typeof iso === 'string' ? iso.slice(0, 10) : null);

export function compact(n) {
  if (n == null || !Number.isFinite(n)) return '';
  const a = Math.abs(n);
  const t = (x) => (Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 10) / 10).toString();
  if (a >= 1e6) return t(n / 1e6) + 'M';
  if (a >= 1e3) return t(n / 1e3) + 'k';
  return String(Math.round(n));
}

// Popularity has two readings that never appear together: Apple's weekly score (demand, 1-100 with a 1-5 tier)
// or PeekPanda's own estimate (popularityEstimate, a tier word, never a number on Apple's scale). Neither is a search count.
export function popularity(k) {
  const d = k?.demand;
  if (d && Number.isFinite(d.score)) return { kind: 'apple', score: d.score, tier: num(d.tier), periodStart: d.periodStart ?? null, periodEnd: d.periodEnd ?? null };
  const e = k?.popularityEstimate;
  const tier = typeof e === 'string' ? e : e?.tier;
  if (tier) return { kind: 'estimate', score: null, tier, estimatedAt: e?.estimatedAt ?? null, modelTrainedAt: e?.modelTrainedAt ?? null };
  return { kind: null, score: null, tier: null };
}
export function popularityText(p) {
  if (p.kind === 'apple') return `${p.score}${p.tier != null ? ` (tier ${p.tier})` : ''}`;
  if (p.kind === 'estimate') return `est. ${String(p.tier).replace('_', ' ')}`;
  return '—';
}

// Opportunity = popularity × (100 − difficulty) ÷ 100 (see /docs/keyword-metrics-explained).
// Only computed from Apple's numeric score; an estimate tier is not a number, so opportunity stays unavailable.
export function opportunity(pop, difficulty) {
  if (pop.kind !== 'apple' || difficulty == null) return null;
  return Math.round((pop.score * (100 - difficulty)) / 100);
}

// Previous position = the newest history point on an earlier day than the latest one.
function previousPosition(history, latestAt) {
  const pts = (history ?? []).filter((h) => h?.observedAt && Number.isFinite(h.position)).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const latestDay = day(latestAt ?? pts[0]?.observedAt);
  const prev = pts.find((h) => day(h.observedAt) < latestDay);
  return prev ? { position: prev.position, observedAt: prev.observedAt } : null;
}

function toKeyword(k, storeId) {
  const pop = popularity(k);
  const difficulty = num(k.difficulty?.score);
  const position = num(k.position);
  const prev = previousPosition(k.history, k.observedAt);
  const others = (k.apps ?? []).filter((a) => String(a.storeId) !== storeId && !a.isSubject).sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
  const top = others[0] ?? null;
  return {
    query: k.query, position, observedAt: k.observedAt ?? null, resultCount: num(k.resultCount),
    previousPosition: prev?.position ?? null, previousObservedAt: prev?.observedAt ?? null,
    move: position != null && prev ? prev.position - position : null, // positive = moved up (lower number)
    popularity: pop, difficulty, opportunity: opportunity(pop, difficulty),
    topRival: top ? { storeId: String(top.storeId), name: top.name ?? String(top.storeId), position: num(top.position), ratingCount: num(top.ratingCount), inCatalogue: top.inCatalogue ?? null } : null,
    historyPoints: (k.history ?? []).length,
  };
}

function toApp(r) {
  const storeId = String(r.storeId);
  const subject = (r.keywords ?? []).flatMap((k) => k.apps ?? []).find((a) => a.isSubject || String(a.storeId) === storeId);
  const keywords = (r.keywords ?? []).map((k) => toKeyword(k, storeId));
  keywords.sort((a, b) => (b.popularity.score ?? -1) - (a.popularity.score ?? -1) || (a.position ?? 999) - (b.position ?? 999));
  return {
    storeId, name: subject?.name ?? `App ${storeId}`, rating: num(subject?.rating), ratingCount: num(subject?.ratingCount),
    positionKind: r.positionKind ?? null, coverage: r.coverage ?? {}, summary: r.summary ?? {},
    insights: (r.insights ?? []).map((i) => ({ kind: i.kind ?? '', title: i.title ?? '', detail: i.detail ?? '', keywords: i.keywords ?? [] })),
    rivalsCount: (r.rivals ?? []).length, keywordIdeasCount: (r.keywordIdeas ?? []).length,
    keywords,
  };
}

// Accepts one GET .../aso response, an array of them, or a report this tool saved earlier.
export function toReport(input, opts = {}) {
  if (input?.kind === KIND) return input;
  const list = (Array.isArray(input) ? input : [input]).filter(Boolean);
  if (!list.length || list.some((r) => r.storeId == null || !Array.isArray(r.keywords))) throw new Error('Expected GET /v1/competitors/ios/{storeId}/aso responses (objects with storeId and keywords), one per app.');
  return { kind: KIND, fetchedAt: opts.fetchedAt ?? null, apps: list.map(toApp) };
}

export const climbers = (app) => app.keywords.filter((k) => k.move > 0).sort((a, b) => b.move - a.move);
export const fallers = (app) => app.keywords.filter((k) => k.move < 0).sort((a, b) => a.move - b.move);
// Searches with the highest opportunity where the app is not yet in the top 10 of the observed results.
export const openings = (app, n = 5) => app.keywords.filter((k) => k.opportunity != null && (k.position == null || k.position > 10)).sort((a, b) => b.opportunity - a.opportunity).slice(0, n);

// Searches that two or more apps of the run appear in, with each app's position.
export function shared(rep) {
  if (rep.apps.length < 2) return [];
  const map = new Map();
  for (const a of rep.apps) for (const k of a.keywords) {
    if (!map.has(k.query)) map.set(k.query, { query: k.query, popularity: k.popularity, positions: {} });
    map.get(k.query).positions[a.storeId] = k.position;
  }
  return [...map.values()].filter((s) => Object.keys(s.positions).length > 1).sort((a, b) => (b.popularity.score ?? -1) - (a.popularity.score ?? -1));
}

// Compare with the report saved by your last run: searches the app newly appears in, searches it dropped out of,
// and position changes since then (useful when a run sees only one history point).
export function diff(rep, previous) {
  if (!previous) return null;
  const prev = toReport(previous);
  const out = { since: prev.fetchedAt ?? (prev.apps.map((a) => day(a.coverage?.latestObservedAt)).filter(Boolean).join(', ') || 'saved report'), apps: {} };
  for (const a of rep.apps) {
    const old = prev.apps.find((p) => p.storeId === a.storeId);
    if (!old) { out.apps[a.storeId] = { firstRun: true, added: [], dropped: [], changed: [] }; continue; }
    const before = new Map(old.keywords.map((k) => [k.query, k]));
    const now = new Set(a.keywords.map((k) => k.query));
    out.apps[a.storeId] = {
      firstRun: false,
      added: a.keywords.filter((k) => !before.has(k.query)).map((k) => ({ query: k.query, position: k.position })),
      dropped: old.keywords.filter((k) => !now.has(k.query)).map((k) => ({ query: k.query, position: k.position })),
      changed: a.keywords.filter((k) => before.has(k.query) && before.get(k.query).position != null && k.position != null && before.get(k.query).position !== k.position)
        .map((k) => ({ query: k.query, from: before.get(k.query).position, to: k.position })).sort((x, y) => Math.abs(y.from - y.to) - Math.abs(x.from - x.to)),
    };
  }
  return out;
}

export const moveText = (k) => (k.move == null ? '' : k.move > 0 ? `▲${k.move}` : k.move < 0 ? `▼${-k.move}` : '=');
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function toMarkdown(rep, d = null, top = 15) {
  const L = ['## App Store keyword snapshot', ''];
  if (d) L.push(`Compared with your last run (${d.since}).`, '');
  if (rep.apps.length > 1) {
    L.push('### Side by side', '', '| App | Searches | Top 3 | Top 10 | Top 50 | Best | Median | Observed |', '| --- | ---: | ---: | ---: | ---: | --- | ---: | --- |');
    for (const a of rep.apps) {
      const s = a.summary;
      L.push(`| ${cell(a.name)} | ${a.coverage.queriesMatched ?? a.keywords.length} | ${s.top3 ?? ''} | ${s.top10 ?? ''} | ${s.top50 ?? ''} | ${s.bestPosition ? `#${s.bestPosition.position} ${cell(s.bestPosition.query)}` : ''} | ${s.medianPosition ?? ''} | ${day(a.coverage.latestObservedAt) ?? ''} |`);
    }
    const sh = shared(rep);
    if (sh.length) {
      L.push('', '**Searches more than one app appears in**', '', `| Search | Popularity | ${rep.apps.map((a) => cell(a.name)).join(' | ')} |`, `| --- | --- | ${rep.apps.map(() => '---:').join(' | ')} |`);
      for (const s of sh.slice(0, top)) L.push(`| ${cell(s.query)} | ${popularityText(s.popularity)} | ${rep.apps.map((a) => (s.positions[a.storeId] != null ? `#${s.positions[a.storeId]}` : '')).join(' | ')} |`);
    }
    L.push('');
  }
  for (const a of rep.apps) {
    const c = a.coverage, s = a.summary;
    L.push(`### ${a.name} (${a.storeId})`, '');
    L.push(`${c.queriesMatched ?? a.keywords.length} searches observed (${(c.country ?? 'us').toUpperCase()}, ${c.language ?? 'en_us'}), latest ${day(c.latestObservedAt) ?? 'unknown'}, ${c.observationCount ?? '?'} observations. Top 3: ${s.top3 ?? '?'}, top 10: ${s.top10 ?? '?'}, top 50: ${s.top50 ?? '?'}${s.bestPosition ? `, best #${s.bestPosition.position} for "${s.bestPosition.query}"` : ''}${s.medianPosition != null ? `, median #${s.medianPosition}` : ''}.`, '');
    const dd = d?.apps?.[a.storeId];
    if (dd?.firstRun) L.push('First run for this app in your saved report.', '');
    else if (dd) {
      if (dd.added.length) L.push(`🆕 Newly observed in: ${dd.added.map((k) => `"${k.query}" (#${k.position ?? '?'})`).join(', ')}`);
      if (dd.dropped.length) L.push(`No longer observed in: ${dd.dropped.map((k) => `"${k.query}" (was #${k.position ?? '?'})`).join(', ')}`);
      if (dd.changed.length) L.push(`Position changes since last run: ${dd.changed.slice(0, 10).map((k) => `"${k.query}" #${k.from} → #${k.to}`).join(', ')}`);
      if (dd.added.length || dd.dropped.length || dd.changed.length) L.push('');
    }
    const up = climbers(a), down = fallers(a), op = openings(a);
    if (up.length) L.push(`Climbed since the previous collection run: ${up.slice(0, 5).map((k) => `"${k.query}" ${moveText(k)} to #${k.position}`).join(', ')}`);
    if (down.length) L.push(`Dropped since the previous collection run: ${down.slice(0, 5).map((k) => `"${k.query}" ${moveText(k)} to #${k.position}`).join(', ')}`);
    if (op.length) L.push(`Highest opportunity outside the top 10: ${op.map((k) => `"${k.query}" (${k.opportunity}, #${k.position ?? '?'})`).join(', ')}`);
    for (const i of a.insights) L.push(`Note from PeekPanda: ${i.title}${i.detail ? ` (${i.detail})` : ''}${i.keywords.length ? `: ${i.keywords.map((q) => `"${q}"`).join(', ')}` : ''}`);
    if (up.length || down.length || op.length || a.insights.length) L.push('');
    if (!a.keywords.length) { L.push('No searches observed for this app yet. That is not proof it ranks for nothing.', ''); continue; }
    L.push('| Search | Position | Move | Popularity | Difficulty | Opportunity | Top other app | Results | Observed |', '| --- | ---: | --- | --- | ---: | ---: | --- | ---: | --- |');
    for (const k of a.keywords.slice(0, top)) {
      const r = k.topRival;
      L.push(`| ${cell(k.query)} | ${k.position != null ? `#${k.position}` : ''} | ${moveText(k)} | ${popularityText(k.popularity)} | ${k.difficulty ?? '—'} | ${k.opportunity ?? '—'} | ${r ? `#${r.position ?? '?'} ${cell(r.name)}${r.ratingCount != null ? ` (${compact(r.ratingCount)} ratings)` : ''}` : ''} | ${k.resultCount ?? ''} | ${day(k.observedAt) ?? ''} |`);
    }
    if (a.keywords.length > top) L.push('', `(${a.keywords.length - top} more in CSV/JSON)`);
    L.push('');
  }
  return L.join('\n').trimEnd();
}

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function toCsv(rep) {
  const head = ['store_id', 'app', 'query', 'position', 'previous_position', 'move', 'popularity_source', 'popularity_score', 'popularity_tier', 'difficulty', 'opportunity', 'top_other_app', 'top_other_position', 'result_count', 'observed_at'];
  const rows = [head.join(',')];
  for (const a of rep.apps) for (const k of a.keywords) rows.push([a.storeId, a.name, k.query, k.position, k.previousPosition, k.move, k.popularity.kind, k.popularity.score, k.popularity.tier, k.difficulty, k.opportunity, k.topRival?.name, k.topRival?.position, k.resultCount, k.observedAt].map(csvCell).join(','));
  return rows.join('\n');
}

export function toChat(rep, d = null) {
  const L = ['*App Store keyword snapshot*'];
  for (const a of rep.apps) {
    const s = a.summary;
    L.push(`${a.name}: ${a.keywords.length} searches, top 10 in ${s.top10 ?? '?'}${s.bestPosition ? `, best #${s.bestPosition.position} "${s.bestPosition.query}"` : ''}`);
    const dd = d?.apps?.[a.storeId];
    if (dd && !dd.firstRun) {
      if (dd.added.length) L.push(`  new: ${dd.added.slice(0, 5).map((k) => `"${k.query}" #${k.position ?? '?'}`).join(', ')}`);
      if (dd.dropped.length) L.push(`  gone: ${dd.dropped.slice(0, 5).map((k) => `"${k.query}"`).join(', ')}`);
      if (dd.changed.length) L.push(`  moved: ${dd.changed.slice(0, 5).map((k) => `"${k.query}" #${k.from}→#${k.to}`).join(', ')}`);
    }
    const op = openings(a, 3);
    if (op.length) L.push(`  openings: ${op.map((k) => `"${k.query}" (${k.opportunity})`).join(', ')}`);
  }
  L.push('Positions are observed US search-result order, not native App Store rank.');
  return L.join('\n');
}
