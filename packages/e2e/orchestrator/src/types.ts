/**
 * Public types. Kept separate from runtime code so consumers can import
 * `. /types` without paying for side-effectful module init.
 * @module @deepseek-ai/dsh-e2e-orchestrator/src/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PersistedError } from './errors.ts'
import type { RunId, TaskId, Digest } from './id.ts'

/** Branded SessionId from dsh-brand; re-exported for convenience. */
export type SessionId = Branded<'SessionId'>

/** Run lifecycle status machine. */
export type RunStatus =
  | 'queued' | 'running' | 'collecting' | 'upserting'
  | 'passed' | 'failed' | 'aborted' | 'skipped'

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'passed', 'failed', 'aborted', 'skipped',
])

/** Is this status terminal? No further transitions expected. */
export function isTerminalStatus(s: RunStatus): boolean {
  return TERMINAL_STATUSES.has(s)
}

/** dsh invocation profile. */
export type DshProfile = 'headless' | 'sdk'

/** Copy outcome for one presented artifact path. */
export type CopyStatus = 'copied' | 'missing' | 'unreadable'

/** Outcome parsed from a test runner report. */
export type CaseOutcome = 'passed' | 'failed' | 'skipped'

/** Source of a workspace/changes summary row. */
export type ChangeSource = 'host' | 'git_fallback' | 'unavailable'

/** Input to start a run. */
export interface StartRunRequest {
  /** Stable task key in the versioned prompt library. */
  taskId: string
  /** Override prompt; omitted = load from prompt library by task_id. */
  prompt?: string
  /** Absolute path; must exist and be a directory. */
  workspace: string
  /** dsh profile — default `headless`. */
  profile?: DshProfile
  /** Known session id for continuation; unknown → abort before exec. */
  sessionId?: string
  /** Positive ms; default 1_800_000 (30 min). */
  timeoutMs?: number
}

/** Run record as read from storage or the orchestrator. */
export interface RunRecord {
  runId: RunId
  sessionId: SessionId | null
  taskId: TaskId
  profile: DshProfile
  status: RunStatus
  dshExitCode: number | null
  turnEndKind: string | null
  startedAt: string
  finishedAt: string | null
  logUri: string | null
  error: PersistedError | null
}

/** Artifact record — one presented file from the run. */
export interface ArtifactRecord {
  /** Copy-time absolute path of the presented file. */
  path: string
  /** sha256 hex — null unless copyStatus = 'copied'. */
  digest: Digest | null
  /** blob://sha256/<digest> — null unless copyStatus = 'copied'. */
  blobUri: string | null
  /** Optional description string from the present event. */
  description: string | null
  /** Copy outcome. */
  copyStatus: CopyStatus
}

/** One test-runner case row parsed into the run. */
export interface CaseRecord {
  /** Case id (report-specific). */
  caseId: string
  outcome: CaseOutcome
  /** Runner-specific detail (duration, line, etc.). */
  detail: Record<string, unknown> | null
}

/** One workspace/changes summary row for a run. */
export interface ChangeSummaryRecord {
  /** Run-local sequence number (per `workspace/changes` event). */
  seq: number
  /** Turn number that emitted this summary. */
  turn: number
  source: ChangeSource
  /** Host-provided summary object or git diff fallback. */
  summary: unknown
}

/** Options for the orchestrator itself, not per-run. */
export interface OrchestratorOptions {
  /** Path to the storage-sqlite database (M1 single file). */
  dbPath: string
  /** Root of the content-addressed blob directory. */
  blobRoot: string
  /** dsh binary path; default = resolved from `pnpm dsh`. */
  dshBin?: string
}
