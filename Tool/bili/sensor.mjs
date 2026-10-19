#!/usr/bin/env node
/**
 * B 站"获赞"感知器 (Sensor) —— LOOP 的第一步
 *
 * 职责：把目标的量化指标（获赞数）取成可判定的快照 Goal/state.json，
 *       让规划器读数字而不是凭感觉。
 *
 * 数据来源（无需登录态）：
 *   GET /x/web-interface/card?mid=<mid>   -> data.like_num（账号总获赞）
 *   GET /x/space/navnum?mid=<mid>         -> 视频/专栏/动态数（归因风险）
 *
 * ⚠ 已知缺陷（实测）：like_num 由 CDN 多节点返回，同秒内会在两簇值间跳变
 *   （实测 mid=546195 稳定相差 194）。因此单次采样不可信，本脚本：
 *     1) 连续采样 N 次（默认 5 次，间隔 400ms）；
 *     2) like_num 取 max（最接近"新鲜"值），like_num_min 取 min；
 *     3) 判定 PASS 时用**严格下界** delta_strict = min(now) - max(baseline)，
 *        即哪怕最陈旧的缓存节点也显示达标，才认账；
 *     4) 输出 spread / reliable，噪声过大时明确标注"此指标不可靠"，
 *        提示改用评论级台账（口径 B）。
 *
 * 用法：
 *   node Tool/bili/sensor.mjs
 *   node Tool/bili/sensor.mjs --mid 1234567
 *   node Tool/bili/sensor.mjs --mid 1234567 --out "%TEMP%\x"   # 试跑，不污染 Goal/
 *   node Tool/bili/sensor.mjs --set-baseline                    # 以当前值重置基准
 *   node Tool/bili/sensor.mjs --samples 8 --spacing 300
 *   node Tool/bili/sensor.mjs --print
 *
 * 退出码：0 采集成功；2 取数失败；3 未配置 mid。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TZ = 'Asia/Shanghai';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
function opt(name, fallback = null) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

/* ---------------- 时间 ---------------- */
const iso = (d = new Date()) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d).replace(' ', 'T') + '+08:00';

const dateOnly = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 配置 ---------------- */
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}
const config = loadConfig();
const poll = config.poll || {};
const win = config.window || {};
const target = Number(config.target ?? 50);

const samplesN = Math.min(20, Math.max(1, Number(opt('samples') ?? poll.samples ?? 5)));
const spacingMs = Math.min(5000, Math.max(0, Number(opt('spacing') ?? poll.spacing_ms ?? 400)));

/** 噪声容忍阈值：超过它则认为"总获赞"这个指标不足以判定 50 赞级别的目标 */
const spreadTolerance = Math.max(2, Math.ceil(target * 0.2));

/* ---------------- 输出目录 ---------------- */
const outArg = opt('out');
const outDir =
  typeof outArg === 'string'
    ? path.resolve(process.cwd(), outArg)
    : config.outDir
      ? path.resolve(ROOT, config.outDir)
      : path.join(ROOT, 'History');
const STATE = path.join(outDir, 'state.json');
const HISTORY = path.join(outDir, 'history.ndjson');

/* ---------------- HTTP ---------------- */
async function getJson(url, referer) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Referer: referer, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

const cardUrl = (mid) =>
  'https://api.bilibili.com/x/web-interface/card?mid=' + encodeURIComponent(mid);
const navnumUrl = (mid) =>
  'https://api.bilibili.com/x/space/navnum?mid=' + encodeURIComponent(mid);

async function fetchLikeSamples(mid) {
  const referer = 'https://space.bilibili.com/' + mid;
  const samples = [];
  let lastErr = null;
  for (let i = 0; i < samplesN; i++) {
    if (i > 0) await sleep(spacingMs);
    try {
      const j = await getJson(cardUrl(mid), referer);
      if (j.code !== 0) throw new Error(`card code=${j.code} ${j.message || ''}`.trim());
      const n = j.data && j.data.like_num;
      if (typeof n !== 'number') throw new Error('card 响应缺少 data.like_num');
      samples.push(n);
    } catch (e) {
      lastErr = e;
    }
  }
  if (!samples.length) throw lastErr || new Error('全部采样失败');
  return samples;
}

async function fetchContentMix(mid) {
  try {
    const j = await getJson(navnumUrl(mid), 'https://space.bilibili.com/' + mid);
    if (j.code !== 0) return null;
    const d = j.data || {};
    return { video: d.video || 0, article: d.article || 0, opus: d.opus || 0 };
  } catch {
    return null;
  }
}

/* ---------------- 落盘 ---------------- */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readPrevState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function appendHistory(row) {
  fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
  fs.appendFileSync(HISTORY, JSON.stringify(row) + '\n');
}

/* ---------------- 主流程 ---------------- */
async function main() {
  const midArg = opt('mid') ?? config.mid ?? null;
  const mid = String(midArg ?? '').trim();

  if (midArg === true || !/^\d+$/.test(mid)) {
    const msg = '未配置 mid：请在 Tool/bili/config.json 填 "mid"，或传 --mid <数字>';
    /* 配置错误不写 state.json：避免把已建立的有效基准冲掉 */
    writeAtomic(path.join(outDir, 'sensor_error.json'), JSON.stringify({
      t: iso(), ok: false, verdict: 'UNKNOWN', source: 'card.like_num',
      error: 'MID_NOT_CONFIGURED', message: msg,
    }, null, 2) + '\n');
    appendHistory({ t: iso(), ok: false, like_num: null, verdict: 'UNKNOWN', error: 'MID_NOT_CONFIGURED' });
    console.error('[sensor] ' + msg);
    process.exit(3);
  }

  const nowIso = iso();
  const prev = readPrevState();

  let samples;
  let mix = null;
  try {
    samples = await fetchLikeSamples(mid);
    mix = await fetchContentMix(mid);
  } catch (e) {
    const state = {
      t: nowIso, ok: false, verdict: 'UNKNOWN', mid: Number(mid),
      source: 'card.like_num', error: 'FETCH_FAILED', message: String((e && e.message) || e),
      /* 失败时保留既有基准，恢复后不会把 t0 抹掉重来 */
      baseline: prev && prev.baseline ? prev.baseline : null,
      previous: prev ? { t: prev.t, like_num: prev.like_num ?? null } : null,
    };
    writeAtomic(STATE, JSON.stringify(state, null, 2) + '\n');
    appendHistory({ t: nowIso, ok: false, like_num: null, verdict: 'UNKNOWN' });
    console.error('[sensor] 取数失败：' + state.message);
    process.exit(2);
  }

  const likeNum = Math.max(...samples);
  const likeNumMin = Math.min(...samples);
  const spread = likeNum - likeNumMin;

  /* 基准：沿用上次快照的基准（取上界，避免把增量算大）；--set-baseline 或首次运行则重置 */
  const prevBaseline =
    prev && prev.baseline && typeof prev.baseline.like_num === 'number' ? prev.baseline : null;
  const reset = has('set-baseline');
  const baselineInitialized = reset || !prevBaseline;
  const baseline = baselineInitialized
    ? { like_num: likeNum, at: nowIso, initialized: true, sampled: samples.length }
    : prevBaseline;

  /* 相位 */
  const today = dateOnly();
  let phase = 'ACTIVE';
  if (win.start && today < win.start) phase = 'NOT_STARTED';
  else if (win.end && today > win.end) phase = 'CLOSED';

  const delta = likeNum - baseline.like_num;
  /* 严格下界：最陈旧的缓存节点也认账的增量。基准刚建立时两者是同一瞬间，真实增量为 0。 */
  const deltaStrictRaw = likeNumMin - baseline.like_num;
  const deltaStrict = baselineInitialized ? 0 : Math.max(0, deltaStrictRaw);
  const gap = Math.max(0, target - delta);
  const gapStrict = Math.max(0, target - deltaStrict);

  const reliable = samples.length >= 2 ? spread <= spreadTolerance : false;

  let verdict;
  if (phase === 'NOT_STARTED') verdict = 'NOT_STARTED';
  else if (deltaStrict >= target) verdict = 'PASS'; // 严格下界达标才算
  else if (phase === 'CLOSED') verdict = 'FAILED';
  else verdict = 'GAP';

  /* 归因风险：账号若有自有内容，like_num 增量会混入非评论来源 */
  const owns = mix ? mix.video + mix.article + mix.opus : null;
  const attribution = {
    metric: config.metric || 'total_like_delta',
    content: mix,
    risk: owns === null ? 'UNKNOWN' : owns > 0 ? 'MIXED' : 'CLEAN',
    note:
      owns === null
        ? '未取到账号内容构成，无法判断增量归因'
        : owns > 0
          ? `账号有 ${owns} 个自有内容，总获赞增量可能含视频/专栏/动态的赞，非纯评论获赞`
          : '账号无自有内容，总获赞增量可视为评论获赞',
  };

  const note =
    verdict === 'PASS'
      ? `已达目标：严格下界 +${deltaStrict} 赞（目标 ${target}）`
      : verdict === 'GAP'
        ? `距目标还差 ${gapStrict} 赞（严格下界 +${deltaStrict}/${target}）`
        : verdict === 'NOT_STARTED'
          ? `尚未进入时间窗（${win.start} 开始）`
          : `时间窗已结束，仅 +${deltaStrict}/${target}`;

  const state = {
    t: nowIso,
    ok: true,
    mid: Number(mid),
    phase,
    verdict,
    reliable,
    metric: attribution.metric,
    metric_scope: 'content_like', /* ⚠ 只统计视频/专栏/动态/相册的获赞，不含评论获赞 */
    goal_metric: false,            /* 不能用于本目标判定，判定看 ledger.json */
    like_num: likeNum,
    like_num_min: likeNumMin,
    spread,
    samples,
    baseline,
    delta,
    delta_strict: deltaStrict,
    delta_strict_raw: deltaStrictRaw,
    target,
    gap,
    gap_strict: gapStrict,
    noise: {
      n: samples.length,
      spread,
      tolerance: spreadTolerance,
      level: !reliable ? 'HIGH' : spread > 0 ? 'LOW' : 'NONE',
      hint: !reliable
        ? `CDN 缓存抖动 ±${spread} 已超过目标量级（容忍 ${spreadTolerance}），"总获赞"不足以判定该目标，应改用评论级台账（口径 B）`
        : '采样一致，指标可用于判定',
    },
    window: { start: win.start ?? null, end: win.end ?? null },
    source: 'card.like_num',
    attribution,
    baseline_initialized: !!(baseline && baseline.initialized), /* 基准是否存在（与 baseline.initialized 同义） */
    baseline_created_this_run: baselineInitialized,             /* 本次运行是否新建/重置基准（原字段名误用为 baseline_initialized） */
    note,
  };

  writeAtomic(STATE, JSON.stringify(state, null, 2) + '\n');
  appendHistory({
    t: nowIso, ok: true, like_num: likeNum, like_num_min: likeNumMin,
    spread, delta, delta_strict: deltaStrict, gap_strict: gapStrict,
    reliable, verdict,
  });

  if (has('print')) {
    console.log(`[sensor] ${state.t}`);
    console.log(`  mid          : ${mid}`);
    console.log(`  采样         : ${samples.join(', ')}  (n=${samples.length}, 极差 ${spread})`);
    console.log(`  获赞/基准    : ${likeNum} / ${baseline.like_num}`);
    console.log(`  增量         : +${delta}（严格下界 +${deltaStrict}）/ 目标 ${target}   还差 ${gapStrict}`);
    console.log(`  噪声         : ${state.noise.level} — ${state.noise.hint}`);
    console.log(`  归因风险     : ${attribution.risk} — ${attribution.note}`);
    console.log(`  判定         : ${verdict}  (${phase}, reliable=${reliable})`);
    console.log(`  ⚠ 口径提示   : 本数值是"内容获赞"（视频/动态），**不含评论获赞**，不能用于本目标判定`);
    console.log(`  ⚠ 正确判定   : node Tool\\bili\\ledger.mjs report  → 读 History\\ledger.json 的 verdict`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('[sensor] 未捕获异常：', e);
  process.exit(2);
});
