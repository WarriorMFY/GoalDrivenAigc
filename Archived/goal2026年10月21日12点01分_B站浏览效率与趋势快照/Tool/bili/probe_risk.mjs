// Tool/bili/probe_risk.mjs —— 风控阈值探针：递增请求频率，找出安全间隔与触发点
// 用法：node Tool/bili/probe_risk.mjs
// 产物：History/probe_risk.json（含每阶段结果、触发点、恢复时长、params、sha256）
// 说明：单次探针 ≤ 40 请求；每阶段触发非 0 code 立即停止该阶段，并测恢复时间。
import { HISTORY, P, writeJson, sha256, byteLen, sleep, HDRS, fmtIso, VERSION } from './lib.mjs';
import path from 'node:path';

const URL = 'https://api.bilibili.com/x/web-interface/popular?ps=1&pn=1';
const PHASES = [
  { gap: 5000, n: 6, label: '5s×6' },
  { gap: 3000, n: 6, label: '3s×6' },
  { gap: 1000, n: 10, label: '1s×10' },
];

async function one() {
  const t = Date.now();
  try {
    const r = await fetch(URL, {
      headers: HDRS,
      signal: AbortSignal.timeout(15000),
    });
    const txt = await r.text();
    let code = null;
    try { code = JSON.parse(txt).code; } catch { code = 'nonjson'; }
    return { http: r.status, code, ms: Date.now() - t, bytes: byteLen(txt) };
  } catch (e) {
    return { http: 0, code: 'ERR', ms: Date.now() - t, err: String(e?.message || e) };
  }
}

const result = {
  script: 'Tool/bili/probe_risk.mjs',
  version: VERSION,
  at: fmtIso(new Date()),
  url: URL,
  params: { phases: PHASES },
  phases: [],
  trigger: null,
  safeGapMs: null,
  recoverySec: null,
};

for (const p of PHASES) {
  const recs = [];
  let tripped = false;
  for (let i = 0; i < p.n; i++) {
    if (i > 0) await sleep(p.gap);
    const r = await one();
    recs.push({ i, ...r });
    console.log(`${p.label} #${i} http=${r.http} code=${r.code} ${r.ms}ms`);
    if (r.code !== 0) { tripped = true; break; }
  }
  result.phases.push({ label: p.label, gapMs: p.gap, planned: p.n, sent: recs.length, tripped, codes: recs.map((x) => x.code), recs });
  if (tripped) {
    result.trigger = { phase: p.label, gapMs: p.gap, index: recs.length - 1, code: recs.at(-1).code };
    break;
  }
}

// 触发后测恢复：每 15s 探一次，最多 8 次（≤120s）
if (result.trigger) {
  const t0 = Date.now();
  for (let i = 0; i < 8; i++) {
    await sleep(15000);
    const r = await one();
    console.log(`恢复探测 #${i} code=${r.code} ${r.ms}ms`);
    if (r.code === 0) { result.recoverySec = Math.round((Date.now() - t0) / 1000); break; }
  }
}

// 安全间隔 = 最后一个全通过的阶段间隔
for (const ph of result.phases) {
  if (!ph.tripped) result.safeGapMs = Math.max(result.safeGapMs ?? 0, ph.gapMs);
}

const out = P.probeRisk;
const text = JSON.stringify(result, null, 1);
writeJson(out, { ...result, sha256: sha256(text) });

console.log('---');
console.log(`安全间隔 ${result.safeGapMs} ms；触发点 ${result.trigger ? `${result.trigger.phase} @#${result.trigger.index} code=${result.trigger.code}` : '未触发'}；恢复 ${result.recoverySec ?? '-'}s`);
