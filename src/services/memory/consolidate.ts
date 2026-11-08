import { writeDigest } from '@services/memory/inject.ts';
import { memoryMaintenance } from '@services/memory/store.ts';
import { log } from '@utils/logger.ts';

const logger = log('memory/consolidate');

export type ConsolidationReport = {
  'pruned': number;
  'superseded': number;
  'decayed': number;
  'digestWritten': boolean;
};

/**
 * The nightly hygiene pass: collapse duplicates, fade untouched rows, drop worthless ones, then rewrite the
 * workspace digest the model reads as project instructions. Everything here is deterministic — no model call.
 */
export function consolidate(guildId: string): ConsolidationReport {
  const superseded = memoryMaintenance.dedupe(guildId);
  const decayed = memoryMaintenance.applyDecay(guildId);
  const pruned = memoryMaintenance.prune(guildId);
  let digestWritten = false;
  try {
    writeDigest(guildId);
    digestWritten = true;
  } catch (error) {
    logger.warn('digest write failed during consolidation', { guildId, 'error': String(error).slice(0, 160) });
  }
  logger.info('consolidated', { guildId, superseded, decayed, pruned, digestWritten });
  return { 'pruned': pruned, 'superseded': superseded, 'decayed': decayed, digestWritten };
}

export function consolidateAll(guildIds: string[]): ConsolidationReport[] {
  return guildIds.map(guildId => consolidate(guildId));
}
