/**
 * Content-addressed blob store — sha256 digests, two-level hex dir layout,
 * fsync-then-rename durability per write. The store is process-local and
 * owns no global singleton: callers construct and own the instance.
 * @module @deepseek-ai/dsh-e2e-orchestrator/src/blob-store
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, closeSync, statSync, renameSync, writeSync, fsyncSync, unlinkSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { blobUriOf, validateDigest, type Digest } from './id.ts'

/** Two-level dir layout: `<root>/sha256/<digest[0:2]>/<digest>`. */
function objectPath(root: string, digest: string): string {
  return join(root, 'sha256', digest.slice(0, 2), digest)
}

/**
 * Copy a file into the blob store by digest.
 * - Opens the source, streams bytes, hashes to sha256.
 * - Writes to a sibling temp file, fsyncs, renames to the final path.
 * - If the object already exists, deletes the temp and returns early.
 * @returns the digest (lowercase hex) and blob URI.
 */
export function copyFileToBlob(sourcePath: string, blobRoot: string): { digest: Digest; blobUri: string } {
  const stat = statSync(sourcePath)
  if (!stat.isFile()) {
    throw new Error(`source is not a regular file: ${sourcePath}`)
  }

  const hash = createHash('sha256')
  let fileFd = -1
  try {
    fileFd = openSync(sourcePath, 'r')
    const buf = Buffer.alloc(65536)
    let bytes: number
    while ((bytes = readSync(fileFd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytes))
    }
  } finally {
    if (fileFd >= 0) closeSync(fileFd)
  }

  const digest = hash.digest('hex')
  const destDir = join(blobRoot, 'sha256', digest.slice(0, 2))
  const destPath = join(destDir, digest)

  if (existsSync(destPath)) {
    if (!validateDigest(digest)) throw new Error(`computed digest fails grammar check: ${digest}`)
    return { digest: digest as Digest, blobUri: blobUriOf(digest) }
  }

  mkdirSync(destDir, { recursive: true })
  const tempPath = `${destPath}.${process.pid}.${Date.now()}.tmp`

  let srcFd = -1
  let dstFd = -1
  try {
    srcFd = openSync(sourcePath, 'r')
    dstFd = openSync(tempPath, 'w')
    const buf = Buffer.alloc(65536)
    let bytes: number
    while ((bytes = readSync(srcFd, buf, 0, buf.length, null)) > 0) {
      writeSync(dstFd, buf, 0, bytes)
    }
    fsyncSync(dstFd)
  } finally {
    if (srcFd >= 0) closeSync(srcFd)
    if (dstFd >= 0) closeSync(dstFd)
  }

  if (existsSync(destPath)) {
    // raced with another writer — just drop our copy
    unlinkSync(tempPath)
  } else {
    renameSync(tempPath, destPath)
  }

  if (!validateDigest(digest)) throw new Error(`computed digest fails grammar check: ${digest}`)
  return { digest: digest as Digest, blobUri: blobUriOf(digest) }
}

/**
 * Recompute the sha256 of a stored blob object. Used by the assertor to
 * independently verify the blob matches the row's digest.
 */
export function hashStoredBlob(blobRoot: string, digest: string): string {
  const path = objectPath(blobRoot, digest)
  if (!existsSync(path)) {
    throw new Error(`blob not found on disk: ${path}`)
  }
  const hash = createHash('sha256')
  let fd = -1
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(65536)
    let bytes: number
    while ((bytes = readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytes))
    }
  } finally {
    if (fd >= 0) closeSync(fd)
  }
  return hash.digest('hex')
}
