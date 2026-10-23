// Tool/bili/pace.mjs —— 自治轮次节拍器（等新样本 → 出摘要 → 自动留痕）
// 用法：node Tool/bili/pace.mjs [--kind full|light] [--cap-min 32] [--poll-sec 20] [--no-log]
// 退出码：0 有新样本；2 到 cap 仍无新样本
// 留痕：History/l2_rounds.ndjson 追加一条轮次记录（覆盖了哪些样本/事件），满足 M6.2「每轮覆盖全部新样本」
import fs from 'node:fs';
import path from 'node:path';
import { HISTORY, P, sleep, fmtIso, readJson, fnum } from './lib.mjs';

const SAMPLES = P.samples;
const EVENTS = P.events;
const ROUNDS = P.rounds;
const LATEST = P.latest;
const INDEX = P.index;

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i >= 0 ? (process.argv[i + 1] ?? true) : d; };
const kind = arg('--kind', null);
const capMin = Number(arg('--cap-min', 32));
const pollSec = Number(arg('--poll-sec', 20));
const minWaitMin = Number(arg('--min-wait-min', 0));

const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const parseAll = (f) => readLines(f).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const countKind = (k) => (k ? parseAll(SAMPLES).filter((x) => x.kind === k).length : parseAll(SAMPLES).length);

const baseSamples = parseAll(SAMPLES).length;
const baseKind = countKind(kind);
const baseEvents = parseAll(EVENTS).length;
const t0 = Date.now();
console.log(`[${fmtIso(new Date())}] 等待新${kind || ''}样本：样本基线 ${baseSamples}，事件基线 ${baseEvents}，上限 ${capMin}min`);

let timedOut = false;
for (;;) {
  await sleep(pollSec * 1000);
  const cur = countKind(kind);
  if (cur > baseKind && Date.now() - t0 >= minWaitMin * 60000) break;
  if (Date.now() - t0 >= capMin * 60000) { timedOut = true; break; }
}

const elapsedMin = Math.round(((Date.now() - t0) / 60000) * 10) / 10;
const allSamples = parseAll(SAMPLES);
const newSamples = allSamples.slice(baseSamples);
const newEvents = parseAll(EVENTS).slice(baseEvents);

console.log(`${timedOut ? '到上限无新样本' : '新样本到达'}：用时 ${elapsedMin}min，新增样本 ${newSamples.length} 条，新增事件 ${newEvents.length} 条`);

for (const s of newSamples) {
  console.log(`· ${s.at.slice(5, 16)} ${s.kind} cov=${s.cov} view=${fnum(s.viewSum)} 重合=${s.overlap != null ? `${(s.overlap * 100).toFixed(0)}%` : '-'} +${s.added}/-${s.dropped} vphMax=${fnum(s.vphMax)}${s.official ? ` 官方@${s.official.slice(5, 16)}` : ''}`);
}
for (const e of newEvents) console.log(`  ! ${e.at.slice(5, 16)} ${e.kind} ${e.detail}`);

const latest = readLines(LATEST).join('\n');
if (latest) { console.log('--- latest.md ---'); console.log(latest); }

const ix = readJson(INDEX, { snapshots: [] });
const ok = (ix.snapshots || []).filter((s) => s.status === 'ok');
console.log(`官方快照 ${ok.length}/6：${ok.map((s) => s.slot.slice(5, 16)).join(', ') || '-'}`);

if (!process.argv.includes('--no-log')) {
  const rec = {
    at: fmtIso(new Date()),
    waitedMin: elapsedMin,
    timedOut,
    kinds: [...new Set(newSamples.map((s) => s.kind))],
    samplesSeen: newSamples.length,
    sampleStamps: newSamples.map((s) => s.stamp),
    eventsSeen: newEvents.length,
    events: newEvents.map((e) => `${e.kind}:${e.detail}`),
    officials: ok.length,
  };
  fs.appendFileSync(ROUNDS, `${JSON.stringify(rec)}\n`);
  console.log(`轮次已留痕 → History/l2_rounds.ndjson（累计 ${parseAll(ROUNDS).length} 轮）`);
}

process.exitCode = timedOut ? 2 : 0;
