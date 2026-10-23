// Tool/bili/delta.mjs —— 快照间增量、趋势总表、E6 对照实验
// 用法：
//   node Tool/bili/delta.mjs report [--write]   趋势总表（--write 生成 History/trend_report.md）
//   node Tool/bili/delta.mjs pair <stampA> <stampB>   两份快照详细 diff
//   node Tool/bili/delta.mjs exp                 E6：raw 直读 vs 脚本压缩 的 token 与信息保留对照
import fs from 'node:fs';
import path from 'node:path';
import {
  BILI_DIR, HISTORY, VERSION, P, readJson, readCsv, sha256, byteLen, estTokens, fnum, cut, fmtIso,
} from './lib.mjs';

const CFG = readJson(path.join(BILI_DIR, 'config.json'));
const IX = readJson(P.index, { snapshots: [] });
const snaps = (IX.snapshots || []).filter((s) => !s.test && s.status === 'ok')
  .sort((a, b) => new Date(a.actual) - new Date(b.actual));

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i >= 0 ? (process.argv[i + 1] ?? true) : d; };

function loadRows(stamp) {
  return readCsv(path.join(P.snapshots, `${stamp}.csv`));
}
function planRows(rows) { return rows.filter((r) => r.src === 'ranking'); }

function diff(A, B) {
  const a = new Map(planRows(A).map((r) => [r.bvid, r]));
  const b = new Map(planRows(B).map((r) => [r.bvid, r]));
  const added = [...b.keys()].filter((k) => !a.has(k)).map((k) => b.get(k));
  const dropped = [...a.keys()].filter((k) => !b.has(k)).map((k) => a.get(k));
  const common = [...a.keys()].filter((k) => b.has(k));
  const grows = common.map((k) => ({ ...b.get(k), dView: b.get(k).view - a.get(k).view }))
    .sort((x, y) => y.dView - x.dView);
  return {
    aN: a.size, bN: b.size, commonN: common.length,
    overlap: a.size ? common.length / a.size : null,
    added, dropped, grows,
  };
}

function cmdReport(write) {
  if (snaps.length === 0) { console.log('尚无快照'); return; }
  const lines = [];
  lines.push(`# B站平台趋势快照总表\n`);
  lines.push(`窗口 ${CFG.window.start} → ${CFG.window.end}；时段 ${CFG.slots.map((h) => `${String(h).padStart(2, '0')}:00`).join(' / ')}（+08:00）\n`);
  lines.push('| # | 时段 | 实际 | 条目 | digest | 压缩 | 重合度 | 新进 | 掉榜 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  snaps.forEach((s, i) => {
    const t = new Date(s.actual);
    lines.push(`| ${i + 1} | ${s.planned.slice(5, 16).replace('T', ' ')} | ${s.actual.slice(5, 16).replace('T', ' ')} | ${s.items} | ${s.digestBytes}B | ${s.comp}x | ${s.overlap != null ? `${(s.overlap * 100).toFixed(0)}%` : '-'} | ${s.delta?.added ?? '-'} | ${s.delta?.dropped ?? '-'} |`);
  });
  const ov = snaps.map((s) => s.overlap).filter((v) => v != null).sort((a, b) => a - b);
  if (ov.length) lines.push(`\n相邻重合度中位数 ${(ov[Math.floor(ov.length / 2)] * 100).toFixed(0)}%（${ov.length} 组）；要求 ≥70%\n`);

  if (snaps.length >= 2) {
    lines.push(`## 各时段涨幅榜（排行内 view 增量 Top5）\n`);
    for (let i = 1; i < snaps.length; i++) {
      const d = diff(loadRows(snaps[i - 1].stamp), loadRows(snaps[i].stamp));
      lines.push(`### ${snaps[i].actual.slice(5, 16).replace('T', ' ')} vs ${snaps[i - 1].actual.slice(5, 16).replace('T', ' ')}（重合 ${(d.overlap * 100).toFixed(0)}%，共 ${d.commonN}/${d.aN}）`);
      for (const g of d.grows.slice(0, 5)) lines.push(`- ${g.bvid} ${cut(g.title, 26)} [${g.zone}] +${fnum(g.dView)} → ${fnum(g.view)}`);
      if (d.added.length) lines.push(`- 新进榜 ${d.added.length}：${d.added.slice(0, 5).map((r) => `${r.bvid}(${cut(r.title, 14)})`).join('、')}`);
      if (d.dropped.length) lines.push(`- 掉榜 ${d.dropped.length}：${d.dropped.slice(0, 5).map((r) => `${r.bvid}(${cut(r.title, 14)})`).join('、')}`);
      lines.push('');
    }
  }
  const text = lines.join('\n');
  console.log(text);
  if (write) {
    fs.writeFileSync(P.trendReport, `${text}\n\n_由 Tool/bili/delta.mjs report 生成 ${fmtIso(new Date())}；快照数 ${snaps.length}_\n`);
    console.log(`\n已写入 History/trend_report.md`);
  }
}

function cmdPair(a, b) {
  const rowsA = loadRows(a), rowsB = loadRows(b);
  const d = diff(rowsA, rowsB);
  const out = {
    a, b, aN: d.aN, bN: d.bN, commonN: d.commonN, overlap: Number((d.overlap ?? 0).toFixed(4)),
    added: d.added.map((r) => ({ bvid: r.bvid, title: r.title, view: r.view, zone: r.zone })),
    dropped: d.dropped.map((r) => ({ bvid: r.bvid, title: r.title, view: r.view, zone: r.zone })),
    grows: d.grows.slice(0, 20).map((r) => ({ bvid: r.bvid, title: r.title, view: r.view, dView: r.dView })),
  };
  const file = path.join(P.checks, `delta_${a}_${b}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ ...out, added: out.added.length, dropped: out.dropped.length, grows: out.grows.length, file: path.basename(file) }, null, 1));
}

// E6：同一时点，raw 直读 vs 脚本压缩
function cmdExp() {
  const s = snaps.at(-1);
  if (!s) { console.log('尚无快照，无法做对照实验'); process.exitCode = 2; return; }
  const raw = readJson(path.join(P.snapshots, s.files.raw));
  const digestText = fs.readFileSync(path.join(P.snapshots, s.files.digest), 'utf8');
  const rawText = Object.values(raw.responses).map((r) => r.text).join('\n');
  const rows = loadRows(s.stamp);
  const plan = planRows(rows);

  const rawTokens = estTokens(rawText);
  const digestTokens = estTokens(digestText);

  // 10 条可证伪事实，检验 digest 能否复原
  const facts = [];
  const hit = (label, cond) => facts.push({ label, ok: Boolean(cond) });
  for (const r of plan.slice(0, 5)) hit(`排行#${r.rank} ${r.bvid} 播放=${fnum(r.view)}`, digestText.includes(r.bvid) && digestText.includes(fnum(r.view)));
  hit(`全站 Top20 第20名 bvid=${plan[19]?.bvid ?? '-'}`, Boolean(plan[19] && digestText.includes(plan[19].bvid)));
  const zones = new Map();
  for (const r of rows) if (r.zone) zones.set(r.zone, Math.max(zones.get(r.zone) || 0, r.view));
  const topZone = [...zones.entries()].sort((x, y) => y[1] - x[1])[0];
  hit(`最高播放二级分区=${topZone?.[0]}`, Boolean(topZone && digestText.includes(topZone[0])));
  const hot = rows.filter((r) => r.src === 'hotsearch');
  hit(`热词第一名=${hot[0]?.title ?? '-'}`, Boolean(hot[0] && digestText.includes(hot[0].title)));
  const rs = rows.filter((r) => r.pubdate > 0)
    .map((r) => ({ ...r, h: Math.max((new Date(s.actual) / 1000 - r.pubdate) / 3600, 0.5) }))
    .sort((x, y) => y.view / y.h - x.view / x.h)[0];
  hit(`上升榜第一名=${rs?.bvid ?? '-'}`, Boolean(rs && digestText.includes(rs.bvid)));
  hit(`条目总数 N=${rows.length}`, digestText.includes(`N=${rows.length}`));

  const okN = facts.filter((f) => f.ok).length;
  const out = {
    ok: okN >= 9,
    at: fmtIso(new Date()),
    snapshot: s.stamp,
    rawTokens, digestTokens,
    tokenRatio: Number((rawTokens / Math.max(digestTokens, 1)).toFixed(1)),
    byteRatio: Number((byteLen(rawText) / Math.max(byteLen(digestText), 1)).toFixed(1)),
    rawBytes: byteLen(rawText), digestBytes: byteLen(digestText),
    retention: okN / facts.length,
    facts,
    verdict: `raw 直读需 ${rawTokens} tokens；脚本压缩后 LLM 只见 ${digestTokens} tokens（${(rawTokens / Math.max(digestTokens, 1)).toFixed(1)}x），关键事实保留 ${okN}/${facts.length}`,
    params: { estTokens: 'CJK 1 字≈1 token，其余 3.5 字符≈1 token', maxDigestBytes: CFG.maxDigestBytes },
    sha256: { raw: s.sha256.raw, digest: s.sha256.digest, script: 'delta.mjs/exp' },
    version: VERSION,
  };
  const file = P.expCompress;
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}

const cmd = process.argv[2];
if (cmd === 'report') cmdReport(process.argv.includes('--write'));
else if (cmd === 'pair') {
  const a = arg('pair') || process.argv[3];
  const b = process.argv[4];
  if (!a || !b) { console.log('用法: pair <stampA> <stampB>'); process.exitCode = 2; }
  else cmdPair(a, b);
} else if (cmd === 'exp') cmdExp();
else console.log('用法: report [--write] | pair <stampA> <stampB> | exp');
