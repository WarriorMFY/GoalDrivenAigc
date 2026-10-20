#!/usr/bin/env node
/**
 * 评论台账 (Ledger) —— 口径 B 的归因层
 *
 * 为什么需要它：card.like_num 是"账号总获赞"，无法回答"这 50 个赞是不是本周评论挣的"。
 * 台账逐条记录你发的评论 (bvid + rpid)，定期回查每条评论的赞数。
 *
 * 数据来源（全部免登录）：
 *   GET /x/web-interface/view?bvid=<BV>          -> data.aid
 *   GET /x/v2/reply/main?type=1&oid=<aid>&mode=2 -> 最新评论（时间倒序），带 like
 *
 * ⚠ 已知限制：B 站没有公开的"按 rpid 单查"接口（/x/v2/reply/detail 返回 -400），
 *   只能从最新评论往前翻页找。所以评论发出后必须**尽快**登记并首次 sync，
 *   一旦沉到几十页之后就会 MISSING。台账用 first_seen_lag 量化这个衰减。
 *
 * 用法：
 *   node Tool/bili/ledger.mjs add --bvid BV1xx --rpid 123456789 [--text "评论内容"]
 *        可选归因标签：--style short-punch|long-arg|question|info  --thread-size 264（根评论当时赞数）
 *   node Tool/bili/ledger.mjs sync [--pages 10]      # 回查所有登记评论的赞数
 *   node Tool/bili/ledger.mjs set --rpid 123 --like 7 # 手工修正（页面肉眼可见时）
 *   node Tool/bili/ledger.mjs label --rpid 123 --style short-punch --thread-size 264  # 补归因标签（不动赞数）
 *   node Tool/bili/ledger.mjs report                 # 汇总：sum_like / 未解释增量
 *   node Tool/bili/ledger.mjs list
 *
 * 退出码：0 成功；2 取数/解析失败；3 参数错误。
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
const cmd = argv[0];
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

const dateOnly = (s) => String(s).slice(0, 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 路径 ---------------- */
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}
const config = loadConfig();
const win = config.window || {};
const target = Number(config.target ?? 50);

const outArg = opt('out');
const outDir =
  typeof outArg === 'string'
    ? path.resolve(process.cwd(), outArg)
    : config.outDir
      ? path.resolve(ROOT, config.outDir)
      : path.join(ROOT, 'History');
const EVENTS = path.join(outDir, 'comments.ndjson');
const SUMMARY = path.join(outDir, 'ledger.json');
const SENSOR_STATE = path.join(outDir, 'state.json');

/* ---------------- IO ---------------- */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readEvents() {
  try {
    return fs
      .readFileSync(EVENTS, 'utf8')
      .replace(/^\uFEFF/, '')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function appendEvent(ev) {
  fs.mkdirSync(path.dirname(EVENTS), { recursive: true });
  fs.appendFileSync(EVENTS, JSON.stringify(ev) + '\n');
}

/* ---------------- HTTP ---------------- */
async function getJson(url, referer) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Referer: referer || 'https://www.bilibili.com/', Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function resolveAid(bvid) {
  const j = await getJson('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid),
    'https://www.bilibili.com/video/' + bvid);
  if (j.code !== 0) throw new Error(`view code=${j.code} ${j.message || ''}`.trim());
  return { aid: j.data.aid, title: j.data.title };
}

/**
 * 从"最新评论"往前翻页，找出目标 rpid 的赞数。
 * 返回 Map<rpid, like>；未找到的不在 map 里。
 */
async function scanOid(aid, targets, maxPages) {
  const found = new Map();
  const want = new Set(targets.map(String));
  let next = '0';
  let pages = 0;
  let scanned = 0;
  const base = 'https://api.bilibili.com/x/v2/reply/main?type=1&oid=' + aid + '&mode=2';

  while (pages < maxPages && want.size > 0) {
    const j = await getJson(base + '&next=' + encodeURIComponent(next));
    if (j.code !== 0) throw new Error(`reply/main code=${j.code} ${j.message || ''}`.trim());
    const replies = (j.data && j.data.replies) || [];
    pages++;
    scanned += replies.length;
    for (const r of replies) {
      const id = String(r.rpid);
      if (want.has(id)) {
        found.set(id, r.like);
        want.delete(id);
      }
    }
    const cur = (j.data && j.data.cursor) || {};
    if (cur.is_end) break;
    const nxt = cur.next;
    if (nxt === undefined || nxt === null || String(nxt) === String(next)) break;
    next = String(nxt);
    await sleep(250);
  }
  return { found, pages, scanned };
}

/**
 * 楼中楼（回复某条热评）：曝光继承自根评论，不受顶层热度排序埋没。
 * 通过 /x/v2/reply/reply?root= 拿该楼层下的回复。
 */
async function scanReply(oid, root, targets, maxPages) {
  const found = new Map();
  const want = new Set(targets.map(String));
  let pages = 0;
  let scanned = 0;
  for (let pn = 1; pn <= maxPages && want.size > 0; pn++) {
    const j = await getJson(
      `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${oid}&root=${root}&ps=20&pn=${pn}`,
    );
    if (j.code !== 0) break;
    const subs = (j.data && j.data.replies) || [];
    pages++;
    scanned += subs.length;
    for (const r of subs) {
      const id = String(r.rpid);
      if (want.has(id)) {
        found.set(id, r.like);
        want.delete(id);
      }
    }
    if (subs.length < 20) break;
    await sleep(250);
  }
  return { found, pages, scanned };
}

/* ---------------- 台账派生 ---------------- */

/* 评论已存活小时数：给"赞是多久攒起来的"一个分母，也用于按风格归因 */
function ageHours(at) {
  const ms = Date.now() - Date.parse(at);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.round(ms / 36000) / 100;
}

function derive() {
  const events = readEvents();
  const map = new Map();
  for (const ev of events) {
    const id = String(ev.rpid ?? '');
    if (!id) continue;
    if (ev.type === 'add') {
      /* add = 登记/重置，与 audit.mjs 的独立派生保持同一语义（audit 逐事件重放，遇到 add 就把该 rpid 清空）。
         只想补标签时用 `label` 命令，**不要重复 add**，否则赞数历史会被重置。 */
      map.set(id, {
        rpid: id,
        oid: ev.oid ?? null,
        bvid: ev.bvid ?? null,
        root: ev.root ?? null,
        text: ev.text ?? null,
        style: ev.style ?? null,
        thread_size: ev.thread_size ?? null,
        posted_at: ev.posted_at ?? ev.t,
        like: null,
        found: false,
        first_seen_at: null,
        last_check_at: null,
        checks: 0,
        history: [],
      });
    } else if (ev.type === 'label') {
      /* 只补归因标签/修正 posted_at，不动赞数历史；对 audit 的派生无影响（label 事件不带 like） */
      const e = map.get(id);
      if (!e) continue;
      if (ev.style) e.style = ev.style;
      if (ev.thread_size !== undefined && ev.thread_size !== null) e.thread_size = ev.thread_size;
      if (ev.at) e.posted_at = ev.at;
    } else if (ev.type === 'sync' || ev.type === 'set') {
      const e = map.get(id);
      if (!e) continue;
      e.checks += 1;
      e.last_check_at = ev.t;
      if (ev.found) {
        e.like = ev.like;
        e.found = true;
        if (!e.first_seen_at) e.first_seen_at = ev.t;
      }
      if (ev.like !== undefined && ev.like !== null) e.like = ev.like;
      e.history.push({ t: ev.t, like: ev.like ?? null, found: !!ev.found });
    }
  }
  return [...map.values()];
}

function inWindow(postedAt) {
  const d = dateOnly(postedAt);
  if (win.start && d < win.start) return false;
  if (win.end && d > win.end) return false;
  return true;
}

/* ---------------- 命令 ---------------- */
async function main() {
  if (!cmd || ['help', '-h', '--help'].includes(cmd)) {
    console.log('用法：add | sync | set | report | list （见文件头注释）');
    process.exit(cmd ? 0 : 3);
  }

  if (cmd === 'add') {
    const bvid = opt('bvid');
    const rpid = opt('rpid');
    if (typeof bvid !== 'string' || !/^BV[0-9A-Za-z]+$/.test(bvid)) {
      console.error('[ledger] 缺少或非法 --bvid（形如 BV1xx411c7mD）');
      process.exit(3);
    }
    if (typeof rpid !== 'string' || !/^\d+$/.test(rpid)) {
      console.error('[ledger] 缺少或非法 --rpid（评论链接末尾 #reply<数字>）');
      process.exit(3);
    }
    const { aid, title } = await resolveAid(bvid);
    const text = typeof opt('text') === 'string' ? opt('text') : null;
    const posted_at = typeof opt('at') === 'string' ? opt('at') : iso();

    /* 归因标签（可选，非判据）：只为事后回答"什么样的评论能拿到赞"。
       --style     建议值 short-punch（短梗）| long-arg（长论证）| question（提问）| info（补充信息）
       --thread-size  发布时根评论的赞数，用于区分"蹭大热楼"与"蹭小楼" */
    const styleArg = opt('style');
    const style = typeof styleArg === 'string' ? styleArg.trim().slice(0, 24) : null;
    const tsArg = opt('thread-size');
    const threadSize =
      typeof tsArg === 'boolean' || tsArg === null || Number.isNaN(Number(tsArg))
        ? null
        : Number(tsArg);

    /* 自动判定层级：把 rpid 当作 root 去查，若返回的 root.rpid 就是它本身 → 顶层评论；
       否则说明它挂在某个楼层下，真正的 root 是返回值。 */
    let root = typeof opt('root') === 'string' ? opt('root') : null;
    const rootGiven = root;
    let detected = 'unknown';
    try {
      const j = await getJson(
        `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${aid}&root=${rpid}&ps=1&pn=1`,
      );
      if (j.code === 0 && j.data && j.data.root) {
        if (String(j.data.root.rpid) === String(rpid)) {
          detected = 'top';
          if (!rootGiven) root = null;
        } else {
          detected = 'reply';
          if (!rootGiven) root = String(j.data.root.rpid);
        }
      }
    } catch {
      /* 探测失败不影响登记 */
    }
    if (rootGiven && detected === 'top') {
      console.log(`⚠ 实际层级不符：这条是**顶层评论**，不在你指定的楼层 ${rootGiven} 下。`);
      console.log(`  顶层评论会按热度排序，评论数多时必然沉底；楼中楼才有曝光继承。`);
      root = null; /* 按真实层级登记，保证 sync 能查到 */
      process.exitCode = 4;
    }

    const existing = derive().find((e) => e.rpid === rpid);
    if (existing) {
      console.log(`⚠ rpid=${rpid} 已经登记过（like=${existing.like ?? '-'}）。重复 add 会**重置**它的赞数历史。`);
      console.log(`  只想补归因标签请改用：node Tool\\bili\\ledger.mjs label --rpid ${rpid} --style <风格> --thread-size <数字>`);
    }

    const ev = { type: 'add', t: iso(), rpid, oid: aid, bvid, root, kind: detected, text, posted_at, title, style, thread_size: threadSize };
    appendEvent(ev);
    console.log(`[ledger] 已登记 rpid=${rpid}  ${bvid} (aid=${aid})  《${String(title).slice(0, 30)}》`);
    console.log(`         层级：${detected === 'reply' ? '楼中楼（root=' + root + '）' : detected === 'top' ? '顶层评论' : '未探测成功'}`);
    if (style || threadSize !== null) console.log(`         标签：style=${style ?? '-'} thread_size=${threadSize ?? '-'}`);
    console.log(`         评论链接：https://www.bilibili.com/video/${bvid}/#reply${rpid}`);
    console.log(`         ⚠ 请尽快执行 sync，越晚越可能沉底找不到`);
    process.exit(rootGiven && detected === 'top' ? 4 : 0);
  }

  if (cmd === 'sync') {
    const pages = Math.min(50, Math.max(1, Number(opt('pages') ?? 10)));
    const entries = derive();
    if (!entries.length) {
      console.error('[ledger] 台账为空，先 add');
      process.exit(3);
    }
    const byOid = new Map();
    for (const e of entries) {
      if (!e.oid) continue;
      if (!byOid.has(e.oid)) byOid.set(e.oid, []);
      byOid.get(e.oid).push(e);
    }
    let totalFound = 0;
    let totalMiss = 0;

    const report = (e, like, missMsg) => {
      appendEvent({ type: 'sync', t: iso(), rpid: e.rpid, oid: e.oid, found: like !== undefined, like: like ?? null });
      if (like !== undefined) {
        totalFound++;
        console.log(`  ✓ rpid=${e.rpid}  like=${like}${e.root ? '  [楼中楼]' : ''}`);
      } else {
        totalMiss++;
        console.log(`  ✗ rpid=${e.rpid}  ${missMsg}${e.root ? '  [楼中楼]' : ''}`);
      }
    };

    for (const [oid, list] of byOid) {
      /* 顶层评论：从"最新"往前翻页找 */
      const topLevel = list.filter((e) => !e.root);
      if (topLevel.length) {
        let res;
        try {
          res = await scanOid(oid, topLevel.map((e) => e.rpid), pages);
          for (const e of topLevel) {
            report(e, res.found.get(e.rpid), `未在前 ${res.pages} 页(${res.scanned} 条)中找到，可能已沉底`);
          }
        } catch (err) {
          console.error(`[ledger] oid=${oid} 顶层扫描失败：${err.message}`);
        }
      }

      /* 楼中楼：按 root 分组，走 /x/v2/reply/reply */
      const nested = list.filter((e) => e.root);
      const byRoot = new Map();
      for (const e of nested) {
        if (!byRoot.has(e.root)) byRoot.set(e.root, []);
        byRoot.get(e.root).push(e);
      }
      for (const [root, group] of byRoot) {
        await sleep(300);
        try {
          const res = await scanReply(oid, root, group.map((e) => e.rpid), 5);
          for (const e of group) {
            report(e, res.found.get(e.rpid), `未在该楼层 ${res.pages} 页(${res.scanned} 条)中找到，可能被折叠`);
          }
        } catch (err) {
          console.error(`[ledger] root=${root} 楼中楼扫描失败：${err.message}`);
        }
      }
    }
    console.log(`[ledger] sync 完成：找到 ${totalFound}，未找到 ${totalMiss}`);
    process.exit(0);
  }

  if (cmd === 'set') {
    const rpid = opt('rpid');
    const like = opt('like');
    if (typeof rpid !== 'string' || !/^\d+$/.test(rpid)) {
      console.error('[ledger] 缺少或非法 --rpid');
      process.exit(3);
    }
    if (like === null || Number.isNaN(Number(like))) {
      console.error('[ledger] 缺少 --like <整数>');
      process.exit(3);
    }
    appendEvent({ type: 'set', t: iso(), rpid, found: true, like: Number(like) });
    console.log(`[ledger] 手工登记 rpid=${rpid} like=${like}`);
    process.exit(0);
  }

  if (cmd === 'label') {
    /* 补归因标签：不取网络、不动赞数历史。用于给旧评论回填 style / thread_size */
    const rpid = opt('rpid');
    if (typeof rpid !== 'string' || !/^\d+$/.test(rpid)) {
      console.error('[ledger] 缺少或非法 --rpid');
      process.exit(3);
    }
    const styleArg = opt('style');
    const style = typeof styleArg === 'string' ? styleArg.trim().slice(0, 24) : null;
    const tsArg = opt('thread-size');
    const threadSize =
      typeof tsArg === 'boolean' || tsArg === null || Number.isNaN(Number(tsArg)) ? null : Number(tsArg);
    const atArg = opt('at');
    const at = typeof atArg === 'string' ? atArg : null;
    if (!style && threadSize === null && !at) {
      console.error('[ledger] label 至少需要 --style / --thread-size / --at 之一');
      process.exit(3);
    }
    const all = derive();
    if (!all.some((e) => e.rpid === rpid)) {
      console.error(`[ledger] 台账里没有 rpid=${rpid}，先 add`);
      process.exit(3);
    }
    appendEvent({ type: 'label', t: iso(), rpid, style, thread_size: threadSize, at });
    console.log(`[ledger] 已补标签 rpid=${rpid}  style=${style ?? '-'}  thread_size=${threadSize ?? '-'}  posted_at=${at ?? '(不变)'}`);
    process.exit(0);
  }

  if (cmd === 'report' || cmd === 'list') {
    const entries = derive();
    const inWin = entries.filter((e) => inWindow(e.posted_at));
    const sumLike = inWin.reduce((a, e) => a + (e.like || 0), 0);
    const tracked = inWin.filter((e) => e.found).length;
    const missing = inWin.length - tracked;

    let sensor = null;
    try {
      sensor = JSON.parse(fs.readFileSync(SENSOR_STATE, 'utf8'));
    } catch {
      sensor = null;
    }
    const likeDelta = sensor && typeof sensor.delta === 'number' ? sensor.delta : null;

    /* 判定只认评论台账。
       B站主页"获赞"= 视频/专栏/动态/相册的获赞，**不含评论获赞**
       （实测：某用户单条评论 3,160 赞，主页 like_num 仅 195），因此不能用它判定本目标。 */
    const today = dateOnly(iso());
    let phase = 'ACTIVE';
    if (win.start && today < win.start) phase = 'NOT_STARTED';
    else if (win.end && today > win.end) phase = 'CLOSED';
    let verdict;
    if (phase === 'NOT_STARTED') verdict = 'NOT_STARTED';
    else if (sumLike >= target) verdict = 'PASS';
    else if (phase === 'CLOSED') verdict = 'FAILED';
    else verdict = 'GAP';

    const summary = {
      t: iso(),
      window: { start: win.start ?? null, end: win.end ?? null },
      phase,
      verdict,
      metric: 'comment_like_sum',
      target,
      comments_in_window: inWin.length,
      tracked,
      missing,
      sum_like: sumLike,
      gap: Math.max(0, target - sumLike),
      content_like_delta: likeDelta,
      content_like_note:
        likeDelta === null
          ? '未取到内容获赞（不影响本判定）'
          : likeDelta > 0
            ? `内容获赞 +${likeDelta}：来自视频/动态/相册，按口径不计入评论目标`
            : '内容获赞无变化',
      comments: inWin
        .slice()
        .sort((a, b) => String(a.posted_at).localeCompare(String(b.posted_at)))
        .map((e) => ({
          rpid: e.rpid, bvid: e.bvid, posted_at: e.posted_at,
          like: e.like, found: e.found, checks: e.checks,
          last_check_at: e.last_check_at,
          root: e.root ?? null,
          style: e.style ?? null,
          thread_size: e.thread_size ?? null,
          age_hours: ageHours(e.posted_at),
          like_per_hour:
            e.like != null && ageHours(e.posted_at)
              ? Math.round((e.like / ageHours(e.posted_at)) * 100) / 100
              : null,
          url: e.bvid ? `https://www.bilibili.com/video/${e.bvid}/#reply${e.rpid}` : null,
          text: e.text,
        })),
    };
    /* list 只读：不重写汇总文件 */
    if (cmd === 'list') {
      console.log(`[ledger] 窗口 ${win.start} ~ ${win.end}   共 ${inWin.length} 条（已定位 ${tracked}）`);
      for (const e of inWin) {
        console.log(
          `  ${e.found ? '✓' : '✗'} ${String(e.like ?? '-').padStart(4)}  ${String(e.posted_at).slice(0, 16)}  rpid=${e.rpid}  ${e.bvid}`,
        );
      }
      process.exit(0);
    }

    writeAtomic(SUMMARY, JSON.stringify(summary, null, 2) + '\n');

    console.log(`[ledger] ${summary.t}  窗口 ${win.start} ~ ${win.end}  (${phase})`);
    console.log(`  本周评论 : ${inWin.length} 条（已定位 ${tracked}，未定位 ${missing}）`);
    console.log(`  评论获赞 : ${sumLike} / 目标 ${target}   还差 ${summary.gap}   → 判定 ${verdict}`);
    console.log(`  内容获赞 : ${summary.content_like_note}`);
    for (const c of summary.comments) {
      const mark = c.found ? '✓' : '✗';
      console.log(`   ${mark} ${String(c.like ?? '-').padStart(4)}  ${c.posted_at.slice(0, 16)}  ${c.style ? '[' + c.style + '] ' : ''}${c.url}`);
    }
    console.log(`  汇总已写入 ${path.relative(ROOT, SUMMARY)}`);
    process.exit(0);
  }

  console.error(`[ledger] 未知命令：${cmd}`);
  process.exit(3);
}

main().catch((e) => {
  console.error('[ledger] 失败：', e && e.message ? e.message : e);
  process.exit(2);
});
