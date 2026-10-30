/**
 * Assertor — separate process / separate role read-only verification. The
 * caller is expected to open a *new* storage-domain handle or raw sqlite
 * connection before passing it here; this module never takes a writer.
 *
 * @module @deepseek-ai/dsh-e2e-orchestrator/src/assertor
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { E2EResultsSpec } from './domain-spec.ts'
import { hashStoredBlob } from './blob-store.ts'
import { OrchestratorError } from './errors.ts'
import type { RunId } from './id.ts'
import { caseResultKey } from './etl.ts'

/**
 * Re-hash every copied artifact blob and confirm it matches the row.
 * Throws `assert_digest_mismatch` on the first mismatch.
 */
export function assertBlobDigests(
  domain: Domain<E2EResultsSpec>,
  runId: RunId,
  blobRoot: string,
): void {
  const artifacts = domain.table('artifacts')
  for (const [, row] of artifacts.entries()) {
    const value = row as { runId: string; path: string; digest: string | null; copyStatus: string }
    if (value.runId !== runId) continue
    if (value.copyStatus !== 'copied') continue
    if (!value.digest) continue
    const actual = hashStoredBlob(blobRoot, value.digest)
    if (actual !== value.digest) {
      throw new OrchestratorError(
        'assert_digest_mismatch',
        'assertor.blob',
        `blob digest mismatch for ${value.path}: row=${value.digest}, disk=${actual}`,
      )
    }
  }
}

/**
 * Assert every `expectedCaseId` exists in `case_results` for this run.
 * Throws `assert_case_missing` on the first miss.
 */
export function assertCasePresence(
  domain: Domain<E2EResultsSpec>,
  runId: RunId,
  expectedCaseIds: readonly string[],
): void {
  const cases = domain.table('case_results')
  for (const caseId of expectedCaseIds) {
    const row = cases.get(caseResultKey(runId, caseId))
    if (!row) {
      throw new OrchestratorError(
        'assert_case_missing',
        'assertor.case',
        `expected case ${caseId} not found in run ${runId}`,
      )
    }
  }
}

/**
 * Byte-for-byte baseline comparison. The caller supplies the set of files
 * that the task declares should remain untouched; this function reads the
 * current file and compares it to the baseline bytes.
 * Throws `assert_baseline_mismatch` on the first mismatch.
 */
export function assertBaselines(
  workspace: string,
  baselines: ReadonlyMap<string, Uint8Array>,
): void {
  for (const [relPath, expected] of baselines) {
    const abs = join(workspace, relPath)
    let actual: Uint8Array
    try {
      actual = readFileSync(abs)
    } catch {
      throw new OrchestratorError(
        'assert_baseline_mismatch',
        'assertor.baseline',
        `baseline file missing or unreadable: ${abs}`,
      )
    }
    if (actual.length !== expected.length || !compareUint8(actual, expected)) {
      throw new OrchestratorError(
        'assert_baseline_mismatch',
        'assertor.baseline',
        `baseline mismatch for ${relPath}`,
      )
    }
  }
}

function compareUint8(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
