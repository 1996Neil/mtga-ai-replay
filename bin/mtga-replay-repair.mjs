#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { repairArchivedReplay } from '../src/replay-repair.mjs';

const { values } = parseArgs({ options: { match: { type: 'string' }, 'data-dir': { type: 'string' }, apply: { type: 'boolean', default: false } } });
const { replay, ...report } = await repairArchivedReplay(values.match, { dataDir: values['data-dir'], apply: values.apply });
console.log(JSON.stringify(report, null, 2));
