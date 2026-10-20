#!/usr/bin/env node
/**
 * 资产入库 (Proven) —— 把"已验证拿到赞的评论"收进资产库
 *
 * 用途：用户在 Tool\inbox\proven-links.md 贴评论分享链接，本脚本解析并入库，
 *       形成可复用（适配到新视频）的自有资产，而不是搬运他人热评。
 *
 * 技术要点（实测）：
 *   GET /x/v2/reply/reply?type=1&oid=<aid>&root=<rpid>
 *     → data.root 直接给出该顶层评论的 like 与原文，无需翻页扫描
 *   → 楼中楼：分享链接里带 comment_root_id，用 root 定位楼层后在其中找 rpid
 *
 * 用法：
 *   node Tool\bili\proven.mjs                     # 读 Tool\inbox\proven-links.md
 *   node Tool\bili\proven.mjs --file 其它文件
 *   node Tool\bili\proven.mjs --link "https://b23.tv/xxx"   # 临时加一条
 *   node Tool\bili\proven.mjs --dry               # 只解析打印，不入库
 *
 * 产物：History\proven.ndjson（追加式，按 rpid 去重）
 * 退出码：0 成功；2 解析/取数失败；3 没有可解析的链接
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}
const config = loadConfig();
const outArg = opt('out');
const outDir = typeof outArg === 'string'
  ? path.resolve(process.cwd(), outArg)
  : config.outDir ? path.resolve(ROOT, config.outDir) : path.join(ROOT, 'History');
const STORE = path.join(outDir, 'proven.ndjson');

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Accept: 'application/json' },
    });
    const text = await r.text();
    if (text.trim().startsWith('<')) throw new Error('风控返回 HTML');
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 链接解析 ---------------- */
function extractLinks(raw) {
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const trim = line.trim();
    if (!trim || trim.startsWith('#')) continue;
    const urls = trim.match(/https?:\/\/[^\s'"）)】]+/g) || [];
    const note = trim.replace(/https?:\/\/[^\s'"）)】]+/g, '').replace(/^[\s#-]+/, '').trim();
    for (const u of urls) out.push({ url: u, note });
  }
  return out;
}

async function resolveUrl(url) {
  let cur = url;
  for (let i = 0; i < 6; i++) {
    if (!/^https?:\/\/b23\.tv\//i.test(cur)) break;
    const r = await fetch(cur, { redirect: 'manual', headers: { 'User-Agent': UA } });
    const loc = r.headers.get('location');
    if (!loc) break;
    cur = loc.startsWith('http') ? loc : 'https://b23.tv' + loc;
  }
  return cur;
}

function parseTarget(url) {
  const bvid = (url.match(/\/video\/(BV[0-9A-Za-z]+)/) || [])[1] || null;
  const replyId = (url.match(/#reply(\d+)/) || [])[1] || null;
  const rootId = (url.match(/comment_root_id=(\d+)/) || [])[1] || null;
  return { bvid, replyId, rootId };
}

/* ---------------- 取数 ---------------- */
async function fetchComment(bvid, replyId, rootId) {
  const view = await getJson('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid);
  if (view.code !== 0) throw new Error(`view code=${view.code} ${view.message || ''}`);
  const d = view.data;
  const aid = d.aid;

  const isNestedHint = !!(rootId && replyId && String(rootId) !== String(replyId));
  const rootQuery = isNestedHint ? rootId : replyId;

  await sleep(400);
  const jr = await getJson(
    `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${aid}&root=${rootQuery}&ps=20&pn=1`,
  );
  if (jr.code !== 0) throw new Error(`reply/reply code=${jr.code} ${jr.message || ''}`);
  const rootObj = jr.data && jr.data.root;
  if (!rootObj) throw new Error('该 rpid 不是顶层评论，且未提供 comment_root_id');

  let target = null;
  let kind = 'top';
  let root = null;

  if (String(rootObj.rpid) === String(replyId)) {
    /* 顶层评论：data.root 就是要的这条 */
    target = rootObj;
    kind = 'top';
  } else {
    /* 楼中楼：data.root 是所在楼层，真正的目标在其 replies 里 */
    kind = 'reply';
    root = String(rootObj.rpid);
    const findIn = (arr) => (arr || []).find((r) => String(r.rpid) === String(replyId)) || null;
    target = findIn(jr.data.replies);
    for (let pn = 2; pn <= 5 && !target; pn++) {
      await sleep(400);
      const j2 = await getJson(
        `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${aid}&root=${root}&ps=20&pn=${pn}`,
      );
      if (j2.code !== 0) break;
      target = findIn(j2.data && j2.data.replies);
    }
  }

  if (!target) throw new Error('未取到该评论（可能已删除/被折叠，或楼层内翻不到）');

  return {
    bvid,
    oid: aid,
    kind,
    rpid: String(target.rpid),
    root: kind === 'reply' ? String(root) : null,
    text: (target.content && target.content.message) || '',
    like: target.like,
    author: target.member && target.member.uname,
    author_mid: target.mid,
    posted_at: target.ctime ? new Date(target.ctime * 1000).toISOString() : null,
    root_text: kind === 'reply' && rootObj ? (rootObj.content && rootObj.content.message) || '' : null,
    root_like: kind === 'reply' && rootObj ? rootObj.like : null,
    video: {
      title: d.title,
      up: d.owner && d.owner.name,
      view: d.stat ? d.stat.view : null,
      reply: d.stat ? d.stat.reply : null,
      pubdate: d.pubdate ? new Date(d.pubdate * 1000).toISOString() : null,
      duration: d.duration,
    },
  };
}

async function fetchTags(bvid) {
  try {
    const j = await getJson('https://api.bilibili.com/x/tag/archive/tags?bvid=' + bvid);
    return j.code === 0 ? (j.data || []).map((t) => t.tag_name) : [];
  } catch {
    return [];
  }
}

/* ---------------- 入库 ---------------- */
function readStore() {
  try {
    return fs
      .readFileSync(STORE, 'utf8')
      .replace(/^\uFEFF/, '')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function main() {
  const links = [];
  if (typeof opt('file') === 'string') {
    const f = path.resolve(process.cwd(), opt('file'));
    const raw = fs.readFileSync(f, 'utf8').replace(/```[\s\S]*?```/g, ''); // 去掉代码块里的示例链接
    links.push(...extractLinks(raw));
  } else if (typeof opt('link') === 'string') {
    links.push({ url: opt('link'), note: '' });
  } else {
    const f = path.join(ROOT, 'Tool', 'inbox', 'proven-links.md');
    if (!fs.existsSync(f)) {
      console.error('[proven] 找不到 ' + path.relative(ROOT, f) + '，用 --file 或 --link 指定');
      process.exit(3);
    }
    links.push(...extractLinks(fs.readFileSync(f, 'utf8').replace(/```[\s\S]*?```/g, '')));
  }

  if (!links.length) {
    console.error('[proven] 没有可解析的链接（在 Tool\\inbox\\proven-links.md 里贴一行一条）');
    process.exit(3);
  }

  const known = new Set(readStore().map((x) => x.rpid));
  const added = [];
  let failed = 0;

  for (const { url, note } of links) {
    try {
      const finalUrl = await resolveUrl(url);
      const t = parseTarget(finalUrl);
      if (!t.bvid || !t.replyId) throw new Error('链接里找不到 bvid 或 #reply 标识：' + finalUrl);
      const rec = await fetchComment(t.bvid, t.replyId, t.rootId);
      if (known.has(rec.rpid)) {
        console.log(`  = 已存在 rpid=${rec.rpid}，跳过`);
        continue;
      }
      const tags = await fetchTags(t.bvid);
      const row = { t: iso(), ...rec, tags, note: note || null, source_url: url, final_url: finalUrl };
      if (has('dry')) {
        console.log('  [dry] ' + JSON.stringify(row).slice(0, 300));
      } else {
        fs.mkdirSync(path.dirname(STORE), { recursive: true });
        fs.appendFileSync(STORE, JSON.stringify(row) + '\n');
      }
      added.push(row);
      known.add(rec.rpid);
      const rate = rec.video.view ? ((rec.like / rec.video.view) * 1000).toFixed(2) : 'n/a';
      console.log(`  ✓ ${rec.kind === 'reply' ? '楼中楼' : '顶层'} rpid=${rec.rpid}  ${rec.like} 赞  （每千播放 ${rate}）`);
      console.log(`     ${rec.text.replace(/\n/g, ' ').slice(0, 56)}`);
      await sleep(600);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${url}  ${e.message}`);
    }
  }

  const total = readStore().length;
  console.log('');
  console.log(`[proven] 新增 ${added.length} 条，失败 ${failed} 条，资产库共 ${total} 条`);
  if (added.length) {
    console.log(`  已写入 ${path.relative(ROOT, STORE)}`);
    const top = saved(added);
    console.log(`  本次最高赞：${top.like}  「${top.text.replace(/\n/g, ' ').slice(0, 40)}」`);
  }
  process.exit(failed && !added.length ? 2 : 0);
}

function saved(rows) {
  return rows.slice().sort((a, b) => b.like - a.like)[0];
}

main().catch((e) => {
  console.error('[proven] 失败：', e && e.message ? e.message : e);
  process.exit(2);
});
