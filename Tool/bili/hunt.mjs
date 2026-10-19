#!/usr/bin/env node
/**
 * 选题猎手 (Hunt) —— 找"评论还能抢到前排"的高热度 AI 视频
 *
 * 为什么需要它：评论能拿多少赞，取决于它被多少人看到。
 * 实测教训：BV1x8HD63EvA 播放 4,860、评论 19 条、发布 11 天 → 评论期望获赞≈0。
 * 要 50 赞，必须挂到"发布不久 + 播放高 + 评论区未饱和"的视频下。
 *
 * 数据源（免登录，全部实测可用，请求间隔 2s 防风控）：
 *   popular  : /x/web-interface/popular?ps=20&pn=1..N      近期热门
 *   ranking  : /x/web-interface/ranking/v2?rid=0&type=all  全站排行
 *   search   : /x/web-interface/search/type?...&order=click|totalrank
 *
 * 打分：score = 播放增速(views/h) × 新鲜度 × 竞争度折扣
 *   - 播放增速：评论发出后还能吃到多少新增曝光
 *   - 新鲜度  ：>7 天基本没救；6–48h 最佳
 *   - 竞争度  ：每千播放的评论数，越高越难进前排
 *
 * 用法：
 *   node Tool\bili\hunt.mjs                 # 猎取并写 History\candidates.json
 *   node Tool\bili\hunt.mjs --print         # 打印逐条理由
 *   node Tool\bili\hunt.mjs --min-age 6 --max-age 48 --top 10
 *
 * 产物：History\candidates.json（判定数据，禁止手写）
 * 退出码：0 成功；2 全部数据源失败；3 参数错误
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

const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
function opt(name, fallback = null) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const iso = (d = new Date()) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d).replace(' ', 'T') + '+08:00';

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}
const config = loadConfig();
const hunt = config.hunt || {};
const outArg = opt('out');
const outDir = typeof outArg === 'string'
  ? path.resolve(process.cwd(), outArg)
  : config.outDir ? path.resolve(ROOT, config.outDir) : path.join(ROOT, 'History');

const KW = (hunt.keywords || [
  'AI', '人工智能', '大模型', 'GPT', 'DeepSeek', '智能体', 'Agent',
  'Sora', '通义', '豆包', 'Claude', 'LLM', '机器学习', '具身智能', '算力',
]).map((s) => String(s));
const KW_RE = new RegExp(KW.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
/* 否定式陷阱：《不是 AI 特效！这才是中国功夫》这类标题含 AI 但不是 AI 题材 */
const EXCLUDE_RE = /不是\s*AI|非\s*AI|没有\s*AI|不用\s*AI|不靠\s*AI|AI\s*特效|AI\s*滤镜|不是用\s*AI/i;
const isAiTopic = (title) => KW_RE.test(title) && !EXCLUDE_RE.test(title);

const MIN_AGE = Number(opt('min-age') ?? hunt.minAgeHours ?? 2);
const MAX_AGE = Number(opt('max-age') ?? hunt.maxAgeHours ?? 120);
const TOP = Math.min(50, Math.max(1, Number(opt('top') ?? hunt.top ?? 10)));
const MIN_VIEW = Number(opt('min-view') ?? hunt.minView ?? 20000);
const MAX_VIEW = Number(opt('max-view') ?? hunt.maxView ?? Infinity);
const MAX_REPLY = Number(opt('max-reply') ?? hunt.maxReply ?? Infinity);
const THROTTLE = Number(hunt.throttleMs ?? 2000);

/* 小播放模式：竞争少、可见性高，赞率取决于话题争议性而非播放量
   实测：2,643 播放 / 42 评论的视频，热评拿了 84 赞（31.8/千播放） */
const NICHE = has('niche');
const EFF_MIN_AGE = NICHE ? 0 : MIN_AGE;
const EFF_MAX_AGE = NICHE ? Number(hunt.nicheMaxAgeHours ?? 720) : MAX_AGE;
const EFF_MIN_VIEW = NICHE ? Number(hunt.nicheMinView ?? 800) : MIN_VIEW;
const EFF_MAX_VIEW = NICHE ? Number(hunt.nicheMaxView ?? 20000) : MAX_VIEW;
const EFF_MAX_REPLY = NICHE ? Number(hunt.nicheMaxReply ?? 200) : MAX_REPLY;

/* 争议性话题加成：立场/冲突类内容观众点赞意愿远高于教程类 */
const CONTENTIOUS_RE = new RegExp(
  (hunt.contentiousKeywords || ['取代', '替代', '失业', '裁员', '抢走', '威胁', '泡沫', '骗', '失控',
    '中美', '领先', '落后', '争议', '塌房', '揭穿', '真相', '崩', '慌了', '消失', '门槛']).join('|'),
  'i',
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

let reqCount = 0;
async function getJson(url, { retry = true } = {}) {
  reqCount++;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.bilibili.com/',
        Accept: 'application/json, text/plain, */*',
      },
    });
    const text = await r.text();
    if (text.trim().startsWith('<')) {
      /* 风控页：等待后重试一次 */
      if (retry) {
        await sleep(6000);
        return getJson(url, { retry: false });
      }
      throw new Error('风控拦截（返回 HTML）');
    }
    const json = JSON.parse(text);
    if (json && json.code === -412 && retry) {
      /* 请求过频：冷却后重试一次 */
      await sleep(7000);
      return getJson(url, { retry: false });
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 采集 ---------------- */
async function fromPopular(pages) {
  const out = [];
  for (let pn = 1; pn <= pages; pn++) {
    try {
      const j = await getJson(`https://api.bilibili.com/x/web-interface/popular?ps=20&pn=${pn}`);
      if (j.code !== 0) break;
      for (const v of j.data.list || []) out.push(norm(v));
    } catch (e) {
      if (has('print')) console.error(`  [popular pn=${pn}] ${e.message}`);
    }
    await sleep(THROTTLE);
  }
  return out;
}

async function fromRanking() {
  try {
    const j = await getJson('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all');
    if (j.code !== 0) return [];
    return (j.data.list || []).map(norm);
  } catch (e) {
    if (has('print')) console.error(`  [ranking] ${e.message}`);
    return [];
  }
}

async function fromSearch(keyword, order, page = 1) {
  try {
    const j = await getJson(
      'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' +
        encodeURIComponent(keyword) + '&order=' + order + '&page=' + page,
    );
    if (j.code !== 0) return [];
    return (j.data.result || []).map((v) => ({
      bvid: v.bvid,
      title: strip(v.title),
      up: v.author,
      mid: v.mid,
      view: v.play,
      reply: v.review ?? 0,
      danmaku: v.danmaku ?? 0,
      pubdate: v.pubdate,
      source: 'search/' + order + '/p' + page,
    }));
  } catch (e) {
    if (has('print')) console.error(`  [search ${keyword}/${order}/p${page}] ${e.message}`);
    return [];
  }
}

/**
 * 按发布时间翻页找"刚起来"的视频。
 * 第 1 页是刚发几分钟的（播放个位数），往后翻才是几小时前、播放已起量的。
 */
async function fromSearchPubdate(keywords, pages) {
  const out = [];
  for (const kw of keywords) {
    for (let pn = 1; pn <= pages; pn++) {
      await sleep(THROTTLE);
      out.push(...(await fromSearch(kw, 'pubdate', pn)));
    }
  }
  return out;
}

function norm(v) {
  const s = v.stat || {};
  return {
    bvid: v.bvid,
    title: strip(v.title),
    up: v.owner ? v.owner.name : v.author,
    mid: v.owner ? v.owner.mid : v.mid,
    view: s.view ?? v.play ?? 0,
    reply: s.reply ?? v.review ?? 0,
    danmaku: s.danmaku ?? v.danmaku ?? 0,
    pubdate: v.pubdate,
    source: 'hot',
  };
}

/** 从"已验证有效的视频"扩散：同题材簇、同量级，比搜索精准得多 */
async function fromRelated(bvid, sourceTag) {
  try {
    const j = await getJson('https://api.bilibili.com/x/web-interface/archive/related?bvid=' + encodeURIComponent(bvid));
    if (j.code !== 0) return [];
    return (j.data || []).map((v) => ({ ...norm(v), source: sourceTag || 'related:' + bvid }));
  } catch (e) {
    if (has('print')) console.error(`  [related ${bvid}] ${e.message}`);
    return [];
  }
}

/** 读取资产库里的种子视频 */
function readProvenSeeds() {
  try {
    const raw = fs.readFileSync(path.join(outDir, 'proven.ndjson'), 'utf8').replace(/^\uFEFF/, '');
    const rows = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return [...new Set(rows.map((r) => r.bvid).filter(Boolean))];
  } catch {
    return [];
  }
}

/** 取视频标签，用于题材实证（标题说了不算） */
async function fetchTags(bvid) {
  try {
    const j = await getJson('https://api.bilibili.com/x/tag/archive/tags?bvid=' + encodeURIComponent(bvid));
    if (j.code !== 0) return null;
    return (j.data || []).map((t) => t.tag_name).filter(Boolean);
  } catch {
    return null;
  }
}

/* ---------------- 打分 ---------------- */
function freshness(ageH) {
  if (ageH < 2) return 0.15;      // 太新，播放还没起来，也不确定会不会爆
  if (ageH <= 6) return 0.6;
  if (ageH <= 48) return 1.0;     // 黄金窗口
  if (ageH <= 96) return 0.5;
  if (ageH <= 168) return 0.2;
  return 0.03;
}

function evaluate(v, now) {
  const ageH = Math.max(0.1, (now - v.pubdate * 1000) / 3600000);
  const velocity = v.view / ageH;                 // views/hour
  const saturation = v.view > 0 ? (v.reply / v.view) * 1000 : 0; // 每千播放评论数
  const compFactor = 1 / (1 + saturation / 4);    // 饱和 4 条/千播放时折扣一半
  /* 互动率：评论率越高说明观众越爱表达，点赞意愿也越高
     实测：84 赞的案例评论率 15.9/千；知识搬运号 0.9–3/千 几乎不点赞 */
  const engagement = saturation;
  const engagementFactor = 1 + Math.log10(1 + engagement) / 1.2;
  const score = velocity * freshness(ageH) * compFactor * engagementFactor;
  return { ageH, velocity, saturation, compFactor, engagement, engagementFactor, score, fresh: freshness(ageH) };
}

/* ---------------- 主流程 ---------------- */
async function main() {
  const now = Date.now();
  const t0 = iso();

  if (has('print')) console.log('[hunt] 采集数据源…');
  const buckets = [];
  buckets.push(...(await fromPopular(Number(hunt.popularPages ?? 2))));
  await sleep(THROTTLE);
  buckets.push(...(await fromRanking()));
  for (const kw of (hunt.searchKeywords || ['人工智能', 'AI']).slice(0, 3)) {
    await sleep(THROTTLE);
    buckets.push(...(await fromSearch(kw, 'totalrank')));
    await sleep(THROTTLE);
    buckets.push(...(await fromSearch(kw, 'click')));
  }
  /* 按发布时间翻页：找"刚起来、播放已起量"的视频，这是 6–24h 黄金窗口的主来源 */
  buckets.push(...(await fromSearchPubdate(
    (hunt.pubdateKeywords || ['人工智能', '大模型', 'AI']).slice(0, 2),
    Number(hunt.pubdatePages ?? 3),
  )));
  /* 补充关键词：贴着"AI 取代职业"这条已验证有效的赛道去找 */
  for (const kw of (hunt.extraKeywords || []).slice(0, 4)) {
    await sleep(THROTTLE);
    buckets.push(...(await fromSearch(kw, 'click')));
  }
  /* 资产扩散：从已获赞视频的"相关推荐"里找同题材、同量级的视频 */
  if (has('from-proven')) {
    const seeds = readProvenSeeds();
    if (!seeds.length) console.error('  [from-proven] 资产库为空，先跑 proven.mjs 入库');
    for (const bv of seeds.slice(0, 5)) {
      await sleep(THROTTLE);
      buckets.push(...(await fromRelated(bv)));
      if (has('print')) console.log(`  [from-proven] 已扩散 ${bv}`);
    }
  }

  if (!buckets.length) {
    console.error('[hunt] 全部数据源失败（可能被风控），稍后重试');
    process.exit(2);
  }

  /* 去重 + 过滤 */
  const seen = new Map();
  for (const v of buckets) {
    if (!v.bvid || seen.has(v.bvid)) continue;
    seen.set(v.bvid, v);
  }
  const all = [...seen.values()];
  const aiMatched = all.filter((v) => isAiTopic(v.title));
  const rows = [];
  const MIN_VIEW_YOUNG = Number(opt('min-view-young') ?? hunt.minViewYoung ?? 3000);
  const MIN_RATIO = Number(opt('min-ratio') ?? hunt.minViewPerComment ?? 0);
  for (const v of aiMatched) {
    const m = evaluate(v, now);
    if (m.ageH < EFF_MIN_AGE || m.ageH > EFF_MAX_AGE) continue;
    /* 早鸟：6 小时内评论区还小，新评论能停在首页，播放门槛理应更低 */
    const need = NICHE ? EFF_MIN_VIEW : m.ageH <= Number(hunt.youngHours ?? 6) ? MIN_VIEW_YOUNG : MIN_VIEW;
    if (v.view < need) continue;
    if (v.view > EFF_MAX_VIEW) continue;
    if (v.reply > EFF_MAX_REPLY) continue;
    /* 播放/评论比：这条评论有多少潜在曝光。资产基准 619（14,228 播放 / 23 评论 → 8 赞） */
    const ratio = v.reply > 0 ? v.view / v.reply : Infinity;
    if (ratio < MIN_RATIO) continue;
    const contentious = CONTENTIOUS_RE.test(v.title);
    /* 互动率门槛：观众不爱互动的视频（评论率 <3/千）几乎不会点赞 */
    if (m.engagement < Number(opt('min-engagement') ?? hunt.minEngagement ?? 0)) continue;
    const score = m.score * (contentious ? 1.4 : 1);
    rows.push({
      bvid: v.bvid,
      title: v.title,
      up: v.up,
      url: `https://www.bilibili.com/video/${v.bvid}`,
      view: v.view,
      reply: v.reply,
      view_per_comment: Number.isFinite(ratio) ? Math.round(ratio) : null,
      engagement_per_k: Number(m.engagement.toFixed(1)),
      age_hours: Number(m.ageH.toFixed(1)),
      velocity_per_hour: Math.round(m.velocity),
      saturation_per_k: Number(m.saturation.toFixed(2)),
      freshness: m.fresh,
      contentious,
      score: Math.round(score),
      source: v.source,
      reason:
        `发布 ${m.ageH.toFixed(1)}h · 播放 ${v.view.toLocaleString()} · 评论 ${v.reply} · ` +
        `每评论播放 ${Number.isFinite(ratio) ? Math.round(ratio) : '∞'} · ` +
        `评论率 ${m.engagement.toFixed(1)}/千 · ` +
        `增速 ${Math.round(m.velocity).toLocaleString()}/h` +
        (contentious ? ' · 争议性话题（点赞意愿高）' : ''),
    });
  }
  rows.sort((a, b) => b.score - a.score);

  /* 题材实证：只凭标题会把"标题党"选进来（实测：《不是 AI 特效》《你说说这ai怎么取代人类？》都不是 AI 题材）。
     对前 N 名拉标签，标签命中才算 strong，否则降级为 title_only。 */
  const deepN = Math.min(rows.length, Number(hunt.deepVerifyTop ?? 8));
  const verifyThrottle = Number(hunt.verifyThrottleMs ?? 1500);
  for (const r of rows.slice(0, deepN)) {
    await sleep(verifyThrottle);
    const tags = await fetchTags(r.bvid);
    if (!tags) {
      r.topic = 'unknown';
      r.ai_evidence = [];
      continue;
    }
    const hits = tags.filter((t) => KW_RE.test(t) && !EXCLUDE_RE.test(t));
    r.tags = tags.slice(0, 10);
    r.ai_evidence = hits;
    r.topic = hits.length ? 'strong' : 'title_only';
  }
  for (const r of rows.slice(deepN)) {
    r.topic = 'unverified';
    r.ai_evidence = [];
  }
  /* 簇信任：来自已获赞 AI 视频的"相关推荐"，题材由同簇保证，不必强求标签命中 */
  for (const r of rows.slice(0, deepN)) {
    if (r.topic === 'title_only' && String(r.source).startsWith('related:')) {
      r.topic = 'cluster';
      r.ai_evidence = ['同簇扩散'];
    }
  }

  const requireEvidence = hunt.requireTopicEvidence !== false;
  let usable = rows;
  if (requireEvidence) {
    const strong = rows.filter((r) => r.topic === 'strong' || r.topic === 'cluster');
    if (strong.length) usable = strong;
    else if (has('print')) console.log('[hunt] 无题材实证候选，退回全部（可能全是标题党）');
  }
  const top = usable.slice(0, TOP);

  const result = {
    t: t0,
    scanned: all.length,
    ai_matched: aiMatched.length,
    qualified: rows.length,
    usable: usable.length,
    topic_strong: rows.filter((r) => r.topic === 'strong').length,
    topic_title_only: rows.filter((r) => r.topic === 'title_only').length,
    mode: NICHE ? 'niche' : 'hot',
    filters: {
      minAgeHours: EFF_MIN_AGE, maxAgeHours: EFF_MAX_AGE,
      minView: EFF_MIN_VIEW, maxView: Number.isFinite(EFF_MAX_VIEW) ? EFF_MAX_VIEW : null,
      maxReply: Number.isFinite(EFF_MAX_REPLY) ? EFF_MAX_REPLY : null,
      minViewPerComment: MIN_RATIO, top: TOP,
    },
    sources: {
      popular_pages: Number(hunt.popularPages ?? 2),
      ranking: true,
      search: (hunt.searchKeywords || ['人工智能', 'AI']).slice(0, 3),
      search_pubdate: {
        keywords: (hunt.pubdateKeywords || ['人工智能', '大模型', 'AI']).slice(0, 2),
        pages: Number(hunt.pubdatePages ?? 3),
      },
      requests: reqCount,
    },
    candidates: top,
    note: top.length
      ? `Top1 期望曝光最高：${top[0].reason}`
      : '当前没有符合条件的 AI 高热度视频，可放宽 maxAgeHours 或换关键词重试',
  };

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, NICHE ? 'candidates_niche.json' : 'candidates.json');
  const tmp = file + '.tmp';
  const prev = (() => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      return null;
    }
  })();
  if (!top.length && prev && Array.isArray(prev.candidates) && prev.candidates.length) {
    /* 本轮空手，不覆盖上一轮的好结果，只把空跑留档 */
    fs.writeFileSync(path.join(outDir, `candidates_empty_${t0.replace(/[:+]/g, '-')}.json`),
      JSON.stringify(result, null, 2) + '\n');
    console.log(`  本轮 0 条，保留上一轮 ${prev.candidates.length} 条候选（${prev.t}）`);
    process.exit(0);
  }
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2) + '\n');
  fs.renameSync(tmp, file);

  console.log(`[hunt] ${t0}`);
  console.log(`  抓取 ${all.length} 条（去重后），AI 相关 ${aiMatched.length} 条，通过筛选 ${rows.length} 条`);
  console.log(`  题材实证：strong ${rows.filter((r) => r.topic === 'strong').length} · title_only ${rows.filter((r) => r.topic === 'title_only').length}`);
  if (!top.length) {
    console.log('  ' + result.note);
  } else {
    console.log('');
    for (const [i, r] of top.entries()) {
      const flag = r.topic === 'strong' ? '✓' : r.topic === 'title_only' ? '⚠' : '?';
      console.log(`  ${String(i + 1).padStart(2)}. [${String(r.score).padStart(7)}] ${flag} ${r.bvid}  ${r.title.slice(0, 30)}`);
      if (has('print')) {
        console.log(`      ${r.reason}`);
        console.log(`      题材实证: ${r.topic}${r.ai_evidence && r.ai_evidence.length ? '（标签 ' + r.ai_evidence.join('/') + '）' : '（标签未命中 AI）'}`);
      }
    }
  }
  console.log(`  已写入 ${path.relative(ROOT, file)}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[hunt] 失败：', e && e.message ? e.message : e);
  process.exit(2);
});
