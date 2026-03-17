import path from 'path';

import { STORE_DIR } from './config.js';
import { purgeOldAlerts, backupDatabase } from './alert-db.js';
import { logger } from './logger.js';

const MAINTENANCE_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const INITIAL_DELAY = 5 * 60 * 1000; // 5 minutes after startup

let maintenanceRunning = false;

export function startMaintenanceLoop(): void {
  if (maintenanceRunning) return;
  maintenanceRunning = true;

  const backupDir = path.join(STORE_DIR, 'backups');

  const loop = () => {
    try {
      backupDatabase(backupDir, 7);
      const deleted = purgeOldAlerts(90);
      if (deleted > 0) {
        logger.info({ deleted }, 'Old alerts purged');
      }
    } catch (err) {
      logger.error({ err }, 'Maintenance loop error');
    }
    setTimeout(loop, MAINTENANCE_INTERVAL);
  };

  // First run after startup delay
  setTimeout(loop, INITIAL_DELAY);
  logger.info('Alert maintenance loop scheduled');
}
