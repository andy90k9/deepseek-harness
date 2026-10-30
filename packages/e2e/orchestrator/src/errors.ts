/**
 * Stable error codes for the e2e orchestrator. Callers branch on `code`,
 * never parse `message`. Each code carries an owning subsystem.
 * @module @deepseek-ai/dsh-e2e-orchestrator/src/errors
 */

/** Subsystem that emitted the failure. */
export type ErrorOwner = 'api' | 'orchestrator' | 'collector' | 'etl' | 'assertor'

/** One stable error entry from the spec. */
export interface ErrorEntry {
  /** The stable code — what callers match on. */
  readonly code: string
  /** HTTP status used by the HTTP surface; 200 for run-level codes that do not reject the request. */
  readonly http: number
  /** Owning subsystem. */
  readonly owner: ErrorOwner
}

/** All stable codes from errors.md, indexed for O(1) lookup. */
export const ERROR_CODES: Record<string, ErrorEntry> = {
  run_not_found:     { code: 'run_not_found',     http: 404, owner: 'api' },
  blob_not_found:    { code: 'blob_not_found',    http: 404, owner: 'api' },
  invalid_request:   { code: 'invalid_request',   http: 400, owner: 'api' },
  key_missing:       { code: 'key_missing',       http: 200, owner: 'orchestrator' },
  session_id_unknown:{ code: 'session_id_unknown',http: 409, owner: 'orchestrator' },
  session_id_occupied:{ code: 'session_id_occupied',http: 409, owner: 'orchestrator' },
  session_cwd_mismatch:{ code: 'session_cwd_mismatch',http: 409, owner: 'orchestrator' },
  dsh_exit_nonzero:  { code: 'dsh_exit_nonzero',  http: 200, owner: 'orchestrator' },
  dsh_timeout:       { code: 'dsh_timeout',       http: 200, owner: 'orchestrator' },
  jsonl_not_found:   { code: 'jsonl_not_found',   http: 200, owner: 'collector' },
  jsonl_corrupt:     { code: 'jsonl_corrupt',     http: 200, owner: 'collector' },
  artifact_copy_missing:{ code: 'artifact_copy_missing',http: 200, owner: 'collector' },
  artifact_unreadable:{ code: 'artifact_unreadable',http: 200, owner: 'collector' },
  changes_unavailable:{ code: 'changes_unavailable',http: 200, owner: 'collector' },
  storage_busy:      { code: 'storage_busy',      http: 503, owner: 'etl' },
  version_mismatch:  { code: 'version_mismatch',  http: 500, owner: 'etl' },
  invalid_record:    { code: 'invalid_record',    http: 500, owner: 'etl' },
  backend_not_found: { code: 'backend_not_found', http: 500, owner: 'etl' },
  assert_digest_mismatch:{ code: 'assert_digest_mismatch',http: 200, owner: 'assertor' },
  assert_baseline_mismatch:{ code: 'assert_baseline_mismatch',http: 200, owner: 'assertor' },
  assert_case_missing:{ code: 'assert_case_missing',http: 200, owner: 'assertor' },
} as const

/** Type narrowing: one of the declared codes. */
export type ErrorCode = keyof typeof ERROR_CODES

/** The error payload persisted on a run row. */
export interface PersistedError {
  readonly code: ErrorCode
  readonly message: string
  readonly operation: string
}

/** Runtime exception thrown or caught by the orchestrator. */
export class OrchestratorError extends Error {
  readonly code: ErrorCode
  readonly operation: string
  readonly http: number
  constructor(code: ErrorCode, operation: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
    this.operation = operation
    const entry = ERROR_CODES[code]
    if (entry === undefined) throw new Error(`unknown error code: ${code}`)
    this.http = entry.http
    this.name = 'OrchestratorError'
  }

  /** Serialize to the on-disk payload. */
  toPersisted(): PersistedError {
    return { code: this.code, message: this.message, operation: this.operation }
  }
}
