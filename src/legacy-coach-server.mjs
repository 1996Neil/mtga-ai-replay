// Explicit legacy integration. The Replay server itself has no Coach import.
import { startReplayServer } from './server.mjs';
import { createCoachRoutes } from './live-coach/routes.mjs';
export function startLegacyCoachServer({ liveCoach, ...options } = {}) {
  const coach = liveCoach ? createCoachRoutes(liveCoach) : null;
  return startReplayServer({ ...options,
    requestExtension: coach ? (request, response, url) => coach.handle(request, response, url) : undefined,
    closeExtension: coach ? () => coach.close() : undefined,
    extraCapabilities: coach ? ['live-coach'] : [] });
}
