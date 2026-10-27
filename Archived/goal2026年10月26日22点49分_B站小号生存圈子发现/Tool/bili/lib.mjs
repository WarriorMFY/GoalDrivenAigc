// lib.mjs —— B 站公开接口公共层：限速、重试、风控识别、落盘
//
// 职责边界：本文件不改判定口径，只保证"取到的数字可追溯、可复算"。
// 口径定义见 bili.md §3，取样参数见 config.json。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const BILI_DIR = HERE;

export const API = 'https://api.bilibili.com';
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadConfig() {
  const p = path.join(HERE, 'config.json');
  const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

// ---- 时间 ----
export function stampNow(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export function isoNow(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const p = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${p(off / 60)}:${p(off % 60)}`
  );
}

export function hoursBetween(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / 3600000;
}

// ---- 目录 ----
export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
export function historyPath(...seg) {
  return path.join(ROOT, 'History', ...seg);
}

// ---- 限速 ----
const throttleState = { lastAt: 0 };
export async function throttle(delayMs) {
  const wait = delayMs - (Date.now() - throttleState.lastAt);
  if (wait > 0) await sleep(wait);
  throttleState.lastAt = Date.now();
}

const HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
};

/**
 * 取一个 B 站 JSON 接口。
 * 返回 { ok, data, code, msg, url, attempts, error }
 * 风控识别：响应以 '<' 开头即 HTML 验证页 → 退避重试。
 */
export async function fetchJson(
  url,
  { delayMs = 400, jitterMs = 0, retries = 3, timeoutMs = 20000, riskBackoffMs = 20000, tag = '' } = {}
) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    await throttle(delayMs + (jitterMs > 0 ? Math.random() * jitterMs : 0));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let text = '';
    try {
      const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal, redirect: 'follow' });
      text = await res.text();
      clearTimeout(timer);
      if (!res.ok) {
        const risky = res.status === 412 || res.status === 429 || res.status === 403;
        lastErr = { ok: false, code: `HTTP_${res.status}`, msg: `HTTP ${res.status}`, url, attempts: attempt, risky };
        if (attempt < retries) {
          // 412/429/403 是风控：退避必须够长，否则重试等同继续撞墙
          await sleep((risky ? riskBackoffMs * attempt : 1500 * attempt) + Math.random() * 5000);
        }
        continue;
      }
    } catch (e) {
      clearTimeout(timer);
      lastErr = { ok: false, code: 'NETWORK', msg: String(e && e.message ? e.message : e), url, attempts: attempt };
      if (attempt < retries) await sleep(2000 * attempt);
      continue;
    }

    const head = text.trimStart().slice(0, 1);
    if (head === '<') {
      lastErr = {
        ok: false,
        code: 'RISK_HTML',
        msg: '返回 HTML（风控页）',
        url,
        attempts: attempt,
        sample: text.slice(0, 160),
      };
      if (attempt < retries) await sleep(riskBackoffMs * attempt + Math.random() * 5000);
      continue;
    }

    let json;
    try {
      json = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (e) {
      lastErr = { ok: false, code: 'BAD_JSON', msg: 'JSON 解析失败', url, attempts: attempt, sample: text.slice(0, 160) };
      if (attempt < retries) await sleep(2000 * attempt);
      continue;
    }

    if (json.code !== 0) {
      lastErr = { ok: false, code: `API_${json.code}`, msg: String(json.message || ''), url, attempts: attempt };
      // -412 风控 / -509 限流 → 长退避；其他错误码只做短退避
      if (attempt < retries) {
        const risky = json.code === -412 || json.code === -509 || json.code === -799;
        await sleep((risky ? riskBackoffMs * attempt : 1200 * attempt) + Math.random() * 4000);
      }
      continue;
    }

    return { ok: true, code: 0, data: json.data, url, attempts: attempt, tag };
  }
  return lastErr || { ok: false, code: 'UNKNOWN', msg: '未知失败', url, attempts: retries };
}

// ---- 端点 ----
export const urls = {
  search: (kw, page, order) =>
    `${API}/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(kw)}&order=${order}&page=${page}`,
  card: (mid) => `${API}/x/web-interface/card?mid=${mid}`,
  view: (bvid) => `${API}/x/web-interface/view?bvid=${bvid}`,
};

// ---- 作者粉丝缓存（同一次运行、跨关键词复用，省请求）----
export function makeCardCache(ttlHours = 6) {
  const dir = ensureDir(historyPath('cache'));
  const memo = new Map();
  return {
    dir,
    get(mid) {
      if (memo.has(mid)) return memo.get(mid);
      const f = path.join(dir, `card_${mid}.json`);
      if (fs.existsSync(f)) {
        try {
          const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
          if (hoursBetween(j.fetchedAt, new Date().toISOString()) < ttlHours) {
            memo.set(mid, j);
            return j;
          }
        } catch {
          /* 缓存坏了就重取 */
        }
      }
      return null;
    },
    set(mid, rec) {
      memo.set(mid, rec);
      fs.writeFileSync(path.join(dir, `card_${mid}.json`), JSON.stringify(rec), 'utf8');
    },
  };
}

// ---- 写盘 ----
export function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  return file;
}

export function appendNdjson(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
  return file;
}

export function readNdjson(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---- 统计 ----
export function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function rateOf(stat) {
  const play = Number(stat.play) || 0;
  if (play <= 0) return null;
  const inter =
    (Number(stat.like) || 0) + (Number(stat.reply) || 0) + (Number(stat.coin) || 0) + (Number(stat.favorite) || 0);
  return inter / play;
}

// ---- 终端输出 ----
export const log = (...a) => console.log(...a);
export function line(s = '') {
  console.log(s);
}
