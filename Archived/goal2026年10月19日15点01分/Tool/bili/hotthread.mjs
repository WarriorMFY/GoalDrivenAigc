#!/usr/bin/env node
/**
 * 热楼猎手 (hotthread) v2 —— 把"楼中楼策略"变成可执行的目标清单
 *
 * 为什么需要它：
 *   Tool.md §8 的实测结论——热视频下面的**顶层新评论必然沉底**（默认按热度排序），
 *   而**楼中楼**（回复高赞根评论）继承根评论的曝光。
 *
 * v2 改了什么（决策依据见 Tool\DECISIONS.md D1）：
 *   v1 用 `root_like / (rcount+1)` 当机会分，把"楼内回复多"当成坏事——方向是反的。
 *   实测反例：根评 264 赞的楼，楼内回复拿到 16/11/7 赞；根评 555 赞的楼，楼内回复全在 1 赞。
 *   → **根评论赞高 ≠ 楼能分润；楼内回复真的拿到赞，才是这个楼会分曝光的最强证据。**
 *
 * v3 改了什么（决策依据见 DECISIONS.md D7，证据来自我们自己那条评论）：
 *   2026-10-19 23:13 实测：在 root 330 赞 / 楼内 5 条的爆炸楼里，我们第 4 位发出的回复
 *   拿到 7.58 赞/小时；而 6 小时前发在顶层和死楼里的 5 条评论合计只有 3 赞。
 *   → ① 位置惩罚放宽：楼内前 4 位不吃惩罚（SLOT_FULL=4）；
 *     ② freshness 改用**根评论增速**（真正的"楼在爆炸"证据），没有增速数据时用
 *        `root_like / root_age_hours` 兜底，再没有才退回播放速度；
 *     ③ 每次运行把根评论赞数追加到 `History\hotthread_history.ndjson`，下轮即可算瞬时增速；
 *     ④ 新增 `--golden`：只留"发布 ≤12h、楼内 ≤4、增速 ≥15 赞/h"的爆炸楼。
 *
 * v2 的四个信号（仍然有效）：
 *
 *     traffic   = view / age_hours        近似持续曝光速度：1.2 万播放/小时的老视频仍然有人看
 *     freshness = clamp(traffic / 5000, 0.2, 1.5)
 *     proof     = reply_median*2.5 + reply_max*0.8 + reply_ge10*3   楼内回复战绩
 *     exposure  = root_like * 0.35                                 根评论能借给你的曝光
 *     slot      = 1 / (1 + 0.5*max(0, rcount+1-3))                 抢不到前 3 条回复位就衰减
 *     opportunity = (exposure + proof + 1) * freshness * slot
 *
 * 数据来源（全部免登录）：
 *   GET /x/web-interface/view?bvid=<BV>                  -> data.aid / stat / pubdate
 *   GET /x/v2/reply?type=1&oid=<aid>&sort=2&ps=20&pn=1   -> 按热度排序的根评论（匿名给 3 条）
 *   GET /x/v2/reply/reply?type=1&oid=<aid>&root=<rpid>   -> 楼内回复（含各自赞数）
 *
 * 产出：History\hotthreads.json
 *
 * 用法：
 *   node Tool\bili\hotthread.mjs                        # 扫现有 candidates_*.json
 *   node Tool\bili\hotthread.mjs --print                # 附加人读清单
 *   node Tool\bili\hotthread.mjs --bvid BV1xx,BV1yy     # 指定视频
 *   node Tool\bili\hotthread.mjs --min-like 30 --max-rcount 4 --max-age 72 --top 8
 *   node Tool\bili\hotthread.mjs --include-commented    # 允许包含本周已评论过的视频
 *
 * 退出码：0 成功 · 2 全部取数失败 · 3 参数错误
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
const HDR = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' };

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const config = loadConfig();
const hunt = config.hunt || {};
const outArg = opt('out');
const outDir = typeof outArg === 'string'
  ? path.resolve(process.cwd(), outArg)
  : config.outDir ? path.resolve(ROOT, config.outDir) : path.join(ROOT, 'History');
const OUT = path.join(outDir, 'hotthreads.json');

const THROTTLE = Number(hunt.throttleMs ?? 2000);

/* --golden：只留"正在爆炸、位置还没排满"的楼（决策见 DECISIONS.md D7）。
   实测证据（2026-10-19 23:13）：root 330 赞 / 楼内 5 条的楼，我们第 4 位发的回复
   拿到 7.58 赞/小时；而 6 小时前发在顶层和死楼里的 5 条评论合计只有 3 赞。 */
const GOLDEN = has('golden');

const MIN_LIKE = Number(opt('min-like') ?? (GOLDEN ? 15 : 20));          // 根评论赞数下限
const MAX_RCOUNT = Number(opt('max-rcount') ?? (GOLDEN ? 4 : 6));        // 楼内回复数上限
const MAX_AGE = Number(opt('max-age') ?? (GOLDEN ? 12 : 168));           // 视频发布小时数上限
const MIN_ROOT_VEL = Number(opt('min-root-velocity') ?? (GOLDEN ? 15 : 0)); // 根评论增速下限（赞/小时）
const TOP = Math.min(50, Math.max(1, Number(opt('top') ?? 10)));
const INCLUDE_COMMENTED = has('include-commented');
const MAX_CAND_AGE = Number(opt('max-candidate-age') ?? 24);  // 候选快照超过这个小时数就不再参与扫描
const FORCE_WRITE = has('force');                              // 允许用小结果覆盖更大的扫描结果
const FAST_HOT = 5000;   // 播放/小时：没有增速数据时的兜底信号
const BLAST_FULL = 50;   // 根评论 50 赞/小时 = 满分爆炸（实测 330 赞 / 3h ≈ 110 赞/h）
const SLOT_FULL = 4;     // 实测楼内第 4 位仍能拿 7.58 赞/小时 → 前 4 位不吃位置惩罚（D7）

/* 每次跑都把根评论赞数追加进快照，下次即可算"根评论增速"——这才是楼在爆炸的直接证据 */
const SNAPS = path.join(outDir, 'hotthread_history.ndjson');
function readSnapshots() {
  const map = new Map();
  let text = '';
  try {
    text = fs.readFileSync(SNAPS, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return map;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const k = `${r.bvid}#${r.root_rpid}`;
      const prev = map.get(k);
      if (!prev || String(prev.t) < String(r.t)) map.set(k, r);
    } catch { /* 忽略坏行 */ }
  }
  return map;
}
const SNAP_PREV = readSnapshots();
const SNAP_NOW = [];

/* 已在本周评论过的视频——默认跳过，避免同一视频反复刷评论 */
const ledger = readJson(path.join(outDir, 'ledger.json'), { comments: [] });
const commented = new Set((ledger.comments || []).map((c) => c.bvid).filter(Boolean));

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function getJson(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: HDR });
      const text = await res.text();
      if (/^\s*</.test(text)) throw new Error('HTML 验证页（风控）');
      const json = JSON.parse(text);
      if (json.code !== 0) throw new Error(`code=${json.code} ${json.message || ''}`);
      return json.data;
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(3000);
    }
  }
}

/* ---------------- 候选视频来源 ---------------- */
function candidates() {
  const list = [];
  const seen = new Set();
  const add = (c) => {
    if (!c || !c.bvid || seen.has(c.bvid)) return;
    seen.add(c.bvid);
    list.push(c);
  };

  const explicit = typeof opt('bvid') === 'string' ? opt('bvid').split(/[,，\s]+/).filter(Boolean) : [];
  if (explicit.length) {
    for (const bvid of explicit) add({ bvid, title: '', source: 'cli' });
    return list;
  }

  const files = ['candidates_hot.json', 'candidates_cold.json', 'candidates_niche.json'];
  const rank = { candidates_hot: 0, candidates_cold: 1, candidates_niche: 2 };
  const pool = [];
  for (const f of files) {
    const j = readJson(path.join(outDir, f), null);
    if (!j) continue;
    /* 候选池混龄：cold/niche 可能是十几个小时前的快照，视频早就凉了，白白消耗请求 */
    if (j.t) {
      const ageH = (Date.now() - Date.parse(j.t)) / 3600000;
      if (Number.isFinite(ageH) && ageH > MAX_CAND_AGE) {
        console.error(`[hotthread] ${f} 快照 ${j.t} 已 ${Math.round(ageH)}h（> --max-candidate-age ${MAX_CAND_AGE}h），跳过`);
        continue;
      }
    }
    const arr = Array.isArray(j) ? j : (j.items || j.candidates || []);
    for (const c of arr) pool.push({ ...c, _f: f.replace('.json', '') });
  }
  pool.sort((a, b) => {
    const d = (rank[a._f] ?? 9) - (rank[b._f] ?? 9);
    return d !== 0 ? d : Number(b.view || 0) - Number(a.view || 0);
  });
  for (const c of pool) add(c);
  return list;
}

/* 楼内回复的赞数分布：这个楼愿不愿意把曝光分给回复 */
async function threadStats(aid, rootRpid, rcount) {
  if (!rcount) return { likes: [], texts: [], fetched: 0, note: '楼内无回复' };
  try {
    const d = await getJson(
      `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${aid}&root=${rootRpid}&ps=20&pn=1`,
    );
    const subs = d.replies || [];
    return {
      likes: subs.map((x) => Number(x.like || 0)),
      /* 楼内已有人说的话：写草稿时必须看，避免撞梗、重复 */
      texts: subs
        .slice(0, 8)
        .map((x) => ({ like: Number(x.like || 0), text: String(x.content?.message || '').replace(/\s+/g, ' ').slice(0, 80) })),
      fetched: subs.length,
      note: subs.length < rcount ? `接口给 ${subs.length} 条 / 页面 ${rcount} 条` : null,
    };
  } catch (e) {
    return { likes: [], texts: [], fetched: 0, note: `楼内取数失败：${e.message}` };
  }
}

/* ---------------- 主流程 ---------------- */
async function main() {
  const startedAt = iso();
  const cands = candidates();
  if (!cands.length) {
    console.error('[hotthread] 没有候选视频：先跑 hunt（node Tool\\bili\\hunt.mjs）或 --bvid 指定');
    process.exit(3);
  }

  const targets = [];
  const failures = [];
  const skipped = [];
  let req = 0;

  for (const c of cands) {
    if (!INCLUDE_COMMENTED && commented.has(c.bvid)) {
      console.error(`[hotthread] ${c.bvid} 本周已评论，跳过（--include-commented 可包含）`);
      continue;
    }

    let view;
    try {
      view = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${c.bvid}`);
      req++;
    } catch (e) {
      failures.push({ bvid: c.bvid, stage: 'view', error: String(e.message || e) });
      continue;
    }
    await sleep(THROTTLE);

    const aid = view.aid;
    const stat = view.stat || {};
    const pubdate = Number(view.pubdate || 0);
    const ageHours = pubdate ? r2((Date.now() / 1000 - pubdate) / 3600) : null;
    const viewCount = Number(stat.view || c.view || 0);
    const traffic = ageHours ? viewCount / ageHours : null;   // 播放/小时

    if (ageHours !== null && ageHours > MAX_AGE) {
      skipped.push({ bvid: c.bvid, reason: `发布 ${ageHours}h > --max-age ${MAX_AGE}`, view: viewCount });
      continue;
    }

    let roots = [];
    try {
      const d = await getJson(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=2&ps=20&pn=1`);
      req++;
      roots = (d.replies || []).map((x) => ({
        rpid: String(x.rpid),
        like: Number(x.like || 0),
        rcount: Number(x.rcount || 0),
        uname: x.member?.uname || '',
        text: String(x.content?.message || '').replace(/\s+/g, ' ').slice(0, 160),
        ctime: Number(x.ctime || 0),
      }));
    } catch (e) {
      failures.push({ bvid: c.bvid, stage: 'reply', error: String(e.message || e) });
      await sleep(THROTTLE);
      continue;
    }
    await sleep(THROTTLE);

    /* 先过硬门槛，再花请求去取楼内战绩（省一半请求量） */
    const pass = roots.filter((x) => x.like >= MIN_LIKE && x.rcount <= MAX_RCOUNT);
    for (const root of pass) {
      const th = await threadStats(aid, root.rpid, root.rcount);
      req++;
      if (root.rcount) await sleep(THROTTLE);

      const replyMax = th.likes.length ? Math.max(...th.likes) : 0;
      const replyMedian = median(th.likes);
      const replyGe10 = th.likes.filter((n) => n >= 10).length;

      /* 根评论增速：优先用两次快照的差分（瞬时），没有快照时用 赞数/存活小时（均值）兜底 */
      const rootAgeHours = root.ctime ? r1((Date.now() / 1000 - root.ctime) / 3600) : null;
      const rootLphAvg = rootAgeHours ? r1(root.like / Math.max(0.5, rootAgeHours)) : null;
      const prev = SNAP_PREV.get(`${c.bvid}#${root.rpid}`);
      let rootVelocity = null;
      if (prev && prev.root_like !== undefined) {
        const elapsedH = (Date.parse(startedAt) - Date.parse(prev.t)) / 3600000;
        if (elapsedH >= 0.05) rootVelocity = r1((root.like - Number(prev.root_like)) / elapsedH);
      }
      const explosion = rootVelocity ?? rootLphAvg;

      if (MIN_ROOT_VEL > 0 && (explosion === null || explosion < MIN_ROOT_VEL)) {
        SNAP_NOW.push({ t: iso(), bvid: c.bvid, root_rpid: root.rpid, root_like: root.like, root_replies: root.rcount, view: viewCount, root_velocity: rootVelocity });
        continue;
      }

      const exposure = root.like * 0.35;
      const proof = replyMedian * 2.5 + replyMax * 0.8 + replyGe10 * 3;
      /* freshness：有增速就用增速（爆炸期直接吃到 >1），否则退回播放速度兜底 */
      const freshness = explosion !== null
        ? clamp(explosion / BLAST_FULL, 0.15, 2.0)
        : (traffic ? clamp(traffic / FAST_HOT, 0.2, 1.5) : 0.3);
      const slot = 1 / (1 + 0.5 * Math.max(0, root.rcount + 1 - SLOT_FULL));
      const opportunity = r1((exposure + proof + 1) * freshness * slot);

      SNAP_NOW.push({ t: iso(), bvid: c.bvid, root_rpid: root.rpid, root_like: root.like, root_replies: root.rcount, view: viewCount, root_velocity: rootVelocity });

      targets.push({
        bvid: c.bvid,
        aid,
        source: c.source || c._f || 'cli',
        title: c.title || view.title || '',
        up: c.up || view.owner?.name || '',
        view: viewCount,
        reply: Number(stat.reply || c.reply || 0),
        age_hours: ageHours,
        traffic_per_hour: traffic === null ? null : r1(traffic),
        root_rpid: root.rpid,
        root_like: root.like,
        root_replies: root.rcount,
        root_uname: root.uname,
        root_text: root.text,
        root_age_hours: rootAgeHours,
        root_velocity: rootVelocity,
        root_lph_avg: rootLphAvg,
        reply_likes: th.likes.slice(0, 10),
        reply_texts: th.texts || [],
        reply_max: replyMax,
        reply_median: r1(replyMedian),
        reply_ge10: replyGe10,
        reply_fetched: th.fetched,
        signals: { exposure: r1(exposure), proof: r1(proof), freshness: r2(freshness), slot: r2(slot), explosion },
        opportunity,
        note: th.note || null,
        url: `https://www.bilibili.com/video/${c.bvid}/#reply${root.rpid}`,
        thread_url: `https://www.bilibili.com/video/${c.bvid}/?comment_on=1&comment_root_id=${root.rpid}`,
      });
    }
  }

  if (!targets.length && failures.length) {
    console.error(`[hotthread] 全部失败：${failures.length} 个视频取数失败`);
    for (const f of failures.slice(0, 5)) console.error(`  ${f.bvid} @${f.stage}: ${f.error}`);
    process.exit(2);
  }

  targets.sort((a, b) => b.opportunity - a.opportunity || b.root_like - a.root_like);
  const top = targets.slice(0, TOP);

  const out = {
    t: startedAt,
    source: 'hotthread.mjs',
    version: 3,
    formula:
      'opportunity = (root_like*0.35 + reply_median*2.5 + reply_max*0.8 + reply_ge10*3 + 1) * freshness * slot；' +
      'freshness=clamp(explosion/50,0.15,2.0)，explosion=根评论增速(赞/h，快照差分)或 root_like/root_age_hours 兜底，无数据时退回 clamp((view/age_hours)/5000,0.2,1.5)；' +
      'slot=1/(1+0.5*max(0,rcount+1-4))',
    params: {
      golden: GOLDEN,
      min_like: MIN_LIKE,
      max_rcount: MAX_RCOUNT,
      max_age: MAX_AGE,
      min_root_velocity: MIN_ROOT_VEL,
      top: TOP,
      include_commented: INCLUDE_COMMENTED,
      videos_scanned: cands.length,
      requests: req,
      failures: failures.length,
      skipped_by_age: skipped.length,
      snapshots_prev: SNAP_PREV.size,
    },
    note: '楼内回复的赞数（reply_median / reply_max / reply_ge10）比根评论赞数更能预测"回复能不能拿到赞"；root_velocity 是楼在爆炸的直接证据',
    targets: top,
    skipped,
    failures,
  };

  /* 覆盖保护：`--bvid` 单视频试跑曾把 18 个视频的扫描结果冲成 1 个（DECISIONS D12）。
     新结果明显更小且旧结果还新鲜时，默认不覆盖，除非 --force。 */
  let wrote = false;
  if (top.length) {
    const prev = readJson(OUT, null);
    const prevAgeH = prev && prev.t ? (Date.now() - Date.parse(prev.t)) / 3600000 : Infinity;
    const shrink = prev && Array.isArray(prev.targets) && top.length < prev.targets.length;
    if (shrink && prevAgeH < 6 && !FORCE_WRITE) {
      console.error(
        `[hotthread] ⚠ 本次只有 ${top.length} 个目标（旧结果 ${prev.targets.length} 个、${Math.round(prevAgeH * 60)} 分钟前），不覆盖 ${path.relative(ROOT, OUT)}；确认要覆盖请加 --force`,
      );
    } else {
      writeAtomic(OUT, JSON.stringify(out, null, 2) + '\n');
      wrote = true;
    }
  }

  /* 落盘快照，供下一轮算增速 */
  if (SNAP_NOW.length) {
    fs.mkdirSync(path.dirname(SNAPS), { recursive: true });
    fs.appendFileSync(SNAPS, SNAP_NOW.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }

  console.error(`[hotthread] v3 ${startedAt}${GOLDEN ? '  [golden]' : ''}`);
  console.error(`  扫描视频 ${cands.length} 个（本月已评论 ${commented.size} 个${INCLUDE_COMMENTED ? '，已包含' : '，默认跳过'}）· 请求 ${req} 次 · 历史快照 ${SNAP_PREV.size} 条`);
  console.error(`  可用热楼 ${top.length} 条（根赞 ≥ ${MIN_LIKE}、楼内 ≤ ${MAX_RCOUNT}、发布 ≤ ${MAX_AGE}h、增速 ≥ ${MIN_ROOT_VEL}/h），失败 ${failures.length}，超龄跳过 ${skipped.length}`);
  top.forEach((t, i) => {
    console.error(
      `  ${String(i + 1).padStart(2)}. 机会 ${String(t.opportunity).padStart(6)} · 根赞 ${String(t.root_like).padStart(4)}${t.root_age_hours ? '/' + t.root_age_hours + 'h' : ''} · 增速 ${String(t.signals.explosion ?? '-').padStart(6)}/h · 楼内中位 ${String(t.reply_median).padStart(4)}${t.reply_max ? '/' + t.reply_max : ''} · 位次 ${t.root_replies + 1} · ${t.bvid}`,
    );
    console.error(`      ${t.root_uname}：${t.root_text.slice(0, 56)}`);
  });
  if (top.length) console.error(wrote ? `  已写入 ${path.relative(ROOT, OUT)} 与 ${path.relative(ROOT, SNAPS)}` : `  未覆盖 ${path.relative(ROOT, OUT)}（见上方警告）`);

  if (has('print') && top.length) {
    console.log('\n=== 建议回复位置（按机会分）===');
    for (const t of top) {
      console.log(`\n[${t.bvid}] ${t.title}`);
      console.log(`  视频：播放 ${t.view} · 评论 ${t.reply} · 发布 ${t.age_hours}h · ${t.traffic_per_hour} 播放/h`);
      console.log(`  根评论 ${t.root_rpid}（${t.root_like} 赞 / 存活 ${t.root_age_hours}h / 增速 ${t.signals.explosion ?? '-'}-${t.root_velocity ?? '-'} 赞每小时 / ${t.root_replies} 条回复）：${t.root_text}`);
      console.log(`  楼内战绩：${t.reply_likes.length ? t.reply_likes.join(' / ') + ' 赞' : '无回复'} → 中位 ${t.reply_median} · 最高 ${t.reply_max} · ≥10 赞 ${t.reply_ge10} 条`);
      if (t.reply_texts.length) {
        for (const r of t.reply_texts.slice(0, 4)) console.log(`     楼内 ${String(r.like).padStart(3)} 赞 ${r.text.slice(0, 50)}`);
      }
      console.log(`  信号：exposure ${t.signals.exposure} · proof ${t.signals.proof} · freshness ×${t.signals.freshness} · slot ×${t.signals.slot}`);
      console.log(`  打开：${t.thread_url}`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('[hotthread] 异常：', e);
  process.exit(2);
});
