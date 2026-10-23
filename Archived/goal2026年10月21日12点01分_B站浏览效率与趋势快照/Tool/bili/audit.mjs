// Tool/bili/audit.mjs —— 自审 M1–M5（判定唯一出口）
// 用法：node Tool/bili/audit.mjs [--json]
// 输出 verdict: PASS | FAILED | PENDING
import fs from 'node:fs';
import path from 'node:path';
import {
  BILI_DIR, HISTORY, ROOT, VERSION, P, readJson, readCsv, sha256, byteLen, fmtIso,
  expectedSlots, goalWindow,
} from './lib.mjs';
import { budgetReport } from './budget.mjs';

const CFG = readJson(path.join(BILI_DIR, 'config.json'));
const IX = readJson(P.index, { snapshots: [] });
const checks = [];
const add = (id, ok, detail, extra = {}) => checks.push({ id, ok, detail, ...extra });

const now = new Date();
const slots = expectedSlots(CFG);
const snaps = (IX.snapshots || []).filter((s) => !s.test);
const okSnaps = snaps.filter((s) => s.status === 'ok');

// ---- M5-c 配置与 Goal.md 一致性 ----
const gw = goalWindow();
const cfgStart = new Date(CFG.window.start);
const cfgEnd = new Date(CFG.window.end);
const winOk = gw.start && gw.end && Math.abs(gw.start - cfgStart) < 1000 && Math.abs(gw.end - cfgEnd) < 1000;
add('cfg.goal_window_match', Boolean(winOk),
  winOk ? 'config.window 与 Goal.md 一致' : `config.window 与 Goal.md 不一致: cfg ${fmtIso(cfgStart)}..${fmtIso(cfgEnd)} vs goal ${gw.start ? fmtIso(gw.start) : 'null'}..${gw.end ? fmtIso(gw.end) : 'null'}`);

// ---- M5 判据文本与实现一致（额度） ----
// 目的：如果 Goal.md 的 E4 上限与 config 里的实现不一致，判定数据在形式上就是假的。
// 这条必须由机器判，不能靠人记得去核对。
const goalCalls = (gw.raw || '').match(/E4[^\n]*?≤\s*(\d+)\s*calls/);
const goalLimit = goalCalls ? Number(goalCalls[1]) : null;
const cfgLimit = CFG.budget?.callsLimit ?? null;
const limitOk = goalLimit != null && goalLimit === cfgLimit;
add('M5.goal_budget_match', Boolean(limitOk),
  limitOk
    ? `Goal.md 与 config 的 calls 上限一致（${goalLimit}）`
    : `Goal.md 的 E4 写「${goalLimit ?? '未找到'} calls」，config 实现为 ${cfgLimit} calls——需用户同步 Goal.md`);

const goalHard = (gw.raw || '').match(/总调用\s*>\s*(\d+)\s*calls/);
const goalHardN = goalHard ? Number(goalHard[1]) : null;
const cfgHard = CFG.budget?.callsHardLimit ?? null;
const hardOk = goalHardN != null && goalHardN === cfgHard;
add('M5.goal_hardlimit_match', Boolean(hardOk),
  hardOk
    ? `Goal.md 与 config 的 calls 硬上限一致（${goalHardN}）`
    : `Goal.md 终止判据说「总调用 > ${goalHardN ?? '未找到'} calls 即 FAILED」，config 硬上限为 ${cfgHard}——两处数字冲突，需用户同步`);

// ---- M1 交付完整度（按 Goal.md 2026-10-22 修订版：S >= 4，丢失必须留痕） ----
const total = slots.length;
const valid = snaps.filter((s) => {
  if (s.status !== 'ok' || s.late) return false;
  const dev = s.planned ? (new Date(s.actual) - new Date(s.planned)) / 60000 : null;
  return dev != null && Math.abs(dev) <= CFG.toleranceMin;
});
add('M1.valid_snapshots', valid.length >= 4,
  `有效快照 ${valid.length} ≥ 4（计划 ${total} 个时段；有效=按时且非补采）`);
for (const s of slots) {
  const key = fmtIso(s);
  const rec = snaps.find((x) => x.slot === key);
  const late = rec?.lateMin ?? (rec?.actual ? (new Date(rec.actual) - s) / 60000 : null);
  const devOk = late == null ? false : Math.abs(late) <= CFG.toleranceMin;
  let ok;
  let detail;
  if (!rec) { ok = false; detail = '未采集且无任何记录（无留痕）'; }
  else if (rec.status === 'ok' && !rec.late) { ok = devOk; detail = `status=ok 偏差=${late == null ? '?' : late.toFixed(1)}min`; }
  else if (rec.status === 'ok' && rec.late) { ok = true; detail = `迟到补采（偏差 ${late == null ? '?' : late.toFixed(0)}min），不计入有效快照但数据已留存`; }
  else if (rec.status === 'missed') { ok = Boolean(rec.note || rec.lateMin != null); detail = `丢失已留痕：${rec.note || `迟到 ${rec.lateMin}min`}`; }
  else { ok = false; detail = `status=${rec.status}${rec.note ? ` ${rec.note}` : ''}`; }
  add(`M1.slot:${key.slice(5, 16)}`, ok, `${ok ? 'PASS' : 'FAIL'} ${detail}`);
}

// ---- M2/M3 逐快照 ----
const digestSizes = [];
const comps = [];
const overlaps = [];
for (const s of okSnaps) {
  const stamp = s.stamp;
  const dPath = path.join(P.snapshots, s.files.digest);
  const cPath = path.join(P.snapshots, s.files.csv);
  const rPath = path.join(P.snapshots, s.files.raw);
  const okFiles = fs.existsSync(dPath) && fs.existsSync(cPath) && fs.existsSync(rPath);
  add(`M2.files:${s.stamp}`, okFiles, okFiles ? 'raw/csv/digest 齐全' : '文件缺失');
  if (!okFiles) continue;

  const dText = fs.readFileSync(dPath, 'utf8');
  const dBytes = byteLen(dText);
  digestSizes.push(dBytes);
  add(`M3.E2.digest_bytes:${s.stamp}`, dBytes <= CFG.maxDigestBytes, `${dBytes}B ≤ ${CFG.maxDigestBytes}B`);

  const shaOk = sha256(dText) === s.sha256.digest;
  add(`M5.sha256:${s.stamp}`, shaOk, shaOk ? 'digest sha256 与索引一致' : 'digest 被改动');

  const rows = readCsv(cPath);
  const rankingRows = rows.filter((r) => r.src === 'ranking').length;
  add(`M2.items:${s.stamp}`, rows.length >= CFG.minItems, `条目 ${rows.length} ≥ ${CFG.minItems}（排行 ${rankingRows}）`);
  add(`M2.blocks:${s.stamp}`,
    ['全站Top', '分区热度', '搜索热词', '上升Top'].every((k) => dText.includes(k)),
    '四板块齐全');

  comps.push(s.comp);
  add(`M3.E1.comp:${s.stamp}`, s.comp >= 8, `压缩 ${s.comp}x ≥ 8x`);
  if (s.overlap != null) overlaps.push(s.overlap);
}

if (okSnaps.length) {
  const medDigest = [...digestSizes].sort((a, b) => a - b);
  const medComp = [...comps].sort((a, b) => a - b);
  add('M3.E2.median', (medDigest[Math.floor(medDigest.length / 2)] ?? 0) <= CFG.maxDigestBytes,
    `digest 中位数 ${medDigest[Math.floor(medDigest.length / 2)] ?? '-'}B`);
  add('M3.E1.median', (medComp[Math.floor(medComp.length / 2)] ?? 0) >= 8,
    `压缩中位数 ${medComp[Math.floor(medComp.length / 2)] ?? '-'}x`);
}
if (overlaps.length >= 1) {
  const sorted = [...overlaps].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  add('M4.overlap_median', med >= 0.7, `相邻重合度中位数 ${(med * 100).toFixed(0)}%（${overlaps.length} 组，Goal.md 名义 5 组；快照减少时按实际组数判定）`);
} else {
  add('M4.overlap_median', false, '尚无相邻快照可比');
}

// ---- M3.E4 额度（直接调用，不走子进程：沙箱禁止管道捕获） ----
let budget = null;
try {
  budget = budgetReport();
  if (budget.error) throw new Error(budget.error);
  fs.writeFileSync(P.budgetSnapshot, JSON.stringify(budget, null, 1));
  add('M3.E4.budget', !budget.overHardLimit,
    `调用 ${budget.calls}/${budget.callsLimit}（硬上限 ${budget.callsHardLimit}）¥${budget.costCny}`);
} catch (e) {
  add('M3.E4.budget', false, `额度对账失败: ${e?.message || e}`);
}

// ---- M3.E6 对照实验 ----
const expPath = P.expCompress;
const exp = readJson(expPath, null);
add('M3.E6.exp', Boolean(exp && exp.ok), exp ? `压缩比 ${exp.tokenRatio}x 保留率 ${(exp.retention * 100).toFixed(0)}%` : '未做对照实验（node delta.mjs exp）');

// ---- M4 趋势判定与收尾产出 ----
const reportPath = P.trendReport;
add('M4.trend_report', fs.existsSync(reportPath), fs.existsSync(reportPath) ? '存在' : '未生成趋势总表');
const practicePath = P.practice;
add('M4.practice_doc', fs.existsSync(practicePath), fs.existsSync(practicePath) ? '存在' : '未生成最佳实践');

// ---- 汇总 ----
const failed = checks.filter((c) => !c.ok);
const endReached = now >= new Date(CFG.window.end);
const allOk = failed.length === 0;
const hardFail = checks.some((c) => !c.ok && (c.id === 'M3.E4.budget' || c.id === 'cfg.goal_window_match'));
let verdict;
// 判据按 Goal.md 修订版 M1（S>=4，丢失须留痕）：所有检查项通过即 PASS。
// 不再要求"6 个时段全 ok"——那与修订后的 M1 冲突，会把合规结果误判为 PENDING。
if (allOk && valid.length >= 4) verdict = 'PASS';
else if (endReached || hardFail) verdict = 'FAILED';
else verdict = 'PENDING';

const summary = {
  verdict,
  version: VERSION,
  at: fmtIso(now),
  window: CFG.window,
  snapshots: { done: okSnaps.length, planned: total },
  checks: checks.length,
  failed: failed.map((f) => `${f.id}: ${f.detail}`),
  budget: budget ? { calls: budget.calls, limit: budget.callsLimit, costCny: budget.costCny } : null,
};

// 落判定结论为文件：让 verdict 成为可留存的产物，而不是只在终端里出现过
try {
  fs.writeFileSync(P.verdict, JSON.stringify({ ...summary, all: checks }, null, 1));
} catch { /* 写失败不影响终端输出 */ }

if (process.argv.includes('--json')) console.log(JSON.stringify({ ...summary, all: checks }, null, 1));
else {
  console.log(`=== AUDIT ${summary.at} ===`);
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.detail}`);
  console.log(`---\n快照 ${okSnaps.length}/${total}  失败项 ${failed.length}  verdict=${verdict}`);
  process.exitCode = verdict === 'PASS' ? 0 : verdict === 'FAILED' ? 1 : 2;
}
if (verdict === 'FAILED' && !process.argv.includes('--json')) process.exitCode = 1;
