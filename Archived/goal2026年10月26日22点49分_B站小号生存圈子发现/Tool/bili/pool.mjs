// pool.mjs —— 跨轮汇总（只做稳健性参考，不产出 verdict）
//
// 用法：
//   node Tool\bili\pool.mjs
//
// 为什么需要它：单轮 n0 只有 3–8 条，中位数会被 ±1 条样本翻盘（实测 ai-news 两轮 3.10%，
// 第三轮变 2.51%）。把窗口内所有轮次的新号作品按 bvid 去重后合并，才看得出"这个圈子到底稳不稳"。
//
// 重要：本脚本输出**不是判据**。判据只在 Goal.md，判定只由 sensor.mjs 单轮产出。
//       这里给出的 pooled M_R 只用于解读稳定性，禁止用它替代 verdict。

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, historyPath, writeJson, median, isoNow, line } from './lib.mjs';

const cfg = loadConfig();
const dir = historyPath('samples');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const rounds = files.length;

const byCluster = new Map();
const roundStates = new Map();

for (const f of files) {
  const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, ''));
  for (const c of s.clusters) {
    if (!byCluster.has(c.id)) byCluster.set(c.id, { id: c.id, name: c.name, keywords: c.keywords, items: new Map() });
    const box = byCluster.get(c.id);
    for (const x of c.small) {
      if (x.rate === null || !Number.isFinite(x.rate)) continue;
      // 同一作品多轮出现：保留最后一次取到的 stat（更接近当前值），并记录出现过的轮次
      const prev = box.items.get(x.bvid);
      box.items.set(x.bvid, {
        bvid: x.bvid,
        mid: x.mid,
        fans: x.fans,
        archiveCount: x.archiveCount,
        rate: x.rate,
        play: x.stat?.play ?? null,
        title: x.title,
        rounds: prev ? [...new Set([...prev.rounds, s.stamp])] : [s.stamp],
      });
    }
    const key = c.id;
    if (!roundStates.has(key)) roundStates.set(key, []);
    roundStates.get(key).push({ stamp: s.stamp, n0: c.smallWithPlay, medianRate: c.medianRate });
  }
}

line(`=== pool ${isoNow()} | 轮次 ${rounds} ===`);
const out = { at: isoNow(), rounds, note: '稳健性参考，非判据', clusters: [] };

for (const box of byCluster.values()) {
  const items = [...box.items.values()];
  const rates = items.map((x) => x.rate).filter((v) => Number.isFinite(v));
  const pooled = median(rates);
  const hist = roundStates.get(box.id) || [];
  const passRounds = hist.filter(
    (r) => r.medianRate !== null && r.medianRate >= cfg.thresholds.minMedianRate && r.n0 >= cfg.thresholds.minSmallSamples
  ).length;

  out.clusters.push({
    id: box.id,
    name: box.name,
    pooledN0: rates.length,
    pooledMedianRate: pooled,
    pooledPlayMedian: median(items.map((x) => x.play).filter((v) => Number.isFinite(v))),
    rounds: hist,
    roundsMeeting: `${passRounds}/${hist.length}`,
    items: items.sort((a, b) => b.rate - a.rate),
  });

  line('');
  line(`[${box.id}] ${box.name}`);
  line(
    `  各轮：${hist
      .map((r) => `${r.stamp.slice(9)} n0=${r.n0} M_R=${r.medianRate === null ? 'n/a' : (r.medianRate * 100).toFixed(2) + '%'}`)
      .join(' ｜ ')}`
  );
  line(
    `  合并去重后 n0=${rates.length}｜pooled M_R=${pooled === null ? 'n/a' : (pooled * 100).toFixed(2) + '%'}` +
      `｜达标轮次 ${passRounds}/${hist.length}`
  );
}

const file = writeJson(historyPath('pooled.json'), out);
line('');
line(`留痕：${file}`);
