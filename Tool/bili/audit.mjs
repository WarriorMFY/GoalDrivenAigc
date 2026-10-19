#!/usr/bin/env node
/**
 * 判定数据审计器 (Audit) —— 让 AGENTS.md §2 可被机器检查
 *
 * 规则：所有用于判定的数据必须由 Tool\ 下的脚本产出；一次性命令只允许探查。
 * 本脚本不取任何网络数据，只校验 History\ 下的产物是否自洽、可信、可追溯。
 *
 * 用法：
 *   node Tool\bili\audit.mjs            # 审计，失败退出码 1
 *   node Tool\bili\audit.mjs --print    # 额外打印明细
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
function opt(name, fallback = null) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}
function readLines(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .replace(/^\uFEFF/, '')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return null;
  }
}

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) {
    pass++;
    if (has('print')) console.log(`  ✓ ${name}${detail ? '  — ' + detail : ''}`);
  } else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`);
  }
}

function main() {
  const config = readJson(path.join(HERE, 'config.json')) || {};
  const outArg = opt('out');
  const outDir = typeof outArg === 'string' ? path.resolve(process.cwd(), outArg) : path.join(ROOT, 'History');

  const state = readJson(path.join(outDir, 'state.json'));
  const ledger = readJson(path.join(outDir, 'ledger.json'));
  const history = readLines(path.join(outDir, 'history.ndjson'));
  const events = readLines(path.join(outDir, 'comments.ndjson'));

  console.log(`[audit] 审计目录 ${path.relative(ROOT, outDir) || '.'}`);
  console.log('  --- 产物存在性 ---');
  check('History\\state.json 可解析', !!state);
  check('History\\ledger.json 可解析', !!ledger);
  check('History\\history.ndjson 可解析', !!history);
  check('History\\comments.ndjson 可解析', !!events);

  if (!state || !ledger || !history || !events) {
    console.log(`\n[audit] 失败：产物缺失或损坏，判定数据不可用（${fail} 项）`);
    process.exit(1);
  }

  console.log('  --- 感知快照可信性 ---');
  const required = ['t', 'ok', 'verdict', 'reliable', 'like_num', 'baseline', 'delta', 'delta_strict', 'gap_strict', 'target', 'source'];
  check('state.json 字段齐全', required.every((k) => k in state),
    required.filter((k) => !(k in state)).join(',') || '全部存在');
  check('state.ok === true', state.ok === true, `ok=${state.ok}`);
  check('数据来源标记为脚本产出', state.source === 'card.like_num', `source=${state.source}`);
  check('verdict 属于已知五态', ['PASS', 'GAP', 'NOT_STARTED', 'FAILED', 'UNKNOWN'].includes(state.verdict), `verdict=${state.verdict}`);
  check('baseline 记录了起算时刻', !!(state.baseline && state.baseline.at), state.baseline && state.baseline.at);

  console.log('  --- 留痕一致性（判定不得只在对话里存在）---');
  const last = history[history.length - 1];
  check('history 末行与 state 同源', last && last.t === state.t && last.verdict === state.verdict && last.like_num === state.like_num,
    last ? `history.t=${last.t} state.t=${state.t}; history.like_num=${last.like_num} state.like_num=${state.like_num}` : 'history 为空');
  check('history 首行样本 = 基准', history[0] && history[0].like_num === state.baseline.like_num,
    `首行=${history[0] && history[0].like_num} 基准=${state.baseline.like_num}`);
  check('history 行数 ≥ 1 且时间单调', history.length >= 1 &&
    history.every((r, i) => i === 0 || String(history[i - 1].t) <= String(r.t)),
    `${history.length} 行`);

  console.log('  --- 台账与感知交叉核对 ---');
  const derived = new Map();
  for (const ev of events) {
    const id = String(ev.rpid ?? '');
    if (!id) continue;
    if (ev.type === 'add') derived.set(id, { posted_at: ev.posted_at ?? ev.t, like: null, found: false });
    else if (derived.has(id)) {
      const d = derived.get(id);
      if (ev.like !== undefined && ev.like !== null) d.like = ev.like;
      if (ev.found !== undefined) d.found = !!ev.found;
    }
  }
  check('台账明细数 = comments.ndjson 派生的评论数', derived.size === ledger.comments_in_window,
    `派生=${derived.size} 汇总=${ledger.comments_in_window}`);
  const reward = [...derived.values()].reduce((a, d) => a + (d.like || 0), 0);
  check('台账 sum_like 与事件日志一致', reward === ledger.sum_like, `派生=${reward} 汇总=${ledger.sum_like}`);
  check('交叉核对值自洽', ledger.unexplained_likes === (ledger.like_num_delta_from_sensor - ledger.sum_like),
    `unexplained=${ledger.unexplained_likes}`);
  check('台账读到的感知增量与当前快照一致', ledger.like_num_delta_from_sensor === state.delta,
    `ledger=${ledger.like_num_delta_from_sensor} state=${state.delta}`);

  console.log('  --- 配置漂移 ---');
  check('目标与 config 一致', state.target === Number(config.target ?? 50), `state=${state.target} config=${config.target}`);
  check('时间窗与 config 一致',
    state.window && config.window && state.window.start === config.window.start && state.window.end === config.window.end,
    JSON.stringify(state.window));

  console.log('\n[audit] 明细');
  console.log(`  verdict      : ${state.verdict}  (${state.phase})`);
  console.log(`  获赞/基准    : ${state.like_num} / ${state.baseline.like_num}`);
  console.log(`  增量(严格)   : ${state.delta} (${state.delta_strict})   还差 ${state.gap_strict}`);
  console.log(`  台账 sum_like: ${ledger.sum_like}   unexplained: ${ledger.unexplained_likes}`);
  console.log(`  采样行数     : ${history.length}   评论事件: ${events.length}`);

  if (fail === 0) {
    console.log(`\n[audit] PASS：${pass} 项全部通过，判定数据可追溯`);
    process.exit(0);
  }
  console.log(`\n[audit] FAIL：${fail} 项不通过`);
  for (const f of failures) console.log('  - ' + f);
  console.log('  → 判定数据不可信，按 AGENTS.md「人在环」升级，不要基于当前快照做决策');
  process.exit(1);
}

main();
