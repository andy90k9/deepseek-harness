/**
 * Collector — runs AFTER dsh exits while the workspace is still alive.
 * Reads the Session JSONL to find `deliverables/presented` declarations,
 * copies each into the content-addressed blob store, and optionally reads
 * `workspaceChanges.summary` before Session dispose.
 *
 * The collector is a plain function module — no global state, no singleton.
 * @module @deepseek-ai/dsh-e2e-orchestrator/src/collector
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RunId, Digest } from './id.ts'
import type { CopyStatus, ArtifactRecord, ChangeSummaryRecord } from './types.ts'
import { OrchestratorError } from './errors.ts'
import { copyFileToBlob } from './blob-store.ts'

/** One line of Session JSONL. */
interface JsonlEvent {
  type?: string
  data?: unknown
}

/** Parsed deliverables/presented event data shape (from tool-present). */
interface PresentedFileDecl {
  path: string
  description?: string
}

interface PresentedPayload {
  turn: number
  callId?: string
  files: PresentedFileDecl[]
}

/**
 * Load and parse a Session JSONL file into events. Returns lines whose
 * envelope `type` field is present; malformed lines throw `jsonl_corrupt`.
 */
export function parseJsonlEvents(logPath: string): JsonlEvent[] {
  if (!existsSync(logPath)) {
    throw new OrchestratorError('jsonl_not_found', 'collector.parseJsonl', `session log not found: ${logPath}`)
  }
  const raw = readFileSync(logPath, 'utf-8')
  const events: JsonlEvent[] = []
  for (let i = 0; i < raw.length; ) {
    const nl = raw.indexOf('\n', i)
    if (nl === -1) {
      // last line without trailing newline — still valid
      const last = raw.slice(i).trim()
      if (last.length === 0) break
      events.push(parseLine(last, logPath, i))
      break
    }
    const line = raw.slice(i, nl)
    i = nl + 1
    if (line.trim().length === 0) continue
    events.push(parseLine(line, logPath, i))
  }
  return events
}

function parseLine(line: string, path: string, offset: number): JsonlEvent {
  try {
    return JSON.parse(line) as JsonlEvent
  } catch {
    throw new OrchestratorError(
      'jsonl_corrupt',
      'collector.parseJsonl',
      `malformed JSON at offset ${offset} in ${path}`,
    )
  }
}

/**
 * Extract the header session id from the JSONL events. The first event of
 * type `session` (the SessionLogWriter's opening frame) carries `data.id`.
 * Returns null when no session header exists — treat as `jsonl_corrupt`.
 */
export function extractSessionId(events: JsonlEvent[]): string | null {
  for (const ev of events) {
    if (ev.type === 'session' && ev.data && typeof ev.data === 'object') {
      const data = ev.data as Record<string, unknown>
      if (typeof data.id === 'string') return data.id
    }
  }
  return null
}

/** Collect every `deliverables/presented` payload from the events. */
export function extractPresentedDecls(events: JsonlEvent[]): PresentedPayload[] {
  const out: PresentedPayload[] = []
  for (const ev of events) {
    if (ev.type === 'deliverables/presented' && ev.data && typeof ev.data === 'object') {
      out.push(ev.data as PresentedPayload)
    }
  }
  return out
}

/**
 * Walk the presented declarations, copy each file into the blob store, and
 * produce ArtifactRecords. Missing or non-regular files are marked with
 * their copy status; the run's caller is responsible for deciding whether
 * missing artifacts should fail the run.
 */
export function collectArtifacts(
  runId: RunId,
  presented: PresentedPayload[],
  blobRoot: string,
): ArtifactRecord[] {
  const seen = new Set<string>()
  const records: ArtifactRecord[] = []

  for (const payload of presented) {
    for (const file of payload.files) {
      if (seen.has(file.path)) continue
      seen.add(file.path)

      const absPath = file.path
      let copyStatus: CopyStatus
      let digest: Digest | null = null
      let blobUri: string | null = null

      if (!existsSync(absPath)) {
        copyStatus = 'missing'
      } else {
        try {
          const st = statSync(absPath)
          if (!st.isFile()) {
            copyStatus = 'unreadable'
          } else {
            const blob = copyFileToBlob(absPath, blobRoot)
            digest = blob.digest
            blobUri = blob.blobUri
            copyStatus = 'copied'
          }
        } catch {
          copyStatus = 'unreadable'
        }
      }

      records.push({
        path: absPath,
        digest,
        blobUri,
        description: file.description ?? null,
        copyStatus,
      })
    }
  }

  return records
}

/**
 * Extract the last `turn/end.reason.kind` from events. Falls back to null
 * when no `turn/end` event is present — caller treats as `failed`.
 */
export function extractTurnEndKind(events: JsonlEvent[]): string | null {
  let last: string | null = null
  for (const ev of events) {
    if (ev.type !== 'turn/end' || !ev.data || typeof ev.data !== 'object') continue
    const data = ev.data as Record<string, unknown>
    const reason = data.reason
    if (reason && typeof reason === 'object') {
      const kind = (reason as Record<string, unknown>).kind
      if (typeof kind === 'string') last = kind
    }
  }
  return last
}

/**
 * Collapse duplicate paths into the workspace root. Used to make
 * blob-relative tests independent of the host's cwd.
 */
export function normalizePath(p: string, workspace: string): string {
  if (p.startsWith(workspace + '/')) return p.slice(workspace.length + 1)
  return p
}
