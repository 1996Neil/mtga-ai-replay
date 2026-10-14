// Explicit legacy integration. The Replay server itself has no Coach import.
import { startReplayServer } from './server.mjs';
import { createCoachRoutes } from './live-coach/routes.mjs';
export async function startLegacyCoachServer({ liveCoach, ...options } = {}) {
  let closing = false;
  const coach = liveCoach ? createCoachRoutes(liveCoach, { isClosing: () => closing }) : null;
  const running = await startReplayServer({ ...options,
    requestExtension: coach ? (request, response, url) => coach.handle(request, response, url) : undefined,
    closeExtension: coach ? () => coach.close() : undefined,
    extraCapabilities: coach ? ['live-coach'] : [] });
  return { ...running, close: () => { closing = true; return running.close(); } };
}
