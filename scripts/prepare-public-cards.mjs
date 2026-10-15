/** Explicit public metadata preparation only. No publisher, account reader,
 * background timer or credentials. Nothing runs on service startup. */
import {listReplays,getReplay,defaultDataDir} from '../src/history.mjs';
import {buildCoachCards} from '../src/coach-cards.mjs';
export async function preparePublicCards({dataDir=defaultDataDir(),allowNetwork=false,fetchFn=fetch,cardDb,displayNamesZh,onProgress}={}) {
 if(!allowNetwork)throw Error('Explicit public metadata network opt-in required');
 const matches=await listReplays({dataDir,limit:null});let completed=0,requests=0,incomplete=0;const ids=new Set();
 for(const match of matches){const replay=await getReplay(match.id,{dataDir});const cards=await buildCoachCards(replay,{dataDir,cardDb,displayNamesZh,fetchFn:async(...args)=>{requests++;return fetchFn(...args);}});for(const card of cards){ids.add(card.arena_id);if(!card.metadata_complete)incomplete++;}onProgress?.({completed:++completed,total:matches.length});}
 return {matches:completed,unique_cards:ids.size,http_requests:requests,incomplete_occurrences:incomplete};
}
