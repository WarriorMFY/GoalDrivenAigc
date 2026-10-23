// Tool/bili/lib.mjs —— 共享底层：取数、哈希、时间、序列化、压缩
// 零依赖，Node >= 18（本机 v24）。B站只能走 Node fetch，PowerShell TLS 会失败。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const VERSION = 'bili-tool/1.0.0';
export const BILI_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(BILI_DIR, '..', '..');
export const HISTORY = path.join(ROOT, 'History');
export const GOAL_MD = path.join(ROOT, 'Goal', 'Goal.md');

// 目录布局集中定义于此：任何脚本都不得再手写 History 下的路径。
// 规则：History 根目录只留 history.md（唯一入口），其余按用途归类。
export const P = {
  root: HISTORY,
  entry: path.join(HISTORY, 'history.md'),
  index: path.join(HISTORY, 'index', 'snap_index.json'),
  snapshots: path.join(HISTORY, 'snapshots'),
  stream: path.join(HISTORY, 'stream'),
  samples: path.join(HISTORY, 'stream', 'samples.ndjson'),
  latest: path.join(HISTORY, 'stream', 'latest.md'),
  events: path.join(HISTORY, 'events', 'events.ndjson'),
  runs: path.join(HISTORY, 'runs'),
  log: path.join(HISTORY, 'runs', 'collector.log'),
  rounds: path.join(HISTORY, 'runs', 'l2_rounds.ndjson'),
  done: path.join(HISTORY, 'runs', 'DONE.flag'),
  reports: path.join(HISTORY, 'reports'),
  trendReport: path.join(HISTORY, 'reports', 'trend_report.md'),
  trendLog: path.join(HISTORY, 'reports', 'trend_log.md'),
  practice: path.join(HISTORY, 'reports', 'browse_practice.md'),
  checks: path.join(HISTORY, 'checks'),
  verdict: path.join(HISTORY, 'checks', 'verdict.json'),
  budgetSnapshot: path.join(HISTORY, 'checks', 'budget_snapshot.json'),
  expCompress: path.join(HISTORY, 'checks', 'exp_compress.json'),
  probeRisk: path.join(HISTORY, 'checks', 'probe_risk.json'),
};

// 匿名可用的最小请求头集（实测无 cookie 即可取公开数据；-352 时靠退避而非换号）
export const HDRS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com/',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

// ranking/v2 的 -352 是"请求指纹"规则，不是 IP 配额：
//   桌面 UA + Referer: bilibili.com  → -352（2026-10-23 08:00 前后实测）
//   桌面 UA 无 Referer / 移动 UA     → code=0，100 条正常
// 故 ranking 单独用不带 Referer 的头。
export const HDRS_RANK = {
  'User-Agent': HDRS['User-Agent'],
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pad = (n, w = 2) => String(n).padStart(w, '0');
export const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });
export const byteLen = (v) => Buffer.byteLength(String(v), 'utf8');
export const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

export function fmtStamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
export function fmtIso(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = pad(Math.floor(Math.abs(off) / 60));
  const mm = pad(Math.abs(off) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hh}:${mm}`;
}

export function readJson(p, def = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}
export function writeFileAtomic(p, data) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}
export function writeJson(p, obj) { writeFileAtomic(p, JSON.stringify(obj, null, 1)); }

// token 估算：CJK 1 字≈1 token，其余 3.5 字符≈1 token。用于 E6 对照实验，非计费口径。
export function estTokens(s) {
  const str = String(s);
  const cjk = (str.match(/[\u3000-\u9fff\uff00-\uffef]/gu) || []).length;
  const rest = str.length - cjk;
  return Math.round(cjk + rest / 3.5);
}

// 紧凑数值：1.2万 / 3.4亿
export function fnum(v) {
  const n = Number(v) || 0;
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return String(n);
}

export function cut(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) : t;
}

// 带退避的取数：-352/-412/网络异常都重试，退避 6s、20s
export async function fetchJson(url, opts = {}) {
  const retries = opts.retries ?? 3;
  const backoff = opts.backoff ?? [0, 6000, 20000];
  const log = [];
  let text = '';
  let http = 0;
  let code = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
    try {
      const r = await fetch(url, { headers: opts.headers ?? HDRS, signal: AbortSignal.timeout(20000) });
      http = r.status;
      text = await r.text();
      let j = null;
      try { j = JSON.parse(text); } catch { j = null; }
      code = j?.code ?? null;
      log.push({ attempt, http, code, bytes: byteLen(text) });
      if (http === 200 && j && j.code === 0) {
        return { ok: true, code, data: j.data, text, bytes: byteLen(text), attempts: attempt + 1, log };
      }
      // -352 是分钟级冷却：冷却期内继续重打只会延长封锁（实测 3 次退避反而加重）。
      // 立即放弃，交给下一个采样周期再说。
      if (code === -352 || code === -412) break;
    } catch (e) {
      log.push({ attempt, http, error: String(e?.message || e) });
    }
  }
  return { ok: false, code, data: null, text, bytes: byteLen(text), attempts: retries, log };
}

// 原始条目归一化：字段固定，供 M2 校验
export function normalize(list, src, limit = Infinity) {
  return (Array.isArray(list) ? list : []).slice(0, limit).map((it, i) => ({
    rank: i + 1,
    bvid: it.bvid || '',
    aid: it.aid || 0,
    title: cut(it.title, 120),
    owner: cut(it.owner?.name, 40),
    view: it.stat?.view ?? 0,
    like: it.stat?.like ?? 0,
    coin: it.stat?.coin ?? 0,
    fav: it.stat?.favorite ?? 0,
    reply: it.stat?.reply ?? 0,
    danmaku: it.stat?.danmaku ?? 0,
    pubdate: it.pubdate ?? 0,
    zone: it.tname || '',
    src,
  }));
}

export const CSV_FIELDS = ['src', 'rank', 'bvid', 'title', 'owner', 'view', 'like', 'coin', 'fav', 'reply', 'danmaku', 'pubdate', 'zone'];

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(rows) {
  const head = CSV_FIELDS.join(',');
  const body = rows.map((r) => CSV_FIELDS.map((f) => csvCell(r[f])).join(','));
  return `${head}\n${body.join('\n')}\n`;
}
export function readCsv(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const lines = txt.split('\n').filter(Boolean);
  const head = parseCsvLine(lines[0]);
  return lines.slice(1).map((ln) => {
    const cells = parseCsvLine(ln);
    const o = {};
    head.forEach((h, i) => { o[h] = cells[i]; });
    ['rank', 'view', 'like', 'coin', 'fav', 'reply', 'danmaku', 'pubdate'].forEach((k) => { o[k] = Number(o[k]) || 0; });
    return o;
  });
}
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') { q = false; } else cur += c;
    } else if (c === '"') { q = true; } else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

// 从 Goal.md 读时间窗（只读；Goal.md 仅用户可写）
export function goalWindow() {
  const txt = fs.existsSync(GOAL_MD) ? fs.readFileSync(GOAL_MD, 'utf8') : '';
  const grab = (label) => {
    const m = txt.match(new RegExp(`\\*\\*${label}\\*\\*：\\s*(\\d{4})年(\\d{1,2})月(\\d{1,2})日(\\d{1,2}):(\\d{2}):(\\d{2})`));
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m;
    return new Date(+y, +mo - 1, +d, +h, +mi, +s);
  };
  return { start: grab('开始'), end: grab('结束'), raw: txt };
}

// 计划时段：窗口内 × 每日 slots（本地时区）
export function expectedSlots(cfg) {
  const start = new Date(cfg.window.start);
  const end = new Date(cfg.window.end);
  const out = [];
  for (let cur = new Date(start.getFullYear(), start.getMonth(), start.getDate()); cur <= end; cur.setDate(cur.getDate() + 1)) {
    for (const h of cfg.slots) {
      const t = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), h, 0, 0, 0);
      if (t >= start && t < end) out.push(t);
    }
  }
  return out.sort((a, b) => a - b);
}
