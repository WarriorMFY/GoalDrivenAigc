// Tool/bili/collect.mjs —— 采集器（双层采样 + 事件触发 + 官方快照）
// 三层频率：
//   light  每 lightEveryMin 分钟：1 请求（popular 50）→ 流式样本，零 LLM
//   full   每 fullEveryMin 分钟：3 请求 → 流式样本 + latest.md（L2 唯一阅读面）+ 事件判定
//   official 命中 Goal.md 时段：3 请求 → 正式快照（raw/csv/digest/索引），计入 M1
// 用法：
//   node Tool/bili/collect.mjs --serve
//   node Tool/bili/collect.mjs --once --slot <iso> [--label test --out History/_test --noindex]
//   node Tool/bili/collect.mjs --light           立即做一次轻采样
//   node Tool/bili/collect.mjs --full            立即做一次全采样（写 latest.md）
//   node Tool/bili/collect.mjs --list
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  VERSION, BILI_DIR, ROOT, HISTORY, P, sleep, ensureDir, fmtStamp, fmtIso, sha256, byteLen,
  readJson, writeJson, writeFileAtomic, estTokens, fetchJson, normalize, fnum, cut,
  toCsv, readCsv, expectedSlots, HDRS, HDRS_RANK,
} from './lib.mjs';

const CFG = readJson(path.join(BILI_DIR, 'config.json'));
const SAMPLING = CFG.sampling || { lightEveryMin: 10, fullEveryMin: 30 };
const STREAM_DIR = P.stream;
const SAMPLES = P.samples;
const EVENTS = P.events;
const LATEST = P.latest;
const INDEX_PATH = P.index;
const LOG_PATH = P.log;

function log(msg) {
  const line = `[${fmtIso(new Date())}] ${msg}`;
  ensureDir(HISTORY);
  fs.appendFileSync(LOG_PATH, `${line}\n`);
  console.log(line);
}
const loadIndex = () => readJson(INDEX_PATH, { version: 1, snapshots: [] });
const saveIndex = (ix) => writeJson(INDEX_PATH, ix);
const slotKey = (d) => fmtIso(new Date(d));

function prevSnapshot(ix, excludeKey) {
  const done = (ix.snapshots || []).filter((s) => s.status === 'ok' && s.slot !== excludeKey && !s.test);
  done.sort((a, b) => new Date(a.actual) - new Date(b.actual));
  return done.at(-1) || null;
}

// ---------- 取数 ----------
async function fetchAll() {
  const risk = [];
  const reqs = [];
  let rolling = await fetchJson(CFG.endpoints.ranking, { retries: CFG.retries, headers: HDRS_RANK });
  // ranking 是唯一会单独被 -352 的接口（实测 08:42/09:14/09:45/03:33），且冷却时长不定（3~36 分钟）。
  // full 采样只重试一次、间隔 120s：既有机会捡回，也不会把冷却拖长。
  if (!rolling.ok) {
    log(`ranking 失败 code=${rolling.code}，120s 后单独重试一次`);
    await sleep(120000);
    rolling = await fetchJson(CFG.endpoints.ranking, { retries: 1 });
    risk.push(...rolling.log.map((l) => l.code));
  }
  risk.push(...rolling.log.map((l) => l.code));
  reqs.push({ name: 'ranking', ok: rolling.ok, code: rolling.code, bytes: rolling.bytes, attempts: rolling.attempts });
  await sleep(CFG.throttleMs);
  const pop = await fetchJson(CFG.endpoints.popular, { retries: CFG.retries });
  risk.push(...pop.log.map((l) => l.code));
  reqs.push({ name: 'popular', ok: pop.ok, code: pop.code, bytes: pop.bytes, attempts: pop.attempts });
  await sleep(CFG.throttleMs);
  const hotr = await fetchJson(CFG.endpoints.hotsearch, { retries: CFG.retries });
  risk.push(...hotr.log.map((l) => l.code));
  reqs.push({ name: 'hotsearch', ok: hotr.ok, code: hotr.code, bytes: hotr.bytes, attempts: hotr.attempts });

  const covOk = reqs.filter((r) => r.ok).length;
  return {
    rolling, pop, hotr, reqs,
    cov: `${covOk}/${reqs.length}`,
    allOk: covOk === reqs.length,
    rawBytes: reqs.reduce((s, r) => s + r.bytes, 0),
    risk: [...new Set(risk.filter((c) => c !== null && c !== 0 && c !== undefined))],
  };
}

async function fetchLight() {
  const pop = await fetchJson(CFG.endpoints.popular, { retries: CFG.retries });
  return {
    pop,
    cov: pop.ok ? '1/1' : '0/1',
    allOk: pop.ok,
    rawBytes: pop.bytes,
    reqs: [{ name: 'popular', ok: pop.ok, code: pop.code, bytes: pop.bytes, attempts: pop.attempts }],
    risk: [...new Set(pop.log.map((l) => l.code).filter((c) => c && c !== 0))],
  };
}

// ---------- 派生 ----------
function dedupeByBvid(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = r.bvid || `${r.src}:${r.rank}:${r.title}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}
function zoneHeat(rows, top = 10) {
  const m = new Map();
  for (const r of rows) {
    if (!r.zone) continue;
    const cur = m.get(r.zone) || { zone: r.zone, maxView: 0, count: 0, sumView: 0 };
    cur.count += 1;
    cur.sumView += r.view;
    if (r.view > cur.maxView) cur.maxView = r.view;
    m.set(r.zone, cur);
  }
  return [...m.values()].sort((a, b) => b.maxView - a.maxView).slice(0, top);
}
function rising(rows, top = 10, nowMs = Date.now()) {
  return rows
    .filter((r) => r.pubdate > 0)
    .map((r) => {
      const ageH = Math.max((nowMs / 1000 - r.pubdate) / 3600, 0.5);
      return { ...r, ageH, vph: r.view / ageH };
    })
    .sort((a, b) => b.vph - a.vph)
    .slice(0, top);
}
function deltas(curTop, prevTop) {
  const cur = new Map(curTop.map((r) => [r.bvid, r]));
  const prev = new Map(prevTop.map((r) => [r.bvid, r]));
  const added = [...cur.keys()].filter((b) => !prev.has(b)).map((b) => cur.get(b));
  const dropped = [...prev.keys()].filter((b) => !cur.has(b)).map((b) => prev.get(b));
  const common = [...cur.keys()].filter((b) => prev.has(b));
  return {
    overlap: prev.size ? common.length / prev.size : null,
    added, dropped, commonN: common.length, prevN: prev.size,
    grows: common.map((b) => ({ cur: cur.get(b), prev: prev.get(b), d: cur.get(b).view - prev.get(b).view }))
      .sort((a, b) => b.d - a.d).slice(0, 10),
  };
}

// ---------- digest（官方快照，LLM 可见层 ≤ maxDigestBytes） ----------
function renderDigest(ctx, v) {
  const { planned, actual, cov, riskNote, totalItems, rawBytes, comp, top50, hot, dlt, prevLabel } = ctx;
  const L = [];
  L.push(`# SNAP ${fmtIso(actual).slice(5, 16).replace('T', ' ')} 计划${fmtIso(planned).slice(5, 16).replace('T', ' ')} cov=${cov} N=${totalItems} raw=${(rawBytes / 1024).toFixed(0)}kB 压${comp}x${riskNote}`);
  L.push(`## 全站Top${v.top} rank|bvid|分区|播放|赞|评|时长h`);
  for (const r of top50.slice(0, v.top)) {
    const ageH = r.pubdate ? Math.max((actual.getTime() / 1000 - r.pubdate) / 3600, 0.2).toFixed(0) : '-';
    L.push(`${r.rank}|${r.bvid}|${r.zone}|${fnum(r.view)}|${fnum(r.like)}|${fnum(r.reply)}|${ageH}`);
  }
  L.push('## 分区热度 分区|最高播放|条目数|合计播放');
  for (const z of ctx.zones) L.push(`${z.zone}|${fnum(z.maxView)}|${z.count}|${fnum(z.sumView)}`);
  L.push('## 搜索热词');
  L.push(hot.map((h) => h.title).join('>') || '(空)');
  L.push(`## 上升Top${v.rise} 播放/时`);
  for (const r of ctx.rising.slice(0, v.rise)) L.push(`${r.bvid}|${cut(r.title, 18)}|${fnum(r.view)}|${r.ageH.toFixed(1)}h|${fnum(Math.round(r.vph))}/h`);
  if (dlt) {
    L.push(`## Δ vs ${prevLabel}`);
    L.push(`重合${(dlt.overlap * 100).toFixed(0)}% 新进${dlt.added.length} 掉榜${dlt.dropped.length} 共同${dlt.commonN}/${dlt.prevN}`);
    for (const r of dlt.added.slice(0, v.dlt)) L.push(`+${r.bvid}|${cut(r.title, 16)}|${fnum(r.view)}`);
    for (const r of dlt.dropped.slice(0, v.dlt)) L.push(`-${r.bvid}|${cut(r.title, 16)}|${fnum(r.view)}`);
    for (const g of dlt.grows.slice(0, v.dlt)) L.push(`↑${g.cur.bvid}|${cut(g.cur.title, 14)}|+${fnum(Math.max(g.d, 0))}`);
  }
  return L.join('\n');
}
function buildDigest(ctx) {
  const variants = [
    { top: 20, rise: 10, dlt: 5 }, { top: 16, rise: 8, dlt: 4 }, { top: 12, rise: 6, dlt: 3 },
    { top: 10, rise: 5, dlt: 2 }, { top: 8, rise: 4, dlt: 1 },
  ];
  const maxBytes = CFG.maxDigestBytes;
  for (const v of variants) {
    const text = renderDigest(ctx, v);
    if (byteLen(text) <= maxBytes) return { text, variant: v, bytes: byteLen(text), trimmed: v.top < 20 };
  }
  const v = variants.at(-1);
  const hard = renderDigest(ctx, v).slice(0, maxBytes);
  return { text: hard, variant: v, bytes: byteLen(hard), trimmed: true, hardTruncated: true };
}

// ---------- 流式样本 ----------
function tailSamples(n = 1) {
  if (!fs.existsSync(SAMPLES)) return [];
  const lines = fs.readFileSync(SAMPLES, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function lastSampleOfKind(kind, opts = {}) {
  if (!fs.existsSync(SAMPLES)) return null;
  const lines = fs.readFileSync(SAMPLES, 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]);
      if (o.kind !== kind) continue;
      // nonEmpty：跳过失败的空样本（ranking 被 -352 时 top50 为空），
      // 否则会把"50 条全新进榜、重合 0%"当成真实换血（2026-10-22 10:15 就报了假事件）
      if (opts.nonEmpty && !o.viewSum) continue;
      return o;
    } catch { /* ignore */ }
  }
  return null;
}
const lastKindAt = (kind) => { const r = lastSampleOfKind(kind); return r ? new Date(r.at) : null; };

function sampleRec(kind, fetched, top50, extra = {}) {
  const now = new Date();
  // 只在同类型样本之间比较：light 对 light（popular 池），full 对 full（排行榜池），跨池比无意义
  // 且必须跳过失败的空样本；本次采集为空时也不与历史比较（否则会产生"换血 0+50"这种假事件）
  const prev = top50.length ? lastSampleOfKind(kind, { nonEmpty: true }) : null;
  const prevSet = new Set(prev?.top50 || []);
  const curSet = top50.map((r) => r.bvid);
  const added = curSet.filter((b) => !prevSet.has(b));
  const dropped = prev ? prev.top50.filter((b) => !curSet.includes(b)) : [];
  const viewSum = top50.reduce((s, r) => s + r.view, 0);
  const vphMax = top50.length
    ? Math.max(...top50.map((r) => (r.pubdate ? r.view / Math.max((now / 1000 - r.pubdate) / 3600, 0.5) : 0)))
    : 0;
  const hot3 = (extra.hot || []).slice(0, 3).map((h) => h.title);
  // cohort 口径：只盯同一批 bvid 的增量。聚合量（viewSummary）会被榜内换血扭曲——
  // 实测 13:38→14:08 出现了"播放量下降 0.87%"，那是新条目替换旧条目导致的假信号。
  const views = top50.map((r) => [r.bvid, r.view]);
  const prevViews = new Map(prev?.views || []);
  const commonPairs = views.filter(([b]) => prevViews.has(b));
  const cohortN = prev ? commonPairs.length : null;
  const cohortDelta = prev ? commonPairs.reduce((s, [b, v]) => s + (v - prevViews.get(b)), 0) : null;
  const baseSum = prev ? commonPairs.reduce((s, [b]) => s + prevViews.get(b), 0) : 0;
  const cohortPct = prev && baseSum > 0 ? (cohortDelta / baseSum) * 100 : null;
  const vphList = top50.filter((r) => r.pubdate).map((r) => r.view / Math.max((now / 1000 - r.pubdate) / 3600, 0.5)).sort((a, b) => a - b);
  const vphP95 = vphList.length ? vphList[Math.floor(vphList.length * 0.95)] : 0;
  return {
    at: fmtIso(now),
    stamp: fmtStamp(now),
    kind,
    cov: fetched.cov,
    items: top50.length,
    viewSum,
    prevViewSum: prev?.viewSum ?? null,
    overlap: prevSet.size ? Number((curSet.filter((b) => prevSet.has(b)).length / prevSet.size).toFixed(4)) : null,
    added: added.length,
    dropped: dropped.length,
    addedTop: added.slice(0, 5),
    droppedTop: dropped.slice(0, 5),
    vphMax: Math.round(vphMax),
    vphP95: Math.round(vphP95),
    hot3,
    prevHot3: prev?.hot3 ?? null,
    hotChanged: prev ? hot3.filter((t, i) => t !== (prev.hot3 || [])[i]).length : 0,
    risk: fetched.risk,
    // 记录每个接口的返回码：-352 是分端点冷却，不记名字就无法判断是哪个接口被封（2026-10-22 09:14 就吃了这个亏）
    reqs: (fetched.reqs || []).map((r) => `${r.name}:${r.code}`),
    top50: curSet,
    views,
    cohortN,
    cohortDelta: cohortDelta != null ? Math.round(cohortDelta) : null,
    cohortPct: cohortPct != null ? Number(cohortPct.toFixed(3)) : null,
    bytes: fetched.rawBytes,
  };
}

function appendSample(rec) {
  ensureDir(STREAM_DIR);
  fs.appendFileSync(SAMPLES, `${JSON.stringify(rec)}\n`);
}

function median(a) {
  const b = [...a].filter((v) => v != null).sort((x, y) => x - y);
  if (!b.length) return null;
  const m = Math.floor(b.length / 2);
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}

// 滑动基线：同类型最近 n 条（不含当前条）的 cohortPct 中位数。
// 依据实测：15:09–16:39 四个点稳定在 0.40±0.02%，而 17:09/17:40 偏离到 0.45%/0.57%。
// 固定阈值（增速翻倍）抓不到这种结构性抬升，相对基线的偏离才能。
// 关键：必须剔除"采样盲区后的第一条"——它的 cohort 是跨小时累积的（休眠后实测 14.34%），
// 混进基线会让后续所有事件误报 slow。
function recentCohortPct(kind, n = 6) {
  if (!fs.existsSync(SAMPLES)) return [];
  const all = fs.readFileSync(SAMPLES, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .filter((s) => s.kind === kind);
  const maxGapMin = kind === 'light' ? 25 : 90;
  const clean = [];
  for (let i = 0; i < all.length; i++) {
    const s = all[i];
    if (s.cohortPct == null) continue;
    const prev = all[i - 1];
    const gapMin = prev ? (new Date(s.at) - new Date(prev.at)) / 60000 : Infinity;
    if (gapMin > maxGapMin) continue; // 盲区后首条，cohort 跨时段累积，不可用
    clean.push(s.cohortPct);
  }
  return clean.slice(-n - 1, -1);
}

function detectEvents(cur, prev) {
  const ev = [];
  if (!prev) return ev;
  // 本次采集为空（取数失败）时不做任何相对判断，只记 risk/gap
  if (!cur.viewSum) {
    if (cur.risk && cur.risk.length) ev.push({ kind: 'risk', detail: `风控码 ${cur.risk.join(',')}｜接口 ${(cur.reqs || []).filter((x) => !x.endsWith(':0')).join(',') || '(未知)'}` });
    return ev;
  }
  // 采样盲区检测：主机休眠会让定时器停摆且不报错，故障完全静默。
  // 实测 2026-10-21 18:05→01:53 空白 7h48m、01:53→08:33 空白 6h40m，期间无任何事件。
  const gapMin = (new Date(cur.at) - new Date(prev.at)) / 60000;
  const maxGapMin = cur.kind === 'light' ? 25 : 90;
  if (gapMin > maxGapMin) {
    ev.push({ kind: 'gap', detail: `距上次样本 ${gapMin.toFixed(0)}min（阈值 ${maxGapMin}min），疑似主机休眠或进程中断` });
  }
  if (cur.added + cur.dropped >= 10) ev.push({ kind: 'churn', detail: `Top50 换血 ${cur.added}+${cur.dropped}（重合 ${(cur.overlap * 100).toFixed(0)}%）` });
  if (prev.vphMax > 0 && cur.vphMax >= prev.vphMax * 2) ev.push({ kind: 'surge', detail: `峰值增速 ${fnum(Math.round(cur.vphMax))}/h，为上次 ${(cur.vphMax / prev.vphMax).toFixed(1)} 倍` });
  if (cur.hotChanged >= 2) ev.push({ kind: 'hot', detail: `热词前3换 ${cur.hotChanged} 条` });
  if (cur.risk.length) {
    const bad = (cur.reqs || []).filter((x) => !x.endsWith(':0'));
    ev.push({ kind: 'risk', detail: `风控码 ${cur.risk.join(',')}｜接口 ${bad.join(',') || '(未知)'}` });
  }

  // 相对滑动基线的偏离（需要至少 3 个历史点才判，避免冷启动误报）
  const hist = recentCohortPct(cur.kind, 6);
  const base = hist.length >= 3 ? median(hist) : null;
  if (base != null && base > 0 && cur.cohortPct != null) {
    const r = cur.cohortPct / base;
    if (r >= 1.3) ev.push({ kind: 'ramp', detail: `cohort ${cur.cohortPct.toFixed(2)}% 为基线 ${base.toFixed(2)}% 的 ${r.toFixed(2)}×（n=${hist.length}）` });
    else if (r <= 0.7) ev.push({ kind: 'slow', detail: `cohort ${cur.cohortPct.toFixed(2)}% 仅基线 ${base.toFixed(2)}% 的 ${r.toFixed(2)}×（n=${hist.length}）` });
  }
  return ev;
}

function writeLatest(ix) {
  const samples = tailSamples(20);
  const cur = samples.at(-1);
  if (!cur) return;
  // 空样本（如 ranking 被 -352、top50 为空）绝不能覆盖摘要：
  // 2026-10-22 09:45 一次失败的 full 把 latest.md 写成了「截面 view 0」，看起来像热门池归零。
  if (!cur.viewSum) { log(`latest.md 跳过写入：${cur.stamp} ${cur.kind} 为空样本`); return; }
  // 只在同类型样本之间算增量：ranking 池与 popular 池的量级不同，跨池相减会得出 +114% 这种假信号
  const prev = [...samples].reverse().find((s) => s !== cur && s.kind === cur.kind) || null;
  const slots = expectedSlots(CFG);
  const done = (ix.snapshots || []).filter((s) => s.status === 'ok' && !s.test).length;
  const evs = [];
  if (fs.existsSync(EVENTS)) {
    const lines = fs.readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean).slice(-5);
    for (const l of lines) { try { evs.push(JSON.parse(l)); } catch { /* ignore */ } }
  }
  const dView = null; // 聚合量差值已废弃（受榜内换血污染，见 sampleRec 注释）
  const L = [];
  L.push(`# LATEST ${cur.at.slice(5, 16).replace('T', ' ')} ${cur.kind} cov=${cur.cov}`);
  L.push(`样本 ${samples.length} 条（近20）；距上次 ${prev ? ((new Date(cur.at) - new Date(prev.at)) / 60000).toFixed(0) : '-'}min`);
  L.push(`截面 Top50 view ${fnum(cur.viewSum)}（含换血，勿当趋势）`);
  L.push(`同cohort ${cur.cohortN ?? '-'} 条 增量 ${cur.cohortDelta != null ? `${cur.cohortDelta >= 0 ? '+' : ''}${fnum(cur.cohortDelta)}` : '-'}${cur.cohortPct != null ? `（${cur.cohortPct >= 0 ? '+' : ''}${cur.cohortPct.toFixed(2)}%）` : ''}`);
  L.push(`重合 ${cur.overlap != null ? `${(cur.overlap * 100).toFixed(0)}%` : '-'} 新进${cur.added} 掉榜${cur.dropped}`);
  if (cur.addedTop?.length) L.push(`新进 ${cur.addedTop.slice(0, 3).join(',')}`);
  if (cur.droppedTop?.length) L.push(`掉榜 ${cur.droppedTop.slice(0, 3).join(',')}`);
  L.push(`峰值增速 ${fnum(cur.vphMax)}/h（P95 ${fnum(cur.vphP95)}/h）`);
  // light 采样不带热词（1 请求的原则），事件触发时沿用最近一次 full 的热词，不能用 '-' 覆盖掉已知信息
  const carried = (cur.hot3 && cur.hot3.length) ? null : ([...samples].reverse().find((s) => s.hot3 && s.hot3.length)?.hot3 || []);
  const hot3 = carried ? carried : cur.hot3;
  L.push(`热词前3 ${hot3.join('>') || '-'}${cur.hotChanged ? ` 换${cur.hotChanged}` : ''}${carried ? '（沿用上次full）' : ''}`);
  L.push(`官方快照 ${done}/${slots.length}`);
  if (evs.length) {
    L.push(`事件 ${evs.length}（近5条）：`);
    for (const e of evs.slice(-3)) L.push(`- ${e.at.slice(11, 16)} ${e.kind} ${e.detail}`);
  } else L.push('事件 0');
  let text = L.join('\n');
  if (byteLen(text) > 1200) text = text.slice(0, 1150);
  writeFileAtomic(LATEST, `${text}\n`);
  return text;
}

// ---------- 官方快照 ----------
async function commitOfficial({ planned, actual, fetched, outDir = P.snapshots, writeIndex = true, label = '' }) {
  ensureDir(outDir);
  const { rolling, pop, hotr, reqs, cov, rawBytes, risk } = fetched;
  const riskNote = risk.length ? ` risk=${risk.join(',')}` : '';
  const top50 = normalize(rolling.data?.list, 'ranking', CFG.topN);
  const popular = normalize(pop.data?.list, 'popular', 50);
  const hot = (hotr.data?.trending?.list || []).map((h, i) => ({
    rank: i + 1, bvid: '', title: h.show_name || h.keyword || '', owner: '', view: h.heat_score ?? 0,
    like: 0, coin: 0, fav: 0, reply: 0, danmaku: 0, pubdate: 0, zone: '热词', src: 'hotsearch',
  }));
  const rows = [...top50, ...popular, ...hot];
  const uniq = dedupeByBvid([...top50, ...popular]);

  const ix = loadIndex();
  const prev = prevSnapshot(ix, slotKey(planned));
  let prevTop = [];
  if (prev) {
    const prevCsv = path.join(P.snapshots, `${prev.stamp}.csv`);
    if (fs.existsSync(prevCsv)) prevTop = readCsv(prevCsv).filter((r) => r.src === 'ranking');
  }
  const dlt = prev && prevTop.length ? deltas(top50, prevTop) : null;

  const ctx = {
    planned, actual, cov, riskNote, totalItems: rows.length, rawBytes, top50, popular, hot,
    zones: zoneHeat(uniq), rising: rising(uniq, 10, actual.getTime()), dlt,
    prevLabel: prev ? fmtIso(new Date(prev.actual)).slice(5, 16).replace('T', ' ') : '',
  };
  const d1 = buildDigest({ ...ctx, comp: '?' });
  const comp = (rawBytes / Math.max(d1.bytes, 1)).toFixed(0);
  const digest = buildDigest({ ...ctx, comp });

  const stamp = fmtStamp(actual);
  const files = {
    raw: path.join(outDir, `${stamp}_raw.json`),
    csv: path.join(outDir, `${stamp}.csv`),
    digest: path.join(outDir, `${stamp}.digest.md`),
  };
  const rawObj = {
    meta: {
      script: 'Tool/bili/collect.mjs', version: VERSION, planned: fmtIso(planned), actual: fmtIso(actual),
      params: { slots: CFG.slots, topN: CFG.topN, sampling: SAMPLING, throttleMs: CFG.throttleMs, retries: CFG.retries, maxDigestBytes: CFG.maxDigestBytes, endpoints: CFG.endpoints },
      reqs, risk, label,
    },
    responses: {
      ranking: { url: CFG.endpoints.ranking, http: 200, bytes: rolling.bytes, text: rolling.text },
      popular: { url: CFG.endpoints.popular, http: 200, bytes: pop.bytes, text: pop.text },
      hotsearch: { url: CFG.endpoints.hotsearch, http: 200, bytes: hotr.bytes, text: hotr.text },
    },
  };
  const rawText = JSON.stringify(rawObj);
  writeFileAtomic(files.raw, rawText);
  writeFileAtomic(files.csv, toCsv(rows));
  writeFileAtomic(files.digest, digest.text);

  const meta = {
    slot: slotKey(planned), stamp, planned: fmtIso(planned), actual: fmtIso(actual),
    label: label || undefined,
    test: label === 'test' || outDir !== P.snapshots ? true : undefined,
    status: fetched.allOk ? 'ok' : 'partial',
    cov, items: rows.length, rawBytes, digestBytes: digest.bytes, comp: Number(comp),
    estTokens: { digest: estTokens(digest.text), raw: estTokens(rolling.text + pop.text + hotr.text) },
    overlap: dlt ? Number(dlt.overlap.toFixed(4)) : null,
    delta: dlt ? { added: dlt.added.length, dropped: dlt.dropped.length, commonN: dlt.commonN, prevN: dlt.prevN } : null,
    digestVariant: digest.variant, trimmed: digest.trimmed || undefined,
    reqs, risk: fetched.risk,
    files: { raw: path.basename(files.raw), csv: path.basename(files.csv), digest: path.basename(files.digest) },
    sha256: { raw: sha256(rawText), csv: sha256(fs.readFileSync(files.csv)), digest: sha256(digest.text) },
  };
  if (writeIndex) {
    const ix2 = loadIndex();
    ix2.snapshots = (ix2.snapshots || []).filter((s) => s.slot !== meta.slot);
    ix2.snapshots.push(meta);
    ix2.snapshots.sort((a, b) => new Date(a.planned) - new Date(b.planned));
    ix2.version = 1;
    ix2.updatedAt = fmtIso(new Date());
    ix2.goalWindow = CFG.window;
    saveIndex(ix2);
  }
  return { meta, digestText: digest.text, top50, popular, hot, fetched };
}

// ---------- 调度 ----------
async function doLight() {
  const f = await fetchLight();
  const top50 = normalize(f.pop.data?.list, 'popular', 50);
  const prev = lastSampleOfKind('light');
  const rec = sampleRec('light', f, top50);
  appendSample(rec);
  // light 采样也必须过事件判定：高频层的全部意义就是"早于 full 发现突增"，
  // 只在 full 判事件等于把 10 分钟粒度又退化成 30 分钟。
  const evs = detectEvents(rec, prev);
  if (evs.length) {
    ensureDir(HISTORY);
    for (const e of evs) fs.appendFileSync(EVENTS, `${JSON.stringify({ ...e, at: rec.at, stamp: rec.stamp })}\n`);
    writeLatest(loadIndex());
  }
  log(`light ${rec.stamp} cov=${rec.cov} view=${fnum(rec.viewSum)} overlap=${rec.overlap} cohort=${rec.cohortPct != null ? `${rec.cohortPct}%` : '-'} 事件${evs.length} risk=${rec.risk.join(',') || '-'}`);
  return { rec, evs };
}

async function doFull() {
  const f = await fetchAll();
  const top50 = normalize(f.rolling.data?.list, 'ranking', CFG.topN);
  const hot = (f.hotr.data?.trending?.list || []).map((h) => ({ title: h.show_name || h.keyword || '' }));
  const prev = lastSampleOfKind('full', { nonEmpty: true });
  const rec = sampleRec('full', f, top50, { hot });
  appendSample(rec);
  const evs = detectEvents(rec, prev);
  if (evs.length) {
    ensureDir(HISTORY);
    for (const e of evs) fs.appendFileSync(EVENTS, `${JSON.stringify({ ...e, at: rec.at, stamp: rec.stamp })}\n`);
  }
  const latest = writeLatest(loadIndex());
  log(`full ${rec.stamp} cov=${rec.cov} view=${fnum(rec.viewSum)} overlap=${rec.overlap} 新进${rec.added} 掉榜${rec.dropped} 事件${evs.length}`);
  return { rec, evs, latest };
}

async function doOfficial(slot) {
  const key = slotKey(slot);
  // 重试时序按 M1 的 10 分钟容差设计：0s → +90s → +180s，总耗时 <5 分钟。
  // 依据：ranking 的 -352 是分钟级冷却（实测 4 分钟后自愈），30 秒重试等于没等。
  const waits = CFG.snapshotRetryWaitsMs || [90000, 180000];
  for (let attempt = 1; attempt <= waits.length + 1; attempt++) {
    log(`官方快照开始 slot=${key} 第${attempt}次`);
    try {
      const f = await fetchAll();
      const { meta, top50, hot } = await commitOfficial({ planned: slot, actual: new Date(), fetched: f });
      const rec = sampleRec('full', f, top50, { hot });
      rec.official = key;
      appendSample(rec);
      writeLatest(loadIndex());
      if (meta.status === 'ok') {
        log(`官方快照完成 slot=${key} items=${meta.items} digest=${meta.digestBytes}B comp=${meta.comp}x`);
        return meta;
      }
      log(`官方快照不完整 slot=${key} cov=${meta.cov}`);
    } catch (e) {
      log(`官方快照异常 slot=${key} ${e?.message || e}`);
    }
    if (attempt <= waits.length) {
      log(`等待 ${Math.round(waits[attempt - 1] / 1000)}s 后重试 slot=${key}`);
      await sleep(waits[attempt - 1]);
    }
  }
  const ix2 = loadIndex();
  ix2.snapshots = (ix2.snapshots || []).filter((s) => s.slot !== key);
  ix2.snapshots.push({ slot: key, planned: key, status: 'failed', at: fmtIso(new Date()), note: 'two attempts failed' });
  ix2.snapshots.sort((a, b) => new Date(a.planned) - new Date(b.planned));
  saveIndex(ix2);
  return null;
}

function lastOfKind(kind) {
  const lines = fs.existsSync(SAMPLES) ? fs.readFileSync(SAMPLES, 'utf8').split('\n').filter(Boolean) : [];
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const o = JSON.parse(lines[i]); if (o.kind === kind) return new Date(o.at); } catch { /* ignore */ }
  }
  return null;
}

const TERMINAL = new Set(['ok', 'missed', 'failed']);

// 自动收尾（方案 A）：不依赖 LLM 在线。
// 触发条件二选一：①窗口结束；②全部官方时点都已结算且已过最后一个时点的容差。
// 收尾动作本身由 finalize.mjs 完成（刷新 trend_log/trend_report + 审计 + 写 verdict.json），
// 再把判定摘要写进 History/DONE.flag，作为"完工"的可观测信号。
function maybeFinalize(slots) {
  const flag = P.done;
  if (fs.existsSync(flag)) return false;
  const now = new Date();
  const end = new Date(CFG.window.end);
  const ix = loadIndex();
  const terminal = (key) => {
    const r = (ix.snapshots || []).find((s) => s.slot === key);
    return Boolean(r && TERMINAL.has(r.status));
  };
  const allSettled = slots.length > 0 && slots.every((s) => terminal(slotKey(s)));
  const lastSlot = slots.at(-1);
  const afterLast = lastSlot ? now > new Date(lastSlot.getTime() + CFG.toleranceMin * 60000) : false;
  const winOver = now >= end;
  if (!(winOver || (allSettled && afterLast))) return false;

  log(`自动收尾触发：${winOver ? '窗口结束' : '全部时点已结算'}`);
  const r = spawnSync(process.execPath, [path.join(BILI_DIR, 'finalize.mjs')], { stdio: 'inherit', cwd: ROOT });
  const v = readJson(P.verdict, null);
  const rec = {
    at: fmtIso(new Date()),
    trigger: winOver ? 'window-end' : 'all-slots-settled',
    exit: r.status,
    verdict: v?.verdict ?? null,
    snapshots: v?.snapshots ?? null,
    failed: v?.failed ?? null,
    budget: v?.budget ?? null,
  };
  fs.writeFileSync(flag, `${JSON.stringify(rec, null, 1)}\n`);
  log(`自动收尾完成 verdict=${rec.verdict} 快照=${JSON.stringify(rec.snapshots)} → History/DONE.flag`);
  return true;
}

async function serve() {
  ensureDir(HISTORY);
  const slots = expectedSlots(CFG);
  log(`collector v2 启动 ${VERSION} light=${SAMPLING.lightEveryMin}min full=${SAMPLING.fullEveryMin}min`);
  log(`官方时段 ${slots.map((s) => fmtIso(s).slice(5, 16).replace('T', ' ')).join(', ')}｜容差 ${CFG.toleranceMin}min`);
  const end = new Date(CFG.window.end);
  const missedMarked = new Set();
  let lastTierAt = 0;
  for (;;) {
    const now = new Date();
    maybeFinalize(slots);
    if (now > new Date(end.getTime() + 15 * 60000)) { log('窗口已过，collector 退出'); return; }
    try {
      const ix = loadIndex();
      let acted = false;
      for (const slot of slots) {
        const key = slotKey(slot);
        const rec = (ix.snapshots || []).find((s) => s.slot === key);
        if (rec && (rec.status === 'ok' || rec.status === 'failed')) continue;
        const lateMin = (now - slot) / 60000;
        if (lateMin < -0.05) continue;
        if (lateMin > CFG.toleranceMin) {
          const maxLateMin = CFG.lateCollectMaxMin ?? 120;
          // 迟到超窗口的，绝不补采：把上午 08:45 的数据贴上"昨天 20:00"的标签是造假。
          if (lateMin > maxLateMin) {
            if (!rec && !missedMarked.has(key)) {
              missedMarked.add(key);
              const ixm = loadIndex();
              ixm.snapshots = (ixm.snapshots || []).filter((s) => s.slot !== key);
              ixm.snapshots.push({ slot: key, planned: key, status: 'missed', lateMin: Number(lateMin.toFixed(1)), at: fmtIso(new Date()), note: `迟到超过 ${maxLateMin}min，不补采（避免标签造假）` });
              ixm.snapshots.sort((a, b) => new Date(a.planned) - new Date(b.planned));
              saveIndex(ixm);
              log(`缺采 slot=${key} 迟到${lateMin.toFixed(1)}min > ${maxLateMin}min，不补采`);
            }
            continue;
          }
          // 迟到在容差~2小时内：采，但对趋势仍标注为迟到；不计入 M1 的按时快照。
          // 只要索引里已有记录（ok/partial/failed/missed 任一），就不再重采——否则会陷入每 50 秒重打接口的死循环。
          if (rec) continue;
          const got = await doOfficial(slot);
          if (got) {
            const ix3 = loadIndex();
            const r3 = (ix3.snapshots || []).find((x) => x.slot === key);
            if (r3) { r3.late = true; r3.lateMin = Number(lateMin.toFixed(1)); saveIndex(ix3); }
            log(`迟到补采 slot=${key} 迟到${lateMin.toFixed(1)}min（不计入 M1）`);
          } else if (!missedMarked.has(key)) {
            missedMarked.add(key);
            const ix2 = loadIndex();
            ix2.snapshots = (ix2.snapshots || []).filter((s) => s.slot !== key);
            ix2.snapshots.push({ slot: key, planned: key, status: 'missed', lateMin: Number(lateMin.toFixed(1)), at: fmtIso(new Date()), note: '超出容差且补采失败' });
            ix2.snapshots.sort((a, b) => new Date(a.planned) - new Date(b.planned));
            saveIndex(ix2);
            log(`缺采 slot=${key} 迟到${lateMin.toFixed(1)}min 且补采失败`);
          }
          acted = true;
          break;
        }
        await doOfficial(slot);
        acted = true;
        break;
      }
      if (!acted) {
        // 跨层级冷却：light 与 full 恰好同时到期时，原逻辑会在 20 秒内先后打 popular 和 ranking，
        // 构成"短时间跨端点遍历"——这正是实测触发 -352 的模式（2026-10-22 09:14 / 09:45 两次都是这样）。
        // 手动单发同一接口两次均成功，说明不是持续封禁，因此靠间隔而非退避解决。
        const gapMs = CFG.minTierGapMs ?? 60000;
        // ranking 静默期：官方时段前停止 full 采样，让 ranking 的 -352 冷却彻底恢复。
        // 背景：2026-10-23 04:33 ranking 被拒，120s 重试仍拒；冷却期明显长于 2 分钟。
        const pauseUntil = CFG.rankingPauseUntil ? new Date(CFG.rankingPauseUntil) : null;
        const paused = pauseUntil && Date.now() < pauseUntil.getTime();
        if (Date.now() - lastTierAt >= gapMs) {
          const lastFull = lastOfKind('full');
          const lastLight = lastOfKind('light');
          if (!paused && (!lastFull || (now - lastFull) / 60000 >= SAMPLING.fullEveryMin)) {
            await doFull(); acted = true; lastTierAt = Date.now();
          } else if (!lastLight || (now - lastLight) / 60000 >= SAMPLING.lightEveryMin) {
            await doLight(); acted = true; lastTierAt = Date.now();
          }
        }
      }
      if (now < new Date(CFG.window.start)) { log('窗口未开始，等待'); }
    } catch (e) {
      log(`调度异常 ${e?.message || e}`);
    }
    await sleep(20000);
  }
}

// ---------- CLI ----------
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? true) : d; };
const resolvePath = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

if (argv.includes('--list')) {
  const ix = loadIndex();
  const slots = expectedSlots(CFG);
  const now = new Date();
  console.log(`窗口 ${CFG.window.start} → ${CFG.window.end}  现在 ${fmtIso(now)}`);
  console.log(`采样 light=${SAMPLING.lightEveryMin}min full=${SAMPLING.fullEveryMin}min  流样本 ${tailSamples(1).length ? '有' : '无'}`);
  for (const s of slots) {
    const rec = (ix.snapshots || []).find((x) => x.slot === slotKey(s));
    console.log(`${fmtIso(s).slice(0, 16)}  ${s < now ? '已过' : '待采'}  ${rec ? rec.status : '-'}`);
  }
  console.log(`官方快照 ${(ix.snapshots || []).filter((s) => s.status === 'ok').length}/${slots.length}`);
} else if (argv.includes('--serve')) {
  await serve();
} else if (argv.includes('--light')) {
  const { rec, evs } = await doLight();
  console.log(JSON.stringify({ ...rec, top50: `${rec.top50.length} 条`, events: evs.length }, null, 1));
} else if (argv.includes('--full')) {
  const { rec, evs, latest } = await doFull();
  console.log(JSON.stringify({ ...rec, top50: `${rec.top50.length} 条`, events: evs.length }, null, 1));
  console.log('--- latest.md ---');
  console.log(latest);
} else if (argv.includes('--once')) {
  const slotArg = arg('--slot');
  const planned = slotArg ? new Date(slotArg) : new Date();
  const outDir = arg('--out') ? resolvePath(arg('--out')) : P.snapshots;
  const label = arg('--label', '') || '';
  const writeIndex = !argv.includes('--noindex');
  const f = await fetchAll();
  const { meta, digestText } = await commitOfficial({ planned, actual: new Date(), fetched: f, outDir, writeIndex, label });
  console.log(JSON.stringify(meta, null, 1));
  console.log('--- digest ---');
  console.log(digestText);
} else {
  console.log('用法: --serve | --once [--slot <iso>] [--label test --out History/_test --noindex] | --light | --full | --list');
}
