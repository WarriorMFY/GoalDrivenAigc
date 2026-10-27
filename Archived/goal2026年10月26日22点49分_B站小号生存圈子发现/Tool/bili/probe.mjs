// probe.mjs —— 接口探查器（只读，不产出判定数据）
//
// 用法：
//   node Tool\bili\probe.mjs                 # 用 config.json 第一个关键词
//   node Tool\bili\probe.mjs "AI资讯"        # 指定关键词
//
// 产出：History\probes\<stamp>.json —— 记录端点可用性、字段形状、风控命中情况。
// 用途：换网络 / 换关键词前先跑一次，避免 collect 跑到一半被风控掐断。

import {
  loadConfig,
  urls,
  fetchJson,
  stampNow,
  isoNow,
  writeJson,
  historyPath,
  log,
  line,
} from './lib.mjs';

const cfg = loadConfig();
const kw = process.argv[2] || cfg.clusters[0].keywords[0];
const retries = cfg.sampling.retries;
const searchDelay = cfg.sampling.searchDelayMs;
const apiDelay = cfg.sampling.apiDelayMs;

const out = { stamp: stampNow(), at: isoNow(), keyword: kw, checks: [] };

line(`=== probe: ${kw} ===`);

// 1) search（order=pubdate）—— 这是唯一的样本入口
const r1 = await fetchJson(urls.search(kw, 1, cfg.sampling.order), { delayMs: searchDelay, retries });
const items = r1.ok && r1.data && Array.isArray(r1.data.result) ? r1.data.result : [];
const first = items[0] || null;
out.checks.push({
  name: 'search',
  ok: r1.ok,
  code: r1.code,
  msg: r1.msg || '',
  numResults: r1.ok && r1.data ? r1.data.numResults : null,
  itemsOnPage: items.length,
  fields: first ? Object.keys(first).sort() : [],
  sample: first
    ? {
        bvid: first.bvid,
        mid: first.mid,
        author: first.author,
        play: first.play,
        like: first.like,
        review: first.review,
        favorites: first.favorites,
        pubdate: first.pubdate,
        typename: first.typename,
      }
    : null,
});
line(
  `search   ok=${r1.ok} code=${r1.code} 本页条数=${items.length} 总结果=${r1.ok && r1.data ? r1.data.numResults : 'n/a'}` +
    (r1.ok ? '' : ` (${r1.msg})`)
);

// 2) card —— 用来反查作者粉丝数（识别 0 粉号）
let card = null;
if (first && first.mid) {
  const r2 = await fetchJson(urls.card(first.mid), { delayMs: apiDelay, retries });
  const d = r2.ok ? r2.data || {} : {};
  const c = d.card || {};
  card = {
    ok: r2.ok,
    code: r2.code,
    msg: r2.msg || '',
    mid: first.mid,
    fans_d_top: d.fans, // 老字段，部分账号有
    fans_d_card: c.fans, // 新字段，通常在 card 里
    attention: d.attention,
    authorName: c.name,
    sign_len: typeof c.sign === 'string' ? c.sign.length : null,
    level: c.level_info ? c.level_info.current_level : null,
    archive_count: d.archive_count ?? c.archive_count ?? null,
    keys: Object.keys(d).sort(),
    cardKeys: Object.keys(c).sort(),
  };
  out.checks.push({ name: 'card', ...card });
  line(
    `card     ok=${r2.ok} code=${r2.code} mid=${first.mid} fans(card)=${card.fans_d_card} fans(d)=${card.fans_d_top} 稿件=${card.archive_count}`
  );
}

// 3) view —— 取权威 stat（赞/币/藏/评/播放）
let view = null;
if (first && first.bvid) {
  const r3 = await fetchJson(urls.view(first.bvid), { delayMs: apiDelay, retries });
  const d = r3.ok ? r3.data || {} : {};
  const s = d.stat || {};
  view = {
    ok: r3.ok,
    code: r3.code,
    msg: r3.msg || '',
    bvid: first.bvid,
    aid: d.aid,
    pubdate: d.pubdate,
    stat: {
      view: s.view,
      like: s.like,
      coin: s.coin,
      favorite: s.favorite,
      reply: s.reply,
      danmaku: s.danmaku,
    },
  };
  out.checks.push({ name: 'view', ...view });
  line(
    `view     ok=${r3.ok} code=${r3.code} view=${s.view} like=${s.like} coin=${s.coin} fav=${s.favorite} reply=${s.reply}`
  );
}

// 4) 小号可识别性自检：本页有多少条 mid，去重后多少（决定 card 请求量）
if (items.length) {
  const mids = [...new Set(items.map((x) => x.mid).filter(Boolean))];
  out.checks.push({ name: 'mids', total: items.length, unique: mids.length });
  line(`mids     本页 ${items.length} 条 → 唯一作者 ${mids.length} 个（card 请求量上限）`);
}

out.summary = {
  allOk: out.checks.filter((c) => c.name !== 'mids').every((c) => c.ok),
  searchOk: out.checks.find((c) => c.name === 'search')?.ok === true,
  cardOk: out.checks.find((c) => c.name === 'card')?.ok === true,
  viewOk: out.checks.find((c) => c.name === 'view')?.ok === true,
};

const file = writeJson(historyPath('probes', `${out.stamp}.json`), out);
line('');
line(`结论：search=${out.summary.searchOk} card=${out.summary.cardOk} view=${out.summary.viewOk}`);
line(`留痕：${file}`);
