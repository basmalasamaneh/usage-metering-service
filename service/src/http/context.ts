import type { Pool } from 'pg';
import type { ConsumeCoordinator } from '../accounting/coordinator';
import type { Config } from '../config';
import type { Clock } from '../domain/period';

export interface AppContext {
  pool: Pool;
  config: Config;
  clock: Clock;
  coordinator: ConsumeCoordinator;
}
