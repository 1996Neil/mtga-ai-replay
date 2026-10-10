export function describeMatchMode(metadata?: { event_id?: unknown; event?: unknown; queue_id?: unknown; is_jump_in?: unknown }): {
  event_id: string | null; event: string; format: string | null; is_jump_in: boolean | null; is_ranked: boolean | null; mode_key: string;
};
