/** Match identity must outlive message arrival order. A new connection can
 * precede its room config and must never overwrite the completed match's seat. */
export function indexMatchMetadata(records) {
  const metadata = new Map();
  for (const record of records) {
    const config = record.matchGameRoomStateChangedEvent?.gameRoomInfo?.gameRoomConfig;
    if (config?.matchId && !metadata.has(config.matchId)) metadata.set(config.matchId, { config, timestamp: record.timestamp });
  }
  let current, pending;
  const closed = new Set();
  function assign(id, seat, priority) {
    const match = metadata.get(id);
    if (!match || !Number.isInteger(seat) || !match.config.reservedPlayers?.some(player => player.systemSeatId === seat)) return;
    if (match.seatConflict || (match.seatPriority ?? 0) > priority) return;
    if (priority === 3 && match.seatPriority === 3 && match.localSeat !== seat) {
      delete match.localSeat; match.seatConflict = true; return;
    }
    if (priority === 1 && match.localSeat !== undefined) return;
    match.localSeat = seat; match.seatPriority = priority; match.seatConfirmed = priority >= 2;
  }
  for (const record of records) {
    const room = record.matchGameRoomStateChangedEvent, info = room?.gameRoomInfo;
    const id = info?.gameRoomConfig?.matchId;
    if (id) {
      current = id;
      if (pending && pending.after !== id) { assign(id, pending.seat, 2); pending = undefined; }
    }
    const completed = info?.finalMatchResult?.matchId ??
      ((room?.stateType ?? info?.stateType) === 'MatchGameRoomStateType_MatchCompleted' ? current : null);
    if (completed) closed.add(completed);
    const messages = record.greToClientEvent?.greToClientMessages ?? [];
    const explicitIds = [...new Set(messages.map(message => message.gameStateMessage?.gameInfo?.matchID ??
      message.gameStateMessage?.gameInfo?.matchId).filter(id => typeof id === 'string' && metadata.has(id)))];
    for (const message of messages) {
      const game = message.gameStateMessage, gameInfo = game?.gameInfo;
      const explicit = gameInfo?.matchID ?? gameInfo?.matchId;
      const seat = message.systemSeatIds?.length === 1 ? message.systemSeatIds[0] : undefined;
      if (typeof explicit === 'string' && metadata.has(explicit)) {
        current = explicit;
        assign(explicit, seat, 3);
        if (pending && pending.after !== explicit) { assign(explicit, pending.seat, 2); pending = undefined; }
      }
      if (message.type === 'GREMessageType_ConnectResp' && Number.isInteger(seat)) {
        const bound = explicitIds.length === 1 ? explicitIds[0] : current;
        if (bound && !closed.has(bound)) assign(bound, seat, 2);
        else pending = { seat, after: current };
      } else if (game && current && !closed.has(current)) assign(current, seat, 1);
      // A Bo3 game's GameOver is not the end of the match.
      if (gameInfo?.matchState === 'MatchState_MatchComplete' && current) closed.add(current);
    }
  }
  return metadata;
}
