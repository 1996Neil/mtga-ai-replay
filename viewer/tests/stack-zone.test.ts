import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { normalizeState } from '../src/lib/canonicalAdapter.ts';

test('actual stack component preserves recorded top-first resolution and redacts hidden faces and targets', async t => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  t.after(() => server.close());
  const { StackZone } = await server.ssrLoadModule('/src/components/StackZone.tsx');
  // Real observed transitions: [383,382,379] -> [382,379] -> [379] -> [].
  const stack = [383,382,379].map((id,i) => ({ instance_id:id,arena_id:100+i,name:`Public ${id}`,visibility:'public',is_ability:i<2 }));
  const raw = { players: { me: {name:'Me'}, opponent:{name:'Opponent'} }, stack };
  const original = structuredClone(raw);
  for (const offset of [0,1,2,3]) {
    const state = normalizeState({...raw,stack:stack.slice(offset)});
    const markup = renderToStaticMarkup(createElement(StackZone,{cards:state.stackObjects}));
    const ids = [...markup.matchAll(/data-card-instance="(\d+)"/g)].map(m=>Number(m[1]));
    assert.deepEqual(ids,[383,382,379].slice(offset));
    if(ids.length){assert.doesNotMatch(markup,/class="stack-details"/);assert.match(markup,/下一项结算/);assert.match(markup,/收起堆叠/);}else assert.equal(markup,'');
    if(ids.length>1)assert.match(markup,/展开全部堆叠/);
  }
  assert.deepEqual(raw,original);
  const hidden = normalizeState({...raw,stack:[{instance_id:500,arena_id:999999,name:'Hidden Secret',visibility:'hidden',targets:[{arena_id:888888,name:'Secret Target',hidden:true}]}]});
  const safe = renderToStaticMarkup(createElement(StackZone,{cards:hidden.stackObjects,analysis:true}));
  assert.match(safe,/未知牌/);assert.match(safe,/未知目标/);assert.doesNotMatch(safe,/Hidden Secret|Secret Target|999999|888888/);
});
