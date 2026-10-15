export class CoachSyncError extends Error {
  constructor(code, message) { super(message); this.name = 'CoachSyncError'; this.code = code; }
}
