// audit.mjs —— 留痕审计器（只读）：校验样本文件的自洽性，暴露口径漂移与样本偏倚
//
// 用法：
//   node Tool\bili\audit.mjs                 # 审计最新样本
//   node Tool\bili\audit.mjs 20261026-225702
//
// 检查项：
//   1. 口径标签（order/pages/thresholds）是否与当前 config.json 一致
//   2. 作者粉丝分布直方图（0 粉样本是否够、是否被大号淹没）
//   3. 0 粉作品的有效播放数与 rate 回退情况（view 失败会打 info 标记）
//   4. sha256 是否与 samples.ndjson 索引一致（防事后手改）
//   5. 样本新鲜度（pubdate 距今小时数分布）

import fs from 'node:fs';
import path from 'node:path';
import {
  loadConfig,
  historyPath,
  readNdjson,
  sha256File,
  median,
  stampNow,
  writeJson,
  isoNow,
  line,
} from './lib.mjs';

const cfg = loadConfig();
const want = process.argv[2] || null;

const dir = historyPath('samples');
if (!fs.existsSync(dir)) {
  console.error('没有 History\\samples，先跑 collect.mjs');
  process.exit(2);
}
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort();
if (files.length === 0) {
  console.error('History\\samples 为空');
  process.exit(2);
}
const target = want ? `${want}.json` : files[files.length - 1];
const file = path.join(dir, target);
if (!fs.existsSync(file)) {
  console.error(`找不到样本 ${file}`);
  process.exit(2);
}

const sample = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = sha256File(file);
const index = readNdjson(historyPath('samples.ndjson'));
const idx = index.find((x) => x.stamp === sample.stamp);

function bucket(fans) {
  if (fans === null || fans === undefined) return 'unknown';
  if (fans === 0) return '0';
  if (fans < 10) return '1-9';
  if (fans < 100) return '10-99';
  if (fans < 1000) return '100-999';
  if (fans < 10000) return '1k-9k';
  return '10k+';
}

line(`=== audit ${sample.stamp} ===`);
line(`文件：${file}`);
line(`sha256：${sha}`);
line(
  idx
    ? idx.sha256 === sha
      ? '索引一致：OK'
      : `索引不一致：索引=${idx.sha256}（样本可能被修改）`
    : '索引缺失：samples.ndjson 里没有该 stamp（可能未跑 collect 落索引）'
);
line('');

const report = {
  stamp: sample.stamp,
  auditedAt: isoNow(),
  sha256: sha,
  indexMatch: idx ? idx.sha256 === sha : null,
  configTags: {
    order_now: cfg.sampling.order,
    order_sample: sample.order,
    pages_now: cfg.sampling.pages,
    pages_sample: sample.pages,
    smallFans: cfg.thresholds.smallFans,
    minSmallSamples: cfg.thresholds.minSmallSamples,
    minMedianRate: cfg.thresholds.minMedianRate,
  },
  clusters: [],
};

for (const c of sample.clusters) {
  const all = Array.isArray(c.items) ? c.items : [];
  const histAll = {};
  for (const it of all) {
    const k = bucket(it.fans);
    histAll[k] = (histAll[k] || 0) + 1;
  }
  const histSmall = {};
  for (const it of c.small) {
    const k = bucket(it.fans);
    histSmall[k] = (histSmall[k] || 0) + 1;
  }

  const rates = c.small.map((x) => x.rate).filter((v) => v !== null && Number.isFinite(v));
  const ages = c.small.map((x) => x.ageHours).filter((v) => Number.isFinite(v));
  const viewFailed = c.small.filter((x) => x.stat && x.stat.source !== 'view').length;

  const row = {
    id: c.id,
    name: c.name,
    samples: c.samples,
    uniqueAuthors: c.uniqueAuthors,
    unknownFans: c.unknownFans,
    smallSamples: c.smallSamples,
    smallWithPlay: c.smallWithPlay,
    medianRate: c.medianRate,
    rateCheck: median(rates),
    viewFailed,
    medianAgeHours: median(ages),
    histAll,
    histSmall,
    n0_ok: c.smallSamples >= cfg.thresholds.minSmallSamples,
    rate_ok: c.medianRate !== null && c.medianRate >= cfg.thresholds.minMedianRate,
  };
  report.clusters.push(row);

  line(`[${c.id}] ${c.name}`);
  line(
    `  样本 ${c.samples}｜唯一作者 ${c.uniqueAuthors}｜未知粉丝 ${c.unknownFans}｜0粉作品 ${c.smallSamples}｜有效播放 ${c.smallWithPlay}`
  );
  line(
    `  中位互动率 ${c.medianRate === null ? 'n/a' : (c.medianRate * 100).toFixed(2) + '%'}` +
      `｜0粉样本充足 ${row.n0_ok ? 'YES' : 'NO'}｜阈值达标 ${row.rate_ok ? 'YES' : 'NO'}` +
      `｜view 回退 ${viewFailed} 条`
  );
  line(`  0粉样本新鲜度中位 ${row.medianAgeHours === null ? 'n/a' : row.medianAgeHours.toFixed(1) + 'h'}`);
  line(`  粉丝直方图(全样本)：${Object.entries(histAll).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  fileCheck(sample, c);
  line('');
}

function fileCheck(sample, c) {
  const keys = new Set(c.small.map((x) => x.bvid));
  if (keys.size !== c.small.length) line(`  [warn] 该簇 0 粉作品 bvid 有重复：${c.small.length - keys.size} 条`);
  const badRate = c.small.filter((x) => x.stat && x.stat.play > 0 && x.rate === null);
  if (badRate.length) line(`  [warn] 有播放但算不出 rate 的作品 ${badRate.length} 条`);
  const zeroPlay = c.small.filter((x) => !x.stat || x.stat.play === 0);
  if (zeroPlay.length) line(`  [info] play=0 被剔除 ${zeroPlay.length} 条：${zeroPlay.map((x) => x.bvid).join(',')}`);
}

report.summary = report.clusters.map((c) => ({
  id: c.id,
  smallSamples: c.smallSamples,
  medianRate: c.medianRate,
  n0_ok: c.n0_ok,
  rate_ok: c.rate_ok,
}));

const outDir = historyPath('audits');
const outFile = writeJson(path.join(outDir, `${sample.stamp}_audit.json`), report);
line(`留痕：${outFile}`);
