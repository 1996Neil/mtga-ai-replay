// Public synthetic GRE fixture: no private logs, account data or card database.
export function syntheticMatchRecords(id, minute = 0) {
  const gre = (msgId, fields) => ({ greToClientEvent: { greToClientMessages: [{ type: 'GREMessageType_GameStateMessage', systemSeatIds: [2], msgId: minute * 10 + msgId,
    gameStateMessage: { type: 'GameStateType_Diff', gameStateId: minute * 10 + msgId, ...fields } }] } });
  return [
    { timestamp: String(Date.parse(`2026-10-01T12:${String(minute).padStart(2, '0')}:00Z`)), matchGameRoomStateChangedEvent: {
      stateType: 'MatchGameRoomStateType_Playing', gameRoomInfo: { gameRoomConfig: { matchId: id, reservedPlayers: [
        { systemSeatId: 1, teamId: 1, userId: 'synthetic-opponent', playerName: 'Synthetic Opponent', platformId: 'Mac', eventId: 'Jump_In_2024' },
        { systemSeatId: 2, teamId: 2, userId: 'synthetic-me', playerName: 'Synthetic Me', platformId: 'Mac', eventId: 'Jump_In_2024' },
      ] } } } },
    gre(1, { type: 'GameStateType_Full', gameInfo: { gameNumber: 1, stage: 'GameStage_Play' },
      turnInfo: { turnNumber: 1, activePlayer: 2, phase: 'Phase_Begin', step: 'Step_Draw' },
      players: [{ systemSeatNumber: 1, lifeTotal: 20 }, { systemSeatNumber: 2, lifeTotal: 20 }], zones: [], gameObjects: [] }),
    gre(2, { gameInfo: { gameNumber: 1, stage: 'GameStage_GameOver', results: [{ scope: 'MatchScope_Game', winningTeamId: 2, reason: 'ResultReason_Life' }] },
      players: [{ systemSeatNumber: 1, lifeTotal: 0, turnNumber: 1 }, { systemSeatNumber: 2, lifeTotal: 6, turnNumber: 1 }] }),
    { matchGameRoomStateChangedEvent: { stateType: 'MatchGameRoomStateType_MatchCompleted', gameRoomInfo: { finalMatchResult: { matchId: id,
      resultList: [{ scope: 'MatchScope_Game', winningTeamId: 2, reason: 'ResultReason_Life' }, { scope: 'MatchScope_Match', winningTeamId: 2, reason: 'ResultReason_Life' }] } } } },
  ];
}
export function syntheticLog(matches) {
  return 'DETAILED LOGS: ENABLED\n' + matches.flatMap(([id, minute]) => syntheticMatchRecords(id, minute)).map(record => JSON.stringify(record)).join('\n') + '\n';
}
