import type { StoredItem } from "@jarvis/db";

export interface Keyed {
  sourceId: string;
  contentHash: string;
}

export interface Diff<T extends Keyed> {
  created: T[];
  changed: Array<{ before: Record<string, unknown>; after: T }>;
  unchanged: T[];
  /** Previously marked removed, back again with identical content. */
  reappeared: T[];
  removed: StoredItem[];
}

export interface RemovalPolicy {
  /** Only a complete read of a collection may conclude that something is gone. */
  enabled: boolean;
  /** Limits removal to items the read could have seen (e.g. events inside the requested window). */
  inScope?: (item: StoredItem) => boolean;
}

/** Pure: incoming records vs what is stored. Identity is sourceId; change is contentHash. */
export function diffItems<T extends Keyed>(existing: Map<string, StoredItem>, incoming: T[], removal: RemovalPolicy): Diff<T> {
  const d: Diff<T> = { created: [], changed: [], unchanged: [], reappeared: [], removed: [] };
  const seen = new Set<string>();
  for (const item of incoming) {
    if (seen.has(item.sourceId)) continue; // duplicate within one response: first wins
    seen.add(item.sourceId);
    const prev = existing.get(item.sourceId);
    if (!prev) d.created.push(item);
    else if (prev.contentHash !== item.contentHash) d.changed.push({ before: prev.data, after: item });
    else if (prev.removedAt) d.reappeared.push(item);
    else d.unchanged.push(item);
  }
  if (removal.enabled) {
    for (const prev of existing.values()) {
      if (!prev.removedAt && !seen.has(prev.sourceId) && (removal.inScope?.(prev) ?? true)) d.removed.push(prev);
    }
  }
  return d;
}
