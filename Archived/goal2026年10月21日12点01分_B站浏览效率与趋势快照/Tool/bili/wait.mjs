// Tool/bili/wait.mjs —— 轮次节拍器：等到出现新样本再交还控制权，避免自治轮次空转烧额度
// 用法：node Tool/bili/wait.mjs [--kind full|light] [--cap-min 30] [--poll-sec 20]
// 退出码：0 = 出现新样本；2 = 到 cap 仍无新样本（说明采集器可能挂了）
import fs from 'node:fs';
import path from 'node:path';
import { HISTORY, P, sleep, fmtIso } from './lib.mjs';

const SAMPLES = P.samples;
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i >= 0 ? (process.argv[i + 1] ?? true) : d; };
const kind = arg('--kind', null);
const capMin = Number(arg('--cap-min', 30));
const pollSec = Number(arg('--poll-sec', 20));

function lines() {
  try { return fs.readFileSync(SAMPLES, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}
function countMatching() {
  if (!kind) return lines().length;
  return lines().filter((l) => { try { return JSON.parse(l).kind === kind; } catch { return false; } }).length;
}

const base = countMatching();
const t0 = Date.now();
const capMs = capMin * 60000;
console.log(`[${fmtIso(new Date())}] 等待新${kind || ''}样本：基线 ${base}，上限 ${capMin}min`);

for (;;) {
  await sleep(pollSec * 1000);
  const cur = countMatching();
  const el = Math.round((Date.now() - t0) / 60000 * 10) / 10;
  if (cur > base) {
    console.log(`[${fmtIso(new Date())}] 新样本到达：${base} → ${cur}，等待 ${el}min`);
    process.exit(0);
  }
  if (Date.now() - t0 >= capMs) {
    console.log(`[${fmtIso(new Date())}] 到上限仍无新样本（等待 ${el}min，基线 ${base}）——检查采集器是否存活`);
    process.exit(2);
  }
}
