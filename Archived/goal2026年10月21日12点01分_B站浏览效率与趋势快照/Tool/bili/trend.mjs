// Tool/bili/trend.mjs —— 把流式样本聚合成小时级趋势序列（脚本产物，可复算）
// 用法：node Tool/bili/trend.mjs [--write] [--tail 12]
// 产物：History/trend_log.md（--write 时）；stdout 输出摘要
import fs from 'node:fs';
import path from 'node:path';
import { HISTORY, P, fmtIso, fnum } from './lib.mjs';

const SAMPLES = P.samples;
const EVENTS = P.events;
const OUT = P.trendLog;

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i >= 0 ? (process.argv[i + 1] ?? true) : d; };
const tailN = Number(arg('--tail', 12));

const readNd = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const samples = readNd(SAMPLES);
const events = readNd(EVENTS);

if (!samples.length) { console.log('尚无样本'); process.exit(2); }

const hourKey = (iso) => iso.slice(0, 13); // YYYY-MM-DDTHH
const pct = (v) => (v == null ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const num = (v) => (v == null ? '-' : fnum(Math.round(v)));

// 按小时×类型聚合：light（popular 池，~4900万量级）与 full（ranking 池，~9200万量级）不可混合平均
const hours = new Map();
for (const s of samples) {
  const k = `${hourKey(s.at)}|${s.kind}`;
  const h = hours.get(k) || { hour: hourKey(s.at), kind: s.kind, n: 0, viewSums: [], cohortPct: [], churn: 0, vph: [] };
  h.n += 1;
  if (s.viewSum) h.viewSums.push(s.viewSum);
  if (s.cohortPct != null) h.cohortPct.push(s.cohortPct);
  h.churn += (s.added || 0) + (s.dropped || 0);
  if (s.vphMax) h.vph.push(s.vphMax);
  hours.set(k, h);
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const lines = [];
lines.push('# 流样本趋势（小时级聚合）');
lines.push('');
lines.push(`生成 ${fmtIso(new Date())}｜样本 ${samples.length} 条（light ${samples.filter((s) => s.kind === 'light').length} / full ${samples.filter((s) => s.kind === 'full').length}）｜事件 ${events.length} 条`);
lines.push('');
lines.push('| 小时 | 池 | 样本数 | 截面 view 均值 | cohort 均值 | 换血累计 | 峰值增速均值 |');
lines.push('|---|---|---|---|---|---|---|');
for (const h of [...hours.values()].sort((a, b) => (a.hour + a.kind).localeCompare(b.hour + b.kind))) {
  lines.push(`| ${h.hour.slice(5).replace('T', ' ')}:00 | ${h.kind} | ${h.n} | ${avg(h.viewSums) != null ? fnum(Math.round(avg(h.viewSums))) : '-'} | ${pct(avg(h.cohortPct))} | ${h.churn} | ${avg(h.vph) != null ? `${fnum(Math.round(avg(h.vph)))}/h` : '-'} |`);
}

// full 序列（cohort 口径的连续线）
const fulls = samples.filter((s) => s.kind === 'full' && s.cohortPct != null);
lines.push('');
lines.push('## full 序列（同 cohort 口径，唯一可跨时段比较的增速）');
lines.push('');
lines.push('| 时刻 | cohort 条数 | 增量 | 增速 | 重合 | 峰值增速 |');
lines.push('|---|---|---|---|---|---|');
for (const s of fulls) {
  lines.push(`| ${s.at.slice(5, 16).replace('T', ' ')} | ${s.cohortN ?? '-'} | ${num(s.cohortDelta)} | ${pct(s.cohortPct)} | ${s.overlap != null ? `${(s.overlap * 100).toFixed(0)}%` : '-'} | ${fnum(s.vphMax)}/h |`);
}

// 事件统计
const byKind = events.reduce((m, e) => { m[e.kind] = (m[e.kind] || 0) + 1; return m; }, {});
lines.push('');
lines.push('## 事件统计');
lines.push('');
lines.push(Object.keys(byKind).length ? Object.entries(byKind).map(([k, v]) => `- ${k}: ${v}`).join('\n') : '- 无事件');
if (events.length) {
  lines.push('');
  lines.push('最近 5 条：');
  for (const e of events.slice(-5)) lines.push(`- ${e.at.slice(5, 16).replace('T', ' ')} ${e.kind} ${e.detail}`);
}

// 最近 N 条样本
lines.push('');
lines.push(`## 最近 ${tailN} 条样本`);
lines.push('');
lines.push('| 时刻 | 类型 | 截面 view | 重合 | +进/-出 | cohort | 峰值增速 |');
lines.push('|---|---|---|---|---|---|---|');
for (const s of samples.slice(-tailN)) {
  lines.push(`| ${s.at.slice(5, 16).replace('T', ' ')} | ${s.kind}${s.official ? '@官方' : ''} | ${fnum(s.viewSum)} | ${s.overlap != null ? `${(s.overlap * 100).toFixed(0)}%` : '-'} | +${s.added}/-${s.dropped} | ${pct(s.cohortPct)} | ${fnum(s.vphMax)}/h |`);
}

const text = lines.join('\n');
console.log(text);
if (process.argv.includes('--write')) {
  fs.writeFileSync(OUT, `${text}\n`);
  console.log(`\n已写入 History/trend_log.md`);
}
