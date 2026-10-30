/**
 * Identifier grammar: run_id, task_id, digest, blob_uri. Every field that
 * crosses a process boundary lives here; other modules import the grammar
 * from this file instead of re-declaring literals.
 * @module @deepseek-ai/dsh-e2e-orchestrator/src/id
 */

import { randomUUID } from 'node:crypto'

/** run_ prefix + UUID v4 canonical (with hyphens). */
export const RUN_ID_RE = /^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** task_id: [a-z][a-z0-9_]{1,63}. */
export const TASK_ID_RE = /^[a-z][a-z0-9_]{1,63}$/

/** Lowercase hex sha256, 64 chars. */
export const DIGEST_RE = /^[0-9a-f]{64}$/

export type RunId = string & { readonly __runId?: unique symbol }
export type TaskId = string & { readonly __taskId?: unique symbol }
export type Digest = string & { readonly __digest?: unique symbol }

/** Generate a fresh run_id. Called BEFORE dsh exec (run_id ≠ session_id). */
export function newRunId(): RunId {
  return `run_${randomUUID()}` as RunId
}

/** Validate and return the run_id; throws OrchestratorError-style string on mismatch. */
export function validateRunId(id: string): id is RunId {
  return RUN_ID_RE.test(id)
}

export function validateTaskId(id: string): id is TaskId {
  return TASK_ID_RE.test(id)
}

export function validateDigest(d: string): d is Digest {
  return DIGEST_RE.test(d)
}

/** Blob URI form: `blob://sha256/<digest>`. */
export function blobUriOf(digest: string): string {
  return `blob://sha256/${digest}`
}

/** Parse a blob URI back to digest. */
export function digestFromBlobUri(uri: string): string | null {
  const m = uri.match(/^blob:\/\/sha256\/([0-9a-f]{64})$/)
  return m ? m[1]! : null
}
