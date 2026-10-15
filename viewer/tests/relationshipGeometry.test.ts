import test from 'node:test';
import assert from 'node:assert/strict';
import { relationshipGeometry } from '../src/lib/relationshipGeometry.ts';

test('all combat columns leave the facing midpoint and share one player endpoint, for either seat', () => {
  for (const kind of ['attack','block']) for (const direction of [-1,1]) {
    const target = {x:900,y:direction<0?30:1000,width:90,height:30};
    for (const x of [0,100,500,900,1400,2100]) {
      const card = {x,y:500,width:180,height:126}; // tapped art bounds
      const result = relationshipGeometry(kind,card,target);
      assert.equal(result.x1,x);assert.equal(result.y1,500+direction*66);
      assert.equal(result.x2,target.x);assert.equal(result.y2,target.y-direction*18);
      assert.ok(result.handleLength<=180);
    }
  }
});
test('combat can target a planeswalker without changing its identity or depending on card orientation', () => {
  const target={x:1300,y:100,width:90,height:126};
  for (const card of [{x:0,y:600,width:90,height:126},{x:0,y:600,width:126,height:90}]) {
    const before=JSON.stringify([card,target]),result=relationshipGeometry('attack',card,target);
    assert.equal(result.x1,card.x);assert.equal(result.y1,card.y-card.height/2-3);
    assert.equal(result.x2,target.x);assert.equal(result.y2,target.y+target.height/2+3);
    assert.equal(JSON.stringify([card,target]),before);
  }
});
test('combat retains vertical S tangents with bounded long handles for both attack directions', () => {
  for (const kind of ['attack','block']) for (const y of [-3000,30,850,3000]) for (const x of [0,50,500,3000]) {
    const result=relationshipGeometry(kind,{x:0,y:900,width:100,height:140},{x,y,width:60,height:30});
    assert.equal(result.c1.x,result.x1);assert.equal(result.c2.x,result.x2);
    assert.ok(result.handleLength<=180);
    assert.equal(result.handleLength,Math.min(Math.abs(result.y2-result.y1)/2,180));
    assert.ok(!result.path.includes('NaN'));
  }
});
test('short combat keeps the original midpoint S curve and ordinary source/target curves are restored', () => {
  const short=relationshipGeometry('attack',{x:0,y:300,width:90,height:126},{x:150,y:50,width:60,height:30});
  assert.equal(short.c1.y,(short.y1+short.y2)/2);assert.equal(short.c2.y,short.c1.y);
  assert.notEqual(short.c1.x,short.x1+(short.x2-short.x1)/3);
  for (const kind of ['source','target']) for (const x of [50,2000]) {
    const r=relationshipGeometry(kind,{x:0,y:900,width:100,height:140},{x,y:30,width:60,height:30});
    const vertical=Math.abs(r.y2-r.y1)>=Math.abs(r.x2-r.x1);
    assert.deepEqual(r.c1,vertical?{x:r.x1,y:(r.y1+r.y2)/2}:{x:(r.x1+r.x2)/2,y:r.y1});
    assert.deepEqual(r.c2,vertical?{x:r.x2,y:(r.y1+r.y2)/2}:{x:(r.x1+r.x2)/2,y:r.y2});
  }
});
