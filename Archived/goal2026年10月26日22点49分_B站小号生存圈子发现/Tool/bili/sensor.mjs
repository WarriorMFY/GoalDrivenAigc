// sensor.mjs —— 感知器：读最新样本 → 计算每簇 n0 / M_R → 输出 verdict
//
// 用法：
//   node Tool\bili\sensor.mjs                # 用 History\samples 里最新一轮
//   node Tool\bili\sensor.mjs 20261026-225752
//
// 口径（与 Goal.md 一致，改口径必须先改 Goal.md 再改这里）：
//   新号作品 := fans<=anyMaxFans && archive_count<=anyMaxArchiveCount
//   互动率 R := (like + reply + coin + favorite) / play，play=0 剔除
//   簇互动率 M_R := 该簇新号作品 R 的中位数
//   簇 PASS := 有效新号样本 n0 >= minSmallSamples && M_R >= minMedianRate
//
// 退出码：0 = PASS ｜ 1 = GAP/RUNNING（继续循环）｜ 2 = FAILED ｜ 3 = INSUFFICIENT（数据不足，继续循环）
//
// 产出：
//   History\verdict.json        最新判定（覆盖写）
//   History\verdicts.ndjson     判定历史（追加，不删改）
//   History\runs.ndjson         每轮感知留痕（追加）
//   History\latest.md           给 LLM 读的 ≤1.2KB 摘要（覆盖写）

import fs from 'node:fs';
import path from 'node:path';
import {
  loadConfig,
  historyPath,
  readNdjson,
  appendNdjson,
  writeJson,
  sha256File,
  median,
  stampNow,
  isoNow,
  hoursBetween,
  line,
} from './lib.mjs';

const cfg = loadConfig();
const want = process.argv[2] || null;

const dir = historyPath('samples');
if (!fs.existsSync(dir)) {
  console.error('没有 History\\samples，先跑 collect.mjs');
  process.exit(3);
}
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
if (files.length === 0) {
  console.error('History\\samples 为空');
  process.exit(3);
}
const target = want ? `${want}.json` : files[files.length - 1];
const sampleFile = path.join(dir, target);
if (!fs.existsSync(sampleFile)) {
  console.error(`找不到样本 ${sampleFile}`);
  process.exit(3);
}

const sample = JSON.parse(fs.readFileSync(sampleFile, 'utf8').replace(/^\uFEFF/, ''));
const sha = sha256File(sampleFile);

const { minSmallSamples, minMedianRate, minClusterSamples, maxFans, maxArchiveCount } = cfg.thresholds;
const now = new Date();
const remainingHours = hoursBetween(now.toISOString(), cfg.window.end);
const inWindow = hoursBetween(cfg.window.start, now.toISOString()) >= 0 && remainingHours > 0;
const windowClosed = remainingHours <= 0;

const pct = (v) => (v === null ? 'n/a' : (v * 100).toFixed(2) + '%');

const clusters = [];
for (const c of sample.clusters) {
  const small = Array.isArray(c.small) ? c.small : [];
  const rates = small.map((x) => x.rate).filter((v) => v !== null && Number.isFinite(v));
  const n0 = rates.length; // 有效新号样本（有播放、算得出 R）
  const mR = median(rates);

  let state;
  let reason;
  if (c.samples < minClusterSamples) {
    state = 'INSUFFICIENT';
    reason = `簇样本 ${c.samples} < ${minClusterSamples}`;
  } else if (n0 < minSmallSamples) {
    state = 'INSUFFICIENT';
    reason = `新号有效样本 ${n0} < ${minSmallSamples}`;
  } else if (mR !== null && mR >= minMedianRate) {
    state = 'PASS';
    reason = `n0=${n0} ≥ ${minSmallSamples} 且 M_R=${pct(mR)} ≥ ${pct(minMedianRate)}`;
  } else {
    state = 'GAP';
    reason = `n0=${n0} 达标但 M_R=${pct(mR)} < ${pct(minMedianRate)}`;
  }

  clusters.push({
    id: c.id,
    name: c.name,
    keywords: c.keywords,
    samples: c.samples,
    smallSamples: c.smallSamples,
    n0,
    medianRate: mR,
    state,
    reason,
    top: small
      .filter((x) => x.rate !== null)
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 3)
      .map((x) => ({ bvid: x.bvid, rate: Number(x.rate.toFixed(4)), play: x.stat?.play ?? null, title: (x.title || '').slice(0, 40) })),
  });
}

const passed = clusters.filter((c) => c.state === 'PASS');
const overall = passed.length > 0 ? 'PASS' : windowClosed ? 'FAILED' : inWindow ? 'GAP' : 'NOT_STARTED';

const prev = readNdjson(historyPath('verdicts.ndjson'));
const prevLast = prev.length ? prev[prev.length - 1] : null;

const verdict = {
  stamp: sample.stamp,
  at: isoNow(),
  sampleFile: path.relative(path.resolve('.'), sampleFile),
  sampleSha256: sha,
  window: { start: cfg.window.start, end: cfg.window.end, remainingHours: Number(remainingHours.toFixed(2)) },
  thresholds: { smallDef: cfg.thresholds.smallDef, maxFans, maxArchiveCount, minSmallSamples, minMedianRate, minClusterSamples },
  overall,
  passedClusters: passed.map((c) => c.id),
  clusters,
  prevOverall: prevLast ? prevLast.overall : null,
};

writeJson(historyPath('verdict.json'), verdict);
appendNdjson(historyPath('verdicts.ndjson'), {
  stamp: verdict.stamp,
  at: verdict.at,
  overall,
  passed: verdict.passedClusters,
  clusters: clusters.map((c) => ({ id: c.id, state: c.state, n0: c.n0, medianRate: c.medianRate, samples: c.samples })),
  remainingHours: verdict.window.remainingHours,
  sampleSha256: sha,
});
appendNdjson(historyPath('runs.ndjson'), {
  runAt: isoNow(),
  sensor: 'sensor.mjs',
  sampleStamp: sample.stamp,
  overall,
  remainingHours: verdict.window.remainingHours,
});

// ---- 给 LLM 读的摘要（≤1.2KB）----
const md = [];
md.push(`# B站圈子感知 ${verdict.stamp}`);
md.push(`- 判定：**${overall}**（前次 ${prevLast ? prevLast.overall : '无'}）｜窗口剩 ${verdict.window.remainingHours}h`);
md.push(`- 口径：${cfg.thresholds.smallDef}；R=(赞+评+币+藏)/播放；阈值 n0≥${minSmallSamples} 且 M_R≥${pct(minMedianRate)}`);
md.push('');
md.push('| 簇 | 样本 | 新号有效 n0 | M_R | 状态 |');
md.push('|---|---|---|---|---|');
for (const c of clusters) {
  md.push(`| ${c.name} | ${c.samples} | ${c.n0} | ${pct(c.medianRate)} | ${c.state} |`);
}
// 领先簇：先看是否 PASS，再看有效样本 n0，最后看 M_R（避免"1 条样本 100% 互动率"这种假领先）
const best = [...clusters].sort((a, b) => {
  const p = (b.state === 'PASS' ? 1 : 0) - (a.state === 'PASS' ? 1 : 0);
  if (p !== 0) return p;
  if (b.n0 !== a.n0) return b.n0 - a.n0;
  return (b.medianRate ?? -1) - (a.medianRate ?? -1);
})[0];
if (best) md.push(`- 领先簇：${best.name}（${best.state}，n0=${best.n0}, M_R=${pct(best.medianRate)}）`);
const insufficient = clusters.filter((c) => c.state === 'INSUFFICIENT').map((c) => c.name);
if (insufficient.length) md.push(`- 样本不足：${insufficient.join('、')}`);
md.push(`- 下轮：${overall === 'PASS' ? '终止并交付排行榜' : overall === 'FAILED' ? '窗口结束，交付 FAILED' : '继续采样（下一轮 collect）'}`);
const latestPath = historyPath('latest.md');
fs.writeFileSync(latestPath, md.join('\n') + '\n', 'utf8');

// ---- 终端 ----
line(`=== sensor ${verdict.stamp} ===`);
line(`判定：${overall}｜前次：${verdict.prevOverall ?? '无'}｜窗口剩 ${verdict.window.remainingHours}h`);
line('簇                       样本  n0   M_R      状态');
for (const c of clusters) {
  line(
    `${c.name.padEnd(22, ' ')} ${String(c.samples).padStart(4)} ${String(c.n0).padStart(3)}  ${pct(c.medianRate).padStart(8)}  ${c.state}  ${c.reason}`
  );
}
line('');
for (const c of clusters) {
  if (!c.top.length) continue;
  line(`[${c.id}] 新号作品互动率 Top3：`);
  for (const t of c.top) line(`  ${(t.rate * 100).toFixed(2).padStart(6)}%  play=${String(t.play).padStart(7)}  ${t.bvid}  ${t.title}`);
}
line('');
line(`留痕：History\\verdict.json ｜ History\\verdicts.ndjson ｜ History\\latest.md ｜ History\\runs.ndjson`);

process.exit(overall === 'PASS' ? 0 : overall === 'FAILED' ? 2 : 1);
