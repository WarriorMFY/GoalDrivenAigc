// Tool/bili/finalize.mjs —— 收尾一条命令：刷新全部产物并落判定
// 用法：node Tool/bili/finalize.mjs
// 产物：History/trend_log.md、History/trend_report.md、History/verdict.json
// 设计意图：本目标跨 48 小时，LLM 不能保证届时在线。这条命令让"收尾"可被任何人/任何时刻重放，
//           不依赖模型记忆，也不依赖对话上下文。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { BILI_DIR, HISTORY, ROOT, P, readJson, fmtIso } from './lib.mjs';

// 沙箱禁止管道捕获，但允许 stdio:'inherit'，所以逐个跑并把输出直接给终端
function run(script, args) {
  const r = spawnSync(process.execPath, [path.join(BILI_DIR, script), ...args], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  return r.status ?? 1;
}

console.log(`=== finalize ${fmtIso(new Date())} ===`);
console.log('1/3 刷新小时级趋势');
run('trend.mjs', ['--write']);
console.log('2/3 刷新趋势总表');
run('delta.mjs', ['report', '--write']);
console.log('3/3 审计并落判定');
run('audit.mjs', []);

const v = readJson(P.verdict, null);
if (v) {
  console.log('\n=== 判定 ===');
  console.log(`verdict=${v.verdict}  快照 ${v.snapshots.done}/${v.snapshots.planned}  失败项 ${v.failed.length}`);
  if (v.failed.length) for (const f of v.failed) console.log(`- ${f}`);
  if (v.budget) console.log(`额度 ${v.budget.calls}/${v.budget.limit} ¥${v.budget.costCny}`);
} else {
  console.log('\n判定文件未生成，检查 audit.mjs');
  process.exitCode = 1;
}
