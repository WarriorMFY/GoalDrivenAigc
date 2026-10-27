// collect.mjs —— 取样器：按关键词簇取"最新投稿"样本，反查作者粉丝，挑出 0 粉号作品
//
// 用法：
//   node Tool\bili\collect.mjs                 # 全量（config.json 的 3 簇 8 词 × 3 页）
//   node Tool\bili\collect.mjs --pages 1       # 快速试跑（1 页/词）
//   node Tool\bili\collect.mjs --clusters ai-tools
//   node Tool\bili\collect.mjs --keywords "AI资讯,AI翻译" --pages 2
//
// 产出：
//   History\samples\<stamp>.json     全量明细（判定数据源）
//   History\samples.ndjson           每轮一行的轻量索引
//   History\cache\card_<mid>.json    作者粉丝缓存
//
// 口径（与 Goal.md / bili.md 一致）：
//   小号作品 := 作者 card.fans === 0
//   互动率 R := (like + reply + coin + favorite) / play，play = 0 剔除
//   R 优先用 view 接口的权威 stat；view 失败才回退 search 字段

import fs from 'node:fs';
import path from 'node:path';
import {
  loadConfig,
  urls,
  fetchJson,
  stampNow,
  isoNow,
  makeCardCache,
  writeJson,
  appendNdjson,
  historyPath,
  ensureDir,
  rateOf,
  median,
  sha256File,
  log,
  line,
} from './lib.mjs';

const cfg = loadConfig();
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const pages = Number(argOf('pages') || cfg.sampling.pages);
const onlyClusters = argOf('clusters');
const onlyKeywords = argOf('keywords');

const clusters = cfg.clusters
  .filter((c) => !onlyClusters || c.id === onlyClusters)
  .map((c) => ({
    ...c,
    keywords: onlyKeywords ? c.keywords.filter((k) => onlyKeywords.split(',').includes(k)) : c.keywords,
  }))
  .filter((c) => c.keywords.length > 0);

if (clusters.length === 0) {
  console.error('没有匹配的关键词簇，检查 --clusters / --keywords 参数');
  process.exit(2);
}

const { order, searchDelayMs, searchJitterMs, apiDelayMs, retries, riskBackoffMs, cardCacheTtlHours } = cfg.sampling;
const { maxFans, maxArchiveCount, smallDef } = cfg.thresholds;

// search 结果里的数字可能是 "1.2万" 这类字符串
function num(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (!s) return 0;
  const m = s.match(/^([\d.]+)\s*(万|亿)?$/);
  if (!m) return Number(s.replace(/[^\d.]/g, '')) || 0;
  const base = Number(m[1]);
  if (m[2] === '万') return Math.round(base * 10000);
  if (m[2] === '亿') return Math.round(base * 100000000);
  return Math.round(base);
}

const stamp = stampNow();
const startedAt = new Date();
line(`=== collect ${stamp} | 簇=${clusters.map((c) => c.id).join(',')} | pages=${pages} | order=${order} ===`);

const cardCache = makeCardCache(cardCacheTtlHours);
const errors = [];
const result = { stamp, at: isoNow(), order, pages, smallDef, clusters: [] };

for (const cluster of clusters) {
  const items = [];
  const seen = new Set();

  for (const kw of cluster.keywords) {
    let kwCount = 0;
    for (let page = 1; page <= pages; page++) {
      const r = await fetchJson(urls.search(kw, page, order), {
        delayMs: searchDelayMs,
        jitterMs: searchJitterMs,
        retries,
        riskBackoffMs,
      });
      if (!r.ok) {
        errors.push({ scope: 'search', keyword: kw, page, code: r.code, msg: r.msg });
        line(`  [warn] search "${kw}" p${page} 失败 ${r.code} ${r.msg || ''}`);
        break;
      }
      const list = Array.isArray(r.data?.result) ? r.data.result : [];
      if (list.length === 0) break;
      for (const it of list) {
        const bvid = it.bvid;
        if (!bvid || seen.has(bvid)) continue;
        seen.add(bvid);
        items.push({
          bvid,
          aid: it.aid,
          mid: it.mid,
          author: typeof it.author === 'string' ? it.author : '',
          title: String(it.title || '').replace(/<[^>]+>/g, ''),
          keyword: kw,
          cluster: cluster.id,
          typename: it.typename,
          pubdate: it.pubdate,
          searchStat: {
            play: num(it.play),
            like: num(it.like),
            reply: num(it.review),
            favorite: num(it.favorites),
            danmaku: num(it.video_review),
          },
        });
        kwCount++;
      }
      line(`  search "${kw}" p${page}: +${list.length} 条（累计本词 ${kwCount}）`);
    }
  }

  // 反查作者粉丝
  const mids = [...new Set(items.map((x) => x.mid).filter((m) => m !== undefined && m !== null))];
  line(`  簇 ${cluster.id}: 样本 ${items.length} 条 / 唯一作者 ${mids.length} 个 → 反查粉丝`);

  const fansOf = new Map();
  const archiveOf = new Map();
  const unknown = [];
  let cardOk = 0;
  for (const mid of mids) {
    let rec = cardCache.get(mid);
    if (!rec) {
      const r = await fetchJson(urls.card(mid), { delayMs: apiDelayMs, retries });
      if (!r.ok) {
        unknown.push({ mid, code: r.code, msg: r.msg });
        continue;
      }
      const d = r.data || {};
      const c = d.card || {};
      const fans = typeof c.fans === 'number' ? c.fans : typeof d.fans === 'number' ? d.fans : null;
      rec = {
        mid,
        fans,
        name: c.name || '',
        archiveCount: d.archive_count ?? c.archive_count ?? null,
        level: c.level_info ? c.level_info.current_level : null,
        fetchedAt: new Date().toISOString(),
      };
      cardCache.set(mid, rec);
    }
    cardOk++;
    if (rec.fans === null) unknown.push({ mid, code: 'NO_FANS_FIELD', msg: '响应无 fans 字段' });
    else fansOf.set(mid, rec.fans);
    archiveOf.set(mid, rec.archiveCount === undefined ? null : rec.archiveCount);
  }

  for (const it of items) {
    it.fans = fansOf.has(it.mid) ? fansOf.get(it.mid) : null;
    it.archiveCount = archiveOf.has(it.mid) ? archiveOf.get(it.mid) : null;
  }

  // 新号作品 := fans <= maxFans 且 投稿数 <= maxArchiveCount（口径见 config.thresholds.smallDef）
  const small = items.filter(
    (x) =>
      x.fans !== null &&
      x.fans <= maxFans &&
      x.archiveCount !== null &&
      x.archiveCount <= maxArchiveCount
  );

  // 用 view 取权威 stat
  for (const it of small) {
    const r = await fetchJson(urls.view(it.bvid), { delayMs: apiDelayMs, retries });
    if (r.ok && r.data) {
      const s = r.data.stat || {};
      it.stat = {
        source: 'view',
        play: Number(s.view) || 0,
        like: Number(s.like) || 0,
        reply: Number(s.reply) || 0,
        coin: Number(s.coin) || 0,
        favorite: Number(s.favorite) || 0,
        danmaku: Number(s.danmaku) || 0,
      };
      it.pubdate = r.data.pubdate ?? it.pubdate;
    } else {
      it.stat = { source: 'search', ...it.searchStat, coin: 0 };
      errors.push({ scope: 'view', bvid: it.bvid, code: r.code, msg: r.msg });
    }
    it.rate = rateOf(it.stat);
  }

  const rates = small.map((x) => x.rate).filter((v) => v !== null);
  const summary = {
    id: cluster.id,
    name: cluster.name,
    keywords: cluster.keywords,
    samples: items.length,
    uniqueAuthors: mids.length,
    cardOk,
    unknownFans: unknown.length,
    smallSamples: small.length,
    smallWithPlay: rates.length,
    medianRate: median(rates),
    unknownDetail: unknown.slice(0, 20),
    // 明细层：全部样本（含 fans），供 audit 做粉丝直方图与偏倚检查
    items: items.map((x) => ({
      bvid: x.bvid,
      mid: x.mid,
      author: x.author,
      keyword: x.keyword,
      typename: x.typename,
      pubdate: x.pubdate,
      fans: x.fans,
      archiveCount: x.archiveCount,
      stat: x.stat || x.searchStat,
      rate: x.rate ?? null,
    })),
    small: small.map((x) => ({
      bvid: x.bvid,
      mid: x.mid,
      author: x.author,
      fans: x.fans,
      archiveCount: x.archiveCount,
      keyword: x.keyword,
      title: x.title.slice(0, 60),
      pubdate: x.pubdate,
      ageHours: x.pubdate ? Math.round(((Date.now() / 1000 - x.pubdate) / 3600) * 10) / 10 : null,
      stat: x.stat,
      rate: x.rate,
    })),
  };
  result.clusters.push(summary);
  line(
    `  → 样本 ${summary.samples}｜未知粉丝 ${summary.unknownFans}｜0粉作品 ${summary.smallSamples}（有效播放 ${summary.smallWithPlay}）｜中位互动率 ${
      summary.medianRate === null ? 'n/a' : (summary.medianRate * 100).toFixed(2) + '%'
    }`
  );
}

result.errors = errors;
const outFile = ensureDir(historyPath('samples')) && writeJson(historyPath('samples', `${stamp}.json`), result);
const digest = sha256File(outFile);
result.sha256 = digest;

appendNdjson(historyPath('samples.ndjson'), {
  stamp,
  at: result.at,
  order,
  pages,
  clusters: result.clusters.map((c) => ({
    id: c.id,
    samples: c.samples,
    smallSamples: c.smallSamples,
    smallWithPlay: c.smallWithPlay,
    medianRate: c.medianRate,
    unknownFans: c.unknownFans,
  })),
  errors: errors.length,
  sha256: digest,
  file: path.relative(path.join(process.cwd()), outFile),
});

line('');
line(`错误 ${errors.length} 条`);
line(`明细：${outFile}`);
line(`sha256：${digest}`);
line(`用时：${Math.round((Date.now() - startedAt.getTime()) / 1000)}s`);
