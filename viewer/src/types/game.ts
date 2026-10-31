export type ZoneType =
  | 'ZoneType_Hand'
  | 'ZoneType_Library'
  | 'ZoneType_Battlefield'
  | 'ZoneType_Graveyard'
  | 'ZoneType_Exile'
  | 'ZoneType_Stack'
  | 'ZoneType_Sideboard'
  | 'ZoneType_Limbo'
  | 'ZoneType_Command';

export interface CardInstance {
  instanceId: number;
  grpId: number;
  zoneId: number;
  ownerSeatId: number;
  controllerSeatId: number;
  cardTypes: string[];
  isTapped: boolean;
  power?: number;
  toughness?: number;
  counters: Record<string, number>;
  isAttacking: boolean;
  name?: string;
  objectType?: string; // GameObjectType_Card | GameObjectType_Token | GameObjectType_Ability ...
  logicalId?: string;
  visibility?: string;
  isBlocking?: boolean;
  blockedAttackerIds?: number[];
  attackingTargetId?: number;
  attachedTo?: number;
  exiledBy?: number;
  exileSourceLogicalId?: string;
  attachments?: number[];
  targetIds?: number[];
  targets?: Record<string, unknown>[];
  abilitySource?: Record<string, unknown>;
  manaCost?: string;
  typeLine?: string;
  damage?: number;
}

export interface Zone {
  zoneId: number;
  type: ZoneType;
  ownerSeatId?: number;
  objectInstanceIds: number[];
}

export interface PlayerState {
  systemSeatId: number;
  playerName: string;
  lifeTotal: number | null;
  handSize: number | null;
  librarySize: number | null;
}

export interface TurnInfo {
  turnNumber: number;
  phase: string;
  step?: string;
  activePlayer: number;
  priorityPlayer?: number;
}

export interface AnnotationDetail {
  key: string;
  type: string;
  valueInt32?: number[];
  valueString?: string[];
}

export interface Annotation {
  id: number;
  affectorId?: number;
  affectedIds: number[];
  type: string[];
  details?: AnnotationDetail[];
}

export interface GameState {
  gameStateId: number;
  turnInfo: TurnInfo;
  players: PlayerState[];
  zones: Map<number, Zone>;
  gameObjects: Map<number, CardInstance>;
  annotations: Annotation[];
  battlefieldByOwner: Record<number, CardInstance[]>;
  handByOwner: Record<number, CardInstance[]>;
  handHistoryByOwner?: Record<number, CardInstance[]>;
  graveyardByOwner: Record<number, CardInstance[]>;
  exileObjects: CardInstance[];
  stackObjects: CardInstance[];
  zoneTypeMap: Map<number, ZoneType>;
}

export interface ReplayStep {
  stepIndex: number;
  turnNumber: number;
  phase: string;
  step?: string;
  label: string;
  gameState: GameState;
  eventsSinceLastStep: Annotation[];
  anchor: string;
  actionNumber: number;
  event?: CanonicalEvent;
  beforeGameState?: GameState;
  groupedFrame: boolean;
  stateId?: string;
  coachNotes: CoachNote[];
  warnings: string[];
}

export interface MatchPlayer {
  systemSeatId: number;
  playerName: string;
}

export interface ParsedMatch {
  matchId: string;
  players: MatchPlayer[];
  localSeatId: number;
  steps: ReplayStep[];
  grpIds: Set<number>;
  result?: { winningSeatId: number; reason: string };
  startedAt: string;
  gameNumber: number;
  eventName: string;
  outcome?: string;
  warnings: string[];
}

export interface CoachNote { anchor: string; text: string; title?: string; }
export interface CanonicalEvent {
  type?: string; actor?: string; card?: Record<string, unknown>;
  targets?: Record<string, unknown>[]; amount?: number; details?: string;
  from?: string; to?: string; life?: { me?: number; opponent?: number };
  phase?: string; step?: string;
}
export interface HistoryMatch { id: string; startedAt: string; event: string; result: string; gameCount?: number; revision?: string; }

export interface DraftRunMatch {
  id: string;
  started_at: string;
  result: string | null;
  game_count: number | null;
  account_key?: string;
  binding_evidence?: string;
}
export interface DraftPick {
  pack_number: number;
  pick_number: number;
  picked_at: string | null;
  candidates: { arena_id: number; name: string }[];
  selected: { arena_id: number; name: string } | null;
  pool_before: { arena_id: number; name: string }[];
  pool_after: { arena_id: number; name: string }[];
  complete: boolean;
  missing: string[];
}
export interface DraftRun {
  capture_source?: string;
  binding?: string;
  bound_run_id?: string;
  binding_method?: string;
  binding_reason?: string;
  binding_card_count?: number;
  binding_pending_matches?: number;
  binding_account_status?: 'matched' | 'conflict' | 'unknown';
  binding_account_key?: string;
  capture_run_ids?: string[];
  run_id: string;
  event_id: string;
  event: string;
  started_at: string | null;
  status: 'in_progress' | 'completed' | 'incomplete';
  current_module?: string | null;
  score_verified: boolean;
  replay_wins: number;
  replay_losses: number;
  course_wins: number | null;
  course_losses: number | null;
  colors: string[];
  colors_complete: boolean;
  card_pool: { arena_id: number; name: string }[];
  matches: DraftRunMatch[];
  picks: DraftPick[];
}

export interface WorkerProgress {
  type: 'progress';
  pct: number;
}

export interface WorkerDone {
  type: 'done';
  matches: SerializableMatch[];
}

export interface WorkerError {
  type: 'error';
  message: string;
}

export type WorkerMessage = WorkerProgress | WorkerDone | WorkerError;

// Serializable version for postMessage (Maps converted to arrays)
export interface SerializableGameState {
  gameStateId: number;
  turnInfo: TurnInfo;
  players: PlayerState[];
  zones: [number, Zone][];
  gameObjects: [number, CardInstance][];
  annotations: Annotation[];
  battlefieldByOwner: Record<number, CardInstance[]>;
  handByOwner: Record<number, CardInstance[]>;
  handHistoryByOwner?: Record<number, CardInstance[]>;
  graveyardByOwner: Record<number, CardInstance[]>;
  exileObjects: CardInstance[];
  stackObjects: CardInstance[];
  zoneTypeMap: [number, ZoneType][];
}

export interface SerializableStep {
  stepIndex: number;
  turnNumber: number;
  phase: string;
  step?: string;
  label: string;
  gameState: SerializableGameState;
  eventsSinceLastStep: Annotation[];
}

export interface SerializableMatch {
  matchId: string;
  players: MatchPlayer[];
  localSeatId: number;
  steps: SerializableStep[];
  grpIds: number[];
  result?: { winningSeatId: number; reason: string };
  startedAt: string;
}
