import { dbFor } from '@ai-obs/db';
import { cache } from 'react';
import { getDeployment } from './store';

/**
 * The deployment's display name for pages without a signed-in user (login, refusal page). app_web reads the one
 * deployment row without a context; falls back to 'ai-obs' when the database is unreachable, so the login page still
 * renders. Cached per request.
 */
export const deploymentName = cache(async (): Promise<string> => {
  try {
    return (await getDeployment(dbFor('web')))?.name ?? 'ai-obs';
  } catch {
    return 'ai-obs';
  }
});
