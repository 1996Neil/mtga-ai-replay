// Explicit offline workbench: one supplied sanitized game, no network or DB.
import { readFile, writeFile } from 'node:fs/promises';
import { buildDecisionAudit, validateDecisionAudit } from '../src/review/decision-audit.mjs';

const [mode, inputPath, ledgerPath, reportPath] = process.argv.slice(2);
if (!['plan', 'check'].includes(mode) || !inputPath || !ledgerPath)
  throw Error('Use: plan INPUT.json NEW-PLAN.json | check INPUT.json LEDGER.json [REPORT.json]');
const input = JSON.parse(await readFile(inputPath, 'utf8'));
const plan = buildDecisionAudit(input);
if (mode === 'plan') {
  await writeFile(ledgerPath, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ decisions: plan.items.length, plan_hash: plan.plan_hash }));
} else {
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  const report = reportPath ? JSON.parse(await readFile(reportPath, 'utf8')) : undefined;
  console.log(JSON.stringify(validateDecisionAudit(plan, ledger, report)));
}
