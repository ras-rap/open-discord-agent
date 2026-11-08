import { backup } from '@cli/backup.ts';
import { config } from '@services/config.ts';
import { consolidateAll } from '@services/memory/consolidate.ts';
import { log } from '@utils/logger.ts';

import type { Supervisor } from '@services/agent/supervisor.ts';

const logger = log('scheduler');

const CONSOLIDATE_EVERY_MS = 6 * 60 * 60_000;
const BACKUP_EVERY_MS = 24 * 60 * 60_000;
const TICK_MS = 5 * 60_000;

/**
 * Two periodic jobs, both cheap and deterministic: memory hygiene (every 6h) and a database snapshot
 * (daily). Timers are plain intervals plus a last-run stamp, so a restart simply re-runs them.
 */
export class Scheduler {
  private timer?: Timer;
  private lastConsolidate = 0;
  private lastBackup = 0;

  constructor(private readonly supervisor: Supervisor) {}

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    logger.info('scheduler started', {
      'consolidateEveryHours': CONSOLIDATE_EVERY_MS / 3_600_000,
      'backupEveryHours': BACKUP_EVERY_MS / 3_600_000,
    });
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Exposed so `/status` (or a test) can report when the jobs last ran. */
  snapshot(): { 'lastConsolidate': number; 'lastBackup': number } {
    return { 'lastConsolidate': this.lastConsolidate, 'lastBackup': this.lastBackup };
  }

  private tick(): void {
    const now = Date.now();
    if (now - this.lastConsolidate >= CONSOLIDATE_EVERY_MS) {
      this.lastConsolidate = now;
      try {
        const guilds = Object.entries(config.raw())
          .filter(([, guild]) => guild.enabled)
          .map(([guildId]) => guildId);
        if (guilds.length > 0) {
          const reports = consolidateAll(guilds);
          logger.info('consolidation finished', {
            'guilds': guilds.length,
            'merged': reports.reduce((sum, report) => sum + report.superseded, 0),
          });
        }
      } catch (error) {
        logger.warn('consolidation failed', { 'error': String(error).slice(0, 200) });
      }
    }

    if (now - this.lastBackup >= BACKUP_EVERY_MS) {
      this.lastBackup = now;
      void backup().catch(error => logger.warn('scheduled backup failed', { 'error': String(error).slice(0, 200) }));
    }
    void this.supervisor;
  }
}
