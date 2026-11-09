#!/usr/bin/env node
/**
 * dsh-auth-cookie-guard — one-shot rescue for the "app no longer starts" case.
 *
 * The running plugin can only prune cookies through a browser response, which
 * needs a page that loaded. When the Cookie header is already over the parser
 * limit, no page loads at all: the fix is to prune the profile's cookie
 * database while the Desktop app is closed.
 *
 * What this script does, in order:
 *   1. Refuses to run while the app still holds the database open.
 *   2. Counts `dsh-auth-*` rows for the loopback hosts.
 *   3. Copies the database to a timestamped backup next to it.
 *   4. Deletes only those rows — no other cookie, no other table, no other file.
 *
 * Usage:
 *   node scripts/purge-auth-cookies.mjs [--db <path>] [--dry-run]
 *
 * The script touches nothing under `$DSH_HOME`, no credential store, and no
 * network endpoint.
 *
 * @module scripts/purge-auth-cookies.mjs
 */

import { copyFileSync, existsSync, openSync, closeSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

/** Host keys Chromium stores loopback cookies under. */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost'])

/** `LIKE` pattern for the generated browser-session cookie names. */
export const AUTH_COOKIE_LIKE = 'dsh-auth-%'

/**
 * Default location of the Desktop profile's cookie database.
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @param {NodeJS.Platform} [platform] - platform to build the path for.
 * @returns {string} absolute path to the `Cookies` database.
 */
export function defaultCookiesPath(env = process.env, platform = process.platform) {
  const appData = env.APPDATA
  if (platform === 'win32' && typeof appData === 'string' && appData.length > 0) {
    return path.join(appData, '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
  }
  return path.join(os.homedir(), '.config', '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
}

/**
 * Fail with an actionable message while Chromium still holds the file.
 * @param {string} dbPath - cookie database path.
 * @returns {void}
 */
export function assertUnlocked(dbPath) {
  let handle
  try {
    handle = openSync(dbPath, 'r+')
  } catch (error) {
    const code = error?.code ?? ''
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      throw new Error(
        '数据库仍被占用：请先完全退出 DSH 桌面版（托盘图标退出，并确认任务管理器里没有残留进程）再运行。',
      )
    }
    throw error
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}

/**
 * Count generated auth cookies for the loopback hosts.
 * @param {string} dbPath - cookie database path.
 * @returns {number} matching row count.
 */
export function countAuthCookies(dbPath) {
  const db = new DatabaseSync(dbPath)
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM cookies
          WHERE host_key IN (?, ?) AND name LIKE ?`,
      )
      .get(...LOOPBACK_HOSTS, AUTH_COOKIE_LIKE)
    return Number(row?.n ?? 0)
  } finally {
    db.close()
  }
}

/**
 * Delete generated auth cookies for the loopback hosts.
 * @param {string} dbPath - cookie database path.
 * @returns {number} number of deleted rows.
 */
export function deleteAuthCookies(dbPath) {
  const db = new DatabaseSync(dbPath)
  try {
    const statement = db.prepare(
      `DELETE FROM cookies
        WHERE host_key IN (?, ?) AND name LIKE ?`,
    )
    const result = statement.run(...LOOPBACK_HOSTS, AUTH_COOKIE_LIKE)
    return Number(result?.changes ?? 0)
  } finally {
    db.close()
  }
}

/**
 * Copy the database next to itself with a timestamp suffix.
 * @param {string} dbPath - cookie database path.
 * @param {() => Date} [now] - clock, injectable for tests.
 * @returns {string} backup path.
 */
export function backupCookies(dbPath, now = () => new Date()) {
  const stamp = now().toISOString().replace(/[:.]/gu, '-')
  const backupPath = `${dbPath}.dsh-cookie-guard-${stamp}.bak`
  copyFileSync(dbPath, backupPath)
  return backupPath
}

/**
 * Parse CLI arguments.
 * @param {readonly string[]} argv - process arguments after the script path.
 * @returns {{ dbPath?: string, dryRun: boolean, help: boolean }} parsed options.
 */
export function parseArgs(argv) {
  const options = { dryRun: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--db') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('--db 需要一个路径参数')
      options.dbPath = value
      index += 1
    } else if (arg.startsWith('--db=')) {
      options.dbPath = arg.slice('--db='.length)
    } else {
      throw new Error(`无法识别的参数：${arg}`)
    }
  }
  return options
}

/**
 * Print usage.
 * @returns {void}
 */
export function printHelp() {
  console.log(
    [
      'dsh-auth-cookie-guard 救援脚本',
      '',
      '用法：node scripts/purge-auth-cookies.mjs [--db <Cookies 路径>] [--dry-run]',
      '',
      '  默认路径：%APPDATA%\\@deepseek-ai\\dsh-desktop\\Network\\Cookies',
      '  只删除 127.0.0.1 / localhost 上名为 dsh-auth-* 的 Cookie，删除前会备份数据库。',
      '  运行前必须完全退出 DSH 桌面版。',
    ].join('\n'),
  )
}

/**
 * Run the rescue once.
 * @param {{ dbPath?: string, dryRun: boolean }} options - parsed options.
 * @param {{ log?: (line: string) => void, now?: () => Date }} [io] - output hooks.
 * @returns {Promise<{ dbPath: string, before: number, deleted: number, backupPath: string | null }>} result.
 */
export async function run(options, io = {}) {
  const log = io.log ?? ((line) => console.log(line))
  const dbPath = options.dbPath === undefined ? defaultCookiesPath() : path.resolve(options.dbPath)

  if (!existsSync(dbPath)) throw new Error(`没有找到 Cookie 数据库：${dbPath}`)
  assertUnlocked(dbPath)

  const before = countAuthCookies(dbPath)
  log(`数据库：${dbPath}`)
  log(`dsh-auth-* Cookie：${String(before)} 枚`)

  if (before === 0) {
    log('无需清理。')
    return { dbPath, before, deleted: 0, backupPath: null }
  }
  if (options.dryRun) {
    log('试运行：未做任何修改。去掉 --dry-run 才会真正删除。')
    return { dbPath, before, deleted: 0, backupPath: null }
  }

  const backupPath = backupCookies(dbPath, io.now)
  const deleted = deleteAuthCookies(dbPath)
  const after = countAuthCookies(dbPath)
  log(`已备份到：${backupPath}`)
  log(`已删除：${String(deleted)} 枚；剩余 dsh-auth-* Cookie：${String(after)} 枚。`)
  log('现在可以重新启动 DSH 桌面版；下一次启动会重新签发一枚新的认证 Cookie。')
  return { dbPath, before, deleted, backupPath }
}

/**
 * Entry point.
 * @returns {Promise<void>} completion.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  await run(options)
}

const entry = process.argv[1]
const invokedDirectly = entry !== undefined && pathToFileURL(path.resolve(entry)).href === import.meta.url
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
