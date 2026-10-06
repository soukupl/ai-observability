import { dbFor } from '@ai-obs/db';
import { getMailer } from '../mail';
import type { PlatformDeps } from './companies';

/** Real dependencies: the app_platform pool and the process-wide mailer (created lazily). */
export function platformDeps(): PlatformDeps {
  return { db: dbFor('platform'), mailer: getMailer() };
}
