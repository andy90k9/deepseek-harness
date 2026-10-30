/**
 * Public library API — the only entry consumers import. Exposes the
 * Orchestrator class plus the supporting type surface and domain spec
 * needed to wire an M1 sqlite backend from outside this package.
 *
 * @module @deepseek-ai/dsh-e2e-orchestrator
 */

export { Orchestrator } from './orchestrator.ts'
export { OrchestratorError, ERROR_CODES } from './errors.ts'
export type { ErrorCode, ErrorEntry, PersistedError, ErrorOwner } from './errors.ts'
export { e2eResultsSpec, runRecordSchema, artifactSchema, caseResultSchema, changeSummarySchema } from './domain-spec.ts'
export type { E2EResultsSpec } from './domain-spec.ts'
export {
  RUN_ID_RE, TASK_ID_RE, DIGEST_RE,
  newRunId, validateRunId, validateTaskId, validateDigest,
  blobUriOf, digestFromBlobUri,
} from './id.ts'
export type { RunId, TaskId, Digest } from './id.ts'

// Re-export types module directly for consumer convenience — matches the
// spec's `./types` export target.
export type {
  RunRecord, ArtifactRecord, CaseRecord, ChangeSummaryRecord,
  RunStatus, DshProfile, CopyStatus, CaseOutcome, ChangeSource,
  StartRunRequest, OrchestratorOptions, SessionId,
} from './types.ts'
export { isTerminalStatus } from './types.ts'
