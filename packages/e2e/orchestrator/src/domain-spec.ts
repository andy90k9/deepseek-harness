/**
 * e2e_results domain spec — one domain, four tables, all zod-validated on
 * write. This spec is the single source of truth for the physical record
 * shape on M1 sqlite; M2 Postgres DDL is parallel and lives in the spec
 * directory.
 * @module @deepseek-ai/dsh-e2e-orchestrator/src/domain-spec
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'

const runErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  operation: z.string(),
})

export const runRecordSchema = z.object({
  sessionId: z.string().nullable(),
  taskId: z.string(),
  profile: z.enum(['headless', 'sdk']),
  status: z.enum([
    'queued', 'running', 'collecting', 'upserting',
    'passed', 'failed', 'aborted', 'skipped',
  ]),
  dshExitCode: z.number().int().nullable(),
  turnEndKind: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  logUri: z.string().nullable(),
  error: runErrorSchema.nullable(),
})

export const artifactSchema = z.object({
  runId: z.string(),
  path: z.string(),
  digest: z.string().nullable(),
  blobUri: z.string().nullable(),
  description: z.string().nullable(),
  copyStatus: z.enum(['copied', 'missing', 'unreadable']),
})

export const caseResultSchema = z.object({
  runId: z.string(),
  caseId: z.string(),
  outcome: z.enum(['passed', 'failed', 'skipped']),
  detail: z.record(z.string(), z.unknown()).nullable(),
})

export const changeSummarySchema = z.object({
  runId: z.string(),
  seq: z.number().int(),
  turn: z.number().int(),
  source: z.enum(['host', 'git_fallback', 'unavailable']),
  summary: z.unknown().nullable(),
})

/**
 * M1 sqlite domain: `e2e_results`, version 1. Physical tables are
 * `u_e2e_results_runs / artifacts / case_results / change_summaries`.
 * Key rules (see api.md §2):
 *   runs             = runId
 *   artifacts        = `${runId}\n${path}`
 *   case_results     = `${runId}\n${caseId}`
 *   change_summaries = `${runId}\n${seq}`
 */
export const e2eResultsSpec = defineDomain({
  name: 'e2e_results',
  version: 1,
  tables: {
    runs: domainTable(runRecordSchema),
    artifacts: domainTable(artifactSchema),
    case_results: domainTable(caseResultSchema),
    change_summaries: domainTable(changeSummarySchema),
  },
})

export type E2EResultsSpec = typeof e2eResultsSpec
