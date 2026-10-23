// Tool/bili/budget.mjs —— 额度对账（读本机 cost-meter 真实账目，不做人工声称）
// 用法：node Tool/bili/budget.mjs [--json]
// 口径：当前会话（DSH_SESSION_ID）的累计 API 调用次数与花费；E4 判定用 calls。
// 注意：同时导出 budgetReport()，供 audit.mjs 直接调用——沙箱内不要用子进程捕获输出。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BILI_DIR, readJson } from './lib.mjs';

export function budgetReport() {
  const CFG = readJson(path.join(BILI_DIR, 'config.json'), {});
  const HOME = process.env.DSH_HOME || '';
  const SID = process.env.DSH_SESSION_ID || '';
  if (!HOME) return { ok: false, error: 'DSH_HOME 未设置，无法读取 cost-meter 账目' };
  const ledgerPath = path.join(HOME, 'storages', 'cost-meter', 'ledger.json');
  if (!fs.existsSync(ledgerPath)) return { ok: false, error: `找不到账目文件 ${ledgerPath}` };
  const ledger = readJson(ledgerPath);
  if (!ledger) return { ok: false, error: '账目文件无法解析' };

  const days = ledger.days || {};
  const rows = [];
  for (const [date, d] of Object.entries(days)) {
    for (const s of d.sessions || []) {
      if (SID && s.id !== SID) continue;
      rows.push({
        date, id: s.id, calls: s.calls || 0, input: s.input || 0, output: s.output || 0,
        cacheRead: s.cacheRead || 0, costUsd: s.cost || 0,
      });
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  const rate = ledger.config?.exchangeRate || 7.2;
  const tot = rows.reduce((a, r) => ({
    calls: a.calls + r.calls, input: a.input + r.input, output: a.output + r.output,
    cacheRead: a.cacheRead + r.cacheRead, costUsd: a.costUsd + r.costUsd,
  }), { calls: 0, input: 0, output: 0, cacheRead: 0, costUsd: 0 });

  const limit = CFG.budget?.callsLimit ?? 80;
  const hard = CFG.budget?.callsHardLimit ?? 96;
  return {
    ok: tot.calls <= limit,
    session: SID,
    days: rows,
    calls: tot.calls,
    callsLimit: limit,
    callsHardLimit: hard,
    overLimit: tot.calls > limit,
    overHardLimit: tot.calls > hard,
    remaining: Math.max(limit - tot.calls, 0),
    inputTokens: tot.input,
    outputTokens: tot.output,
    cacheReadTokens: tot.cacheRead,
    costUsd: Number(tot.costUsd.toFixed(4)),
    costCny: Number((tot.costUsd * rate).toFixed(4)),
    source: ledgerPath,
    at: new Date().toISOString(),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const out = budgetReport();
  if (out.error) {
    console.error(JSON.stringify({ ok: false, error: out.error }, null, 1));
    process.exitCode = 2;
  } else if (process.argv.includes('--json')) {
    console.log(JSON.stringify(out, null, 1));
  } else {
    console.log(`会话 ${out.session}`);
    console.log(`调用 ${out.calls}/${out.callsLimit}（硬上限 ${out.callsHardLimit}）  剩余 ${out.remaining}`);
    console.log(`token 输入 ${out.inputTokens} 输出 ${out.outputTokens} 缓存读 ${out.cacheReadTokens}`);
    console.log(`花费 $${out.costUsd} ≈ ¥${out.costCny}`);
    console.log(`来源 ${out.source}`);
    console.log(out.overHardLimit ? '状态 超硬上限 → FAILED' : out.overLimit ? '状态 超预算 → 需说明' : '状态 正常');
  }
}
