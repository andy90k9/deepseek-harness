/**
 * ETL — upsert run records, artifacts, case results, and change summaries
 * into the M1 `e2e_results` storage-domain. Single writer: all writes queue
 * on the domain's chain; callers await `put()` durably before treating
 * the run as persisted.
 *
 * This module owns the schema-keying functions (composite key strings for
 * artifacts / case_results / change_summaries) and is the single place that
 * knows the storage-domain layout.
 * @module @deepseek-ai/dsh-e2e-orchestrator/src/etl
 */

import { createHash } from 'node:crypto'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { E2EResultsSpec } from './domain-spec.ts'
import type { RunId, TaskId } from './id.ts'
import type {
  RunRecord, ArtifactRecord, CaseRecord, ChangeSummaryRecord,
  RunStatus, DshProfile,
} from './types.ts'
import type { PersistedError } from './errors.ts'

/** Composite key separator — must not appear in paths or case ids. */
const SEP = '\u0000'

export function artifactKey(runId: string, path: string): string {
  return `${runId}${SEP}${path}`
}
export function caseResultKey(runId: string, caseId: string): string {
  return `${runId}${SEP}${caseId}`
}
export function changeSummaryKey(runId: string, seq: number): string {
  return `${runId}${SEP}${seq}`
}

// ---- Upsert helpers -------------------------------------------------------

/** Upsert one run row by its run_id key. */
export async function upsertRun(
  domain: Domain<E2EResultsSpec>,
  record: RunRecord,
): Promise<void> {
  const runs = domain.table('runs')
  await runs.put(record.runId, record as unknown as Record<string, unknown>)
}

/** Upsert one artifact row by composite (run_id, path) key. */
export async function upsertArtifact(
  domain: Domain<E2EResultsSpec>,
  runId: RunId,
  record: ArtifactRecord,
): Promise<void> {
  const artifacts = domain.table('artifacts')
  const key = artifactKey(runId, record.path)
  const value = {
    runId,
    path: record.path,
    digest: record.digest ?? null,
    blobUri: record.blobUri ?? null,
    description: record.description ?? null,
    copyStatus: record.copyStatus,
  }
  await artifacts.put(key, value as unknown as Record<string, unknown>)
}

/** Upsert one case result by composite (run_id, case_id) key. */
export async function upsertCaseResult(
  domain: Domain<E2EResultsSpec>,
  runId: RunId,
  record: CaseRecord,
): Promise<void> {
  const cases = domain.table('case_results')
  const key = caseResultKey(runId, record.caseId)
  const value = {
    runId,
    caseId: record.caseId,
    outcome: record.outcome,
    detail: record.detail,
  }
  await cases.put(key, value as unknown as Record<string, unknown>)
}

/** Upsert one change summary by composite (run_id, seq) key. */
export async function upsertChangeSummary(
  domain: Domain<E2EResultsSpec>,
  runId: RunId,
  record: ChangeSummaryRecord,
): Promise<void> {
  const summaries = domain.table('change_summaries')
  const key = changeSummaryKey(runId, record.seq)
  const value = {
    runId,
    seq: record.seq,
    turn: record.turn,
    source: record.source,
    summary: record.summary,
  }
  await summaries.put(key, value as unknown as Record<string, unknown>)
}

// ---- Run helpers -----------------------------------------------------------

/** Construct a fresh RunRecord in the `queued` status. */
export function newRunRecord(
  runId: RunId,
  taskId: TaskId,
  profile: DshProfile,
  sessionId: string | null,
): RunRecord {
  return {
    runId,
    sessionId: sessionId as RunRecord['sessionId'],
    taskId,
    profile,
    status: 'queued' as RunStatus,
    dshExitCode: null,
    turnEndKind: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logUri: null,
    error: null,
  }
}

/** Copy existing record with a new status, preserving other fields. */
export function withStatus(r: RunRecord, status: RunStatus): RunRecord {
  return { ...r, status }
}

/** Copy existing record with exit code + turn end kind filled in. */
export function withExitInfo(r: RunRecord, exitCode: number, turnEndKind: string | null): RunRecord {
  return { ...r, dshExitCode: exitCode, turnEndKind, finishedAt: new Date().toISOString() }
}

/** Copy existing record with a persisted error payload. */
export function withError(r: RunRecord, err: PersistedError): RunRecord {
  return { ...r, error: err }
}

// ---- Redaction ------------------------------------------------------------

/**
 * Compute a sha256 digest of a task prompt and return a ≤200 character
 * summary. Used in Postgres `task_hash` / `task_summary` fields; M1 sqlite
 * stores only these, never the raw prompt body.
 */
export function redactTaskPrompt(prompt: string): { hash: string; summary: string } {
  const h = createHash('sha256').update(prompt.trim() || '\n').digest('hex')
  const summary = prompt.trim().slice(0, 200).replace(/\s+/g, ' ')
  return { hash: h, summary }
}
