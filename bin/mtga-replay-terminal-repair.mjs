#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { repairTerminalReplay } from '../src/replay-terminal-repair.mjs';

const { values } = parseArgs({ options: {
  match: { type: 'string', multiple: true }, 'data-dir': { type: 'string' },
  apply: { type: 'boolean', default: false },
} });
if (!values.match?.length) throw new Error('Specify one or more explicit --match IDs.');
for (const matchId of new Set(values.match)) {
  const { replay, ...report } = await repairTerminalReplay(matchId, { dataDir: values['data-dir'], apply: values.apply });
  console.log(JSON.stringify(report));
}
