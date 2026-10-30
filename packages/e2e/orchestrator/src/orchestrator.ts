/**
 * Orchestrator core — the single entry point that run_id-allocates, execs
 * `dsh --profile headless --json`, parses the exit code and `--json` event
 * stream, delegates to Collector → ETL, and finally hands the run to the
 * Assertor. The orchestrator is process-local: each startRun spawns one
 * child `dsh` process, waits for it, and only then writes to storage.
 *
 * @module @deepseek-ai/dsh-e2e-orchestrator/src/orchestrator
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { newRunId, validateRunId, validateTaskId, type RunId, type TaskId } from './id.ts'
import type {
  StartRunRequest, RunRecord, RunStatus, OrchestratorOptions, ArtifactRecord,
} from './types.ts'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { E2EResultsSpec } from './domain-spec.ts'
import { OrchestratorError, type PersistedError } from './errors.ts'
import {
  newRunRecord, upsertRun, upsertArtifact, withStatus, withExitInfo, withError,
} from './etl.ts'
import {
  parseJsonlEvents, extractSessionId, extractTurnEndKind,
  extractPresentedDecls, collectArtifacts,
} from './collector.ts'

/** Headless `--json` event envelope we consume from stdout. */
interface HeadlessJsonEvent {
  type: string
  session_id?: string
  data?: unknown
  error?: unknown
}

/** Exit-code → initial run.status mapping (before assertion). */
function mapKindToInitialStatus(
  exitCode: number,
  kind: string | null,
): RunStatus {
  if (exitCode === 0 && kind === 'completed') return 'collecting'
  if (exitCode === 0) return 'failed' // completed but no confirmed turn_end
  if (kind === 'aborted' || kind === 'forked') return 'aborted'
  if (kind === 'error' || kind === 'blocked' || kind === 'max-tokens' || kind === 'interrupted') {
    return 'failed'
  }
  return 'failed'
}

export class Orchestrator {
  private readonly options: OrchestratorOptions
  private readonly domain: Domain<E2EResultsSpec>
  private readonly dshBin: string

  /**
   * @param domain - opened M1 storage-domain handle; callers own its lifecycle.
   * @param options - orchestrator-level options.
   */
  constructor(
    domain: Domain<E2EResultsSpec>,
    options: OrchestratorOptions,
  ) {
    this.domain = domain
    this.options = options
    this.dshBin = options.dshBin ?? 'dsh'
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Validate request fields, allocate run_id, spawn dsh, collect and persist.
   * Blocks until terminal status. The returned RunRecord is the final stored
   * row from storage.
   */
  async start(request: StartRunRequest): Promise<RunRecord> {
    this.validateRequest(request)

    const runId = newRunId()

    // Self-skip when no API key is configured
    if (!process.env.DEEPSEEK_API_KEY) {
      const rec = newRunRecord(runId, request.taskId as TaskId, request.profile ?? 'headless', request.sessionId ?? null)
      const skipped: RunRecord = withStatus(rec, 'skipped')
      skipped.finishedAt = new Date().toISOString()
      const err: PersistedError = {
        code: 'key_missing',
        message: 'DEEPSEEK_API_KEY unset — real-run layer self-skip',
        operation: 'orchestrator.start',
      }
      Object.assign(skipped, { error: err })
      await upsertRun(this.domain, skipped)
      return skipped
    }

    // Write queued run row
    const rec0 = newRunRecord(runId, request.taskId as TaskId, request.profile ?? 'headless', request.sessionId ?? null)
    await upsertRun(this.domain, rec0)

    // Exec dsh headless
    let exitCode: number | null = null
    let sessionId: string | null = null
    let stderr = ''
    let timedOut = false
    const timeoutMs = request.timeoutMs ?? 1_800_000
    const workspace = resolve(request.workspace)

    try {
      const result = await this.runDshHeadless({
        prompt: request.prompt,
        workspace,
        profile: request.profile ?? 'headless',
        sessionId: request.sessionId ?? null,
        timeoutMs,
      })
      exitCode = result.exitCode
      sessionId = result.sessionId
      stderr = result.stderr
      timedOut = result.timedOut
    } catch (error) {
      const failed = withError(withStatus(rec0, 'aborted'), {
        code: 'dsh_exit_nonzero',
        message: `dsh exec failed: ${String(error)}`,
        operation: 'orchestrator.runDshHeadless',
      })
      await upsertRun(this.domain, failed)
      return failed
    }

    // Mark running
    const runningRecord = withStatus(rec0, 'running')
    runningRecord.sessionId = sessionId as RunRecord['sessionId']
    await upsertRun(this.domain, runningRecord)

    // Timeout
    if (timedOut) {
      const aborted = withExitInfo(runningRecord, exitCode ?? 1, null)
      const ab = withError(withStatus(aborted, 'aborted'), {
        code: 'dsh_timeout',
        message: `dsh timed out after ${timeoutMs}ms`,
        operation: 'orchestrator.runDshHeadless',
      })
      await upsertRun(this.domain, ab)
      return ab
    }

    // Unknown session id
    if (exitCode === 1 && /unknown.*session/i.test(stderr)) {
      const aborted = withExitInfo(runningRecord, 1, null)
      const ab = withError(withStatus(aborted, 'aborted'), {
        code: 'session_id_unknown',
        message: `dsh reports unknown session_id: ${request.sessionId}`,
        operation: 'orchestrator.runDshHeadless',
      })
      await upsertRun(this.domain, ab)
      return ab
    }

    // Locate and parse JSONL
    let jsonlPath: string
    let events: import('./collector.ts').JsonlEvent[]
    let turnEndKind: string | null = null
    try {
      jsonlPath = this.locateJsonl(sessionId, workspace)
      events = parseJsonlEvents(jsonlPath)
      turnEndKind = extractTurnEndKind(events)
    } catch (err) {
      const failed = withExitInfo(runningRecord, exitCode ?? 1, null)
      const code = err instanceof OrchestratorError ? err.code : 'jsonl_corrupt'
      const ab = withError(withStatus(failed, 'failed'), {
        code,
        message: String(err),
        operation: 'collector.parseJsonl',
      })
      await upsertRun(this.domain, ab)
      return ab
    }

    // Collect artifacts while workspace is still alive
    const initialStatus = mapKindToInitialStatus(exitCode ?? 1, turnEndKind)
    const collectingRec = withExitInfo(runningRecord, exitCode ?? 1, turnEndKind)
    collectingRec.status = initialStatus
    collectingRec.logUri = jsonlPath
    await upsertRun(this.domain, collectingRec)

    const presented = extractPresentedDecls(events)
    const artifacts: ArtifactRecord[] = collectArtifacts(runId, presented, this.options.blobRoot)
    for (const art of artifacts) {
      await upsertArtifact(this.domain, runId, art)
    }

    // Upserting phase
    const upsertingRec: RunRecord = { ...collectingRec, status: 'upserting' }
    await upsertRun(this.domain, upsertingRec)

    // Determine final status
    let finalStatus: RunStatus
    let persistedError: PersistedError | null = null

    const missingArtifacts = artifacts.some(a => a.copyStatus === 'missing' || a.copyStatus === 'unreadable')
    if (missingArtifacts) {
      finalStatus = 'failed'
      persistedError = {
        code: 'artifact_copy_missing',
        message: `some presented paths were missing or unreadable at collect time; see artifact rows`,
        operation: 'collector.collectArtifacts',
      }
    } else if (exitCode === 0 && turnEndKind === 'completed') {
      finalStatus = 'passed'
    } else if (exitCode === 0) {
      finalStatus = 'failed'
      persistedError = {
        code: 'dsh_exit_nonzero',
        message: `dsh exit 0 but turn_end_kind=${turnEndKind}`,
        operation: 'orchestrator.runDshHeadless',
      }
    } else {
      finalStatus = 'failed'
      persistedError = {
        code: 'dsh_exit_nonzero',
        message: `dsh exit ${exitCode}, turn_end_kind=${turnEndKind}`,
        operation: 'orchestrator.runDshHeadless',
      }
    }

    let finalRec: RunRecord = { ...upsertingRec, status: finalStatus }
    if (persistedError) finalRec = withError(finalRec, persistedError)
    await upsertRun(this.domain, finalRec)

    return finalRec
  }

  /** Read a stored run by id; null when absent. */
  get(runId: RunId): RunRecord | null {
    return this.domain.table('runs').get(runId as string) as RunRecord | undefined ?? null
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private validateRequest(req: StartRunRequest): void {
    if (!req.taskId || !validateTaskId(req.taskId)) {
      throw new OrchestratorError('invalid_request', 'orchestrator.validate', 'task_id must match [a-z][a-z0-9_]{1,63}')
    }
    if (req.prompt !== undefined && req.prompt.trim() === '') {
      throw new OrchestratorError('invalid_request', 'orchestrator.validate', 'prompt must be non-empty when provided')
    }
    if (!req.workspace || !existsSync(req.workspace)) {
      throw new OrchestratorError('invalid_request', 'orchestrator.validate', 'workspace must point to an existing directory')
    }
    if (req.sessionId !== undefined && req.sessionId !== null && !req.sessionId) {
      throw new OrchestratorError('invalid_request', 'orchestrator.validate', 'session_id must be non-empty string when provided')
    }
    if (req.timeoutMs !== undefined && (req.timeoutMs <= 0 || !Number.isFinite(req.timeoutMs))) {
      throw new OrchestratorError('invalid_request', 'orchestrator.validate', 'timeout_ms must be positive finite integer')
    }
    if (req.profile && req.profile !== 'headless' && req.profile !== 'sdk') {
      throw new OrchestratorError('invalid_request', 'orchestrator.validate', 'profile must be headless or sdk')
    }
    if (validateRunId(req.taskId)) {
      throw new OrchestratorError('invalid_request', 'orchestrator.validate', 'task_id must not look like run_id')
    }
  }

  /**
   * Spawn `dsh --profile headless --json [--session-id]` and wait.
   * Returns exit code + parsed session_id from first JSON envelope + stderr.
   */
  private runDshHeadless(args: {
    prompt?: string
    workspace: string
    profile: 'headless' | 'sdk'
    sessionId: string | null
    timeoutMs: number
  }): Promise<{ exitCode: number; sessionId: string | null; stderr: string; timedOut: boolean }> {
    const { prompt, workspace, profile, sessionId, timeoutMs } = args
    return new Promise((resolve, reject) => {
      const cmdArgs = ['--profile', profile, '--json']
      if (sessionId) cmdArgs.push('--session-id', sessionId)
      cmdArgs.push('-')

      let proc
      try {
        proc = spawn(this.dshBin, cmdArgs, {
          cwd: workspace,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (err) {
        reject(err)
        return
      }

      let sessionIdOut: string | null = null
      let stderr = ''
      let timedOut = false

      proc.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8')
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          try {
            const ev = JSON.parse(line) as HeadlessJsonEvent
            if (ev.type === 'session' && ev.data && typeof ev.data === 'object') {
              const data = ev.data as Record<string, unknown>
              if (typeof data.id === 'string') sessionIdOut = data.id
            }
            if (ev.type === 'session_id' && typeof ev.session_id === 'string') {
              sessionIdOut = ev.session_id
            }
          } catch {
            // ignore non-JSON lines
          }
        }
      })

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })

      let timer: NodeJS.Timeout | null = null
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true
          proc.kill('SIGKILL')
        }, timeoutMs)
      }

      proc.on('error', reject)
      proc.on('close', (code) => {
        if (timer) clearTimeout(timer)
        const exitCode = code ?? 0
        resolve({ exitCode, sessionId: sessionIdOut, stderr, timedOut })
      })

      const body = (prompt ?? `run e2e task ${args.workspace}`)
      proc.stdin.write(body)
      proc.stdin.end()
    })
  }

  /**
   * Walk up from workspace to find .dsh/sessions root. Uses the same
   * encodeSegment-style escaping as session-persistence-jsonl.
   */
  private locateJsonl(sessionId: string | null, workspace: string): string {
    if (!sessionId) {
      throw new OrchestratorError(
        'jsonl_not_found',
        'orchestrator.locateJsonl',
        'no session_id returned from dsh headless — cannot locate JSONL',
      )
    }

    const encoded = sessionId.replace(/\//g, '_').replace(/\.\./g, '_')

    let dir = workspace
    for (let i = 0; i < 8; i++) {
      const p1 = join(dir, '.dsh', 'sessions', encoded, 'session.v4.jsonl')
      if (existsSync(p1)) return p1
      const p2 = join(dir, '.dsh', 'sessions', 'session.v4.jsonl')
      if (existsSync(p2)) return p2
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }

    throw new OrchestratorError(
      'jsonl_not_found',
      'orchestrator.locateJsonl',
      `cannot locate session.v4.jsonl for ${sessionId} — searched up from ${workspace}`,
    )
  }
}
