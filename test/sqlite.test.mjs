import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  assertUnlocked,
  backupCookies,
  countAuthCookies,
  defaultCookiesPath,
  deleteAuthCookies,
  parseArgs,
  run,
} from '../scripts/purge-auth-cookies.mjs'
import { cookieNameForAuthority } from '../core.mjs'

const AUTH_A = cookieNameForAuthority('127.0.0.1:5173')
const AUTH_B = cookieNameForAuthority('127.0.0.1:5174')
const AUTH_C = cookieNameForAuthority('localhost:6000')

/** Build a throwaway cookie database with the rows the rescue must (not) touch. */
function createDatabase() {
  const dir = fs.mkdtempSync(path.join(import.meta.dirname, '.tmp-'))
  const dbPath = path.join(dir, 'Cookies')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE cookies (host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT, path TEXT)')
  const insert = db.prepare('INSERT INTO cookies (host_key, name, value, path) VALUES (?, ?, ?, ?)')
  insert.run('127.0.0.1', AUTH_A, 'v1', '/')
  insert.run('127.0.0.1', AUTH_B, 'v2', '/')
  insert.run('localhost', AUTH_C, 'v3', '/')
  insert.run('app.example.com', cookieNameForAuthority('app.example.com:443'), 'v4', '/')
  insert.run('127.0.0.1', 'theme', 'dark', '/')
  db.close()
  return { dir, dbPath }
}

/** Read the rows the rescue left behind. */
function remaining(dbPath) {
  const db = new DatabaseSync(dbPath)
  try {
    return db.prepare('SELECT host_key, name FROM cookies ORDER BY host_key, name').all()
  } finally {
    db.close()
  }
}

/** Remove one temp directory. */
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

test('the rescue path resolves from APPDATA on Windows', () => {
  const appData = path.join('C:\\', 'AppData', 'Roaming')
  assert.equal(
    defaultCookiesPath({ APPDATA: appData }, 'win32'),
    path.join(appData, '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies'),
  )
  assert.match(defaultCookiesPath({}, 'linux'), /dsh-desktop/u)
})

test('countAuthCookies counts only loopback generated names', () => {
  const { dir, dbPath } = createDatabase()
  try {
    assert.equal(countAuthCookies(dbPath), 3)
  } finally {
    cleanup(dir)
  }
})

test('deleteAuthCookies removes loopback auth rows and keeps everything else', () => {
  const { dir, dbPath } = createDatabase()
  try {
    assert.equal(deleteAuthCookies(dbPath), 3)
    assert.equal(countAuthCookies(dbPath), 0)

    const rows = remaining(dbPath)
    assert.deepEqual(
      rows.map((row) => `${row.host_key} ${row.name}`),
      [`127.0.0.1 theme`, `app.example.com ${cookieNameForAuthority('app.example.com:443')}`],
    )
  } finally {
    cleanup(dir)
  }
})

test('backupCookies writes a sibling copy of the database', () => {
  const { dir, dbPath } = createDatabase()
  try {
    const backupPath = backupCookies(dbPath)
    assert.notEqual(backupPath, dbPath)
    assert.ok(fs.existsSync(backupPath))
    assert.equal(fs.readFileSync(backupPath).length, fs.readFileSync(dbPath).length)
    assert.match(path.basename(backupPath), /\.dsh-cookie-guard-.*\.bak$/u)
  } finally {
    cleanup(dir)
  }
})

test('a dry run reports the count and changes nothing', async () => {
  const { dir, dbPath } = createDatabase()
  try {
    const lines = []
    const result = await run({ dbPath, dryRun: true }, { log: (line) => lines.push(line) })
    assert.equal(result.before, 3)
    assert.equal(result.deleted, 0)
    assert.equal(result.backupPath, null)
    assert.equal(countAuthCookies(dbPath), 3)
    assert.ok(lines.some((line) => line.includes('试运行')))
  } finally {
    cleanup(dir)
  }
})

test('a real run backs up first, then deletes only the auth rows', async () => {
  const { dir, dbPath } = createDatabase()
  try {
    const lines = []
    const result = await run({ dbPath, dryRun: false }, { log: (line) => lines.push(line) })
    assert.equal(result.before, 3)
    assert.equal(result.deleted, 3)
    assert.ok(result.backupPath !== null && fs.existsSync(result.backupPath))
    assert.equal(countAuthCookies(dbPath), 0)
    assert.equal(remaining(dbPath).length, 2)
    assert.ok(lines.some((line) => line.includes('已备份到')))
  } finally {
    cleanup(dir)
  }
})

test('a second run is a no-op', async () => {
  const { dir, dbPath } = createDatabase()
  try {
    await run({ dbPath, dryRun: false }, { log: () => {} })
    const second = await run({ dbPath, dryRun: false }, { log: () => {} })
    assert.equal(second.before, 0)
    assert.equal(second.deleted, 0)
  } finally {
    cleanup(dir)
  }
})

test('assertUnlocked rethrows non-lock failures instead of hiding them', () => {
  const missing = path.join(import.meta.dirname, '.tmp-missing', 'Cookies')
  assert.throws(() => assertUnlocked(missing), /ENOENT/u)
})

test('parseArgs accepts --db in both spellings and rejects unknown flags', () => {
  assert.deepEqual(parseArgs(['--db', 'C:\\tmp\\Cookies', '--dry-run']), {
    dbPath: 'C:\\tmp\\Cookies',
    dryRun: true,
    help: false,
  })
  assert.deepEqual(parseArgs(['--db=C:\\tmp\\Cookies']), { dbPath: 'C:\\tmp\\Cookies', dryRun: false, help: false })
  assert.deepEqual(parseArgs(['-h']), { dryRun: false, help: true })
  assert.throws(() => parseArgs(['--db']), /需要一个路径参数/u)
  assert.throws(() => parseArgs(['--wat']), /无法识别的参数/u)
})
