// Ingest API building blocks (BRIEF §6). The admin UI uses generateToken / hashToken.
export { generateToken, hashToken, parseBearer, type GeneratedToken, type ParsedBearer } from './tokens';
export {
  AuthGuard,
  TokenBucketLimiter,
  clientIp,
  ingestAuthGuard,
  ingestRateLimiter,
  rateLimitOptionsFromEnv,
  type RateLimitOptions,
} from './rate-limit';
export { handleCollectorConfig, handleIngest, type IngestDeps } from './handler';
export { handleDeviceCode, handleDeviceToken, type DeviceDeps } from './device';
export { processBatch, orderEvents } from './process-batch';
export { effectiveProject, hashProjectKey, resolveTeam, sessionKey, turnKey } from './resolve';
