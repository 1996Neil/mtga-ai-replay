import type {CardInstance} from '../types/game.ts';
import {visibleCardId} from './cardPresentation.ts';
/** An additional view of exile cards, never battlefield membership. */
export function linkedExileGroups(field: readonly CardInstance[], exile: readonly CardInstance[]) {
  const sources = new Map(field.filter(card=>visibleCardId(card.grpId,card)>0).map(card=>[card.instanceId,card]));
  const result = new Map<number,CardInstance[]>(),seen=new Set<number>();
  for(const card of exile){
    const source=card.exiledBy != null?sources.get(card.exiledBy):undefined;
    if(!source || source.instanceId===card.instanceId || seen.has(card.instanceId) || visibleCardId(card.grpId,card)<=0)continue;
    if(card.exileSourceLogicalId && card.exileSourceLogicalId!==source.logicalId)continue;
    seen.add(card.instanceId);result.set(source.instanceId,[...(result.get(source.instanceId)??[]),card]);
  }
  return result;
}
