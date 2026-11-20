// Server side of the SQLite viewer (public/js/apps/sqlite): reads a SQLite
// database file on the host without anything installed there. The file (and
// its -wal journal, if any) is copied over SFTP into a private temp folder on
// this server and opened with Node's built-in SQLite; the page then asks for
// tables, rows and read-only queries. Nothing is ever written back to the host.
// A copy lives until the page closes it, the session ends, or the session opens
// too many; then its temp folder is deleted.
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm, open as openLocal } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { call, codeError, reqPath, typeOf } from '../util.js';

const MAX_BYTES = 512 * 1024 * 1024; // largest database copied over
const PER_SESSION = 4; // open copies per session; the oldest is closed beyond this
const MAX_ROWS = 500; // rows per page of a table
const MAX_QUERY_ROWS = 1000; // rows a query returns
const MAX_TEXT = 2000; // longer text is cut (the page says how long it was)
const MAX_HEX = 32; // bytes of a BLOB shown

let sqlite = null; // node:sqlite, loaded on first use (it prints an experimental-feature warning)
async function engine() {
  if (!sqlite) {
    try {
      sqlite = await import('node:sqlite');
    } catch {
      throw codeError('no-sqlite', 'This server cannot read SQLite files');
    }
  }
  return sqlite;
}

// `db` is the copy's handle; not `id`, which is the request's own (see rpc.js)
const dbs = (session) => (session.sqlite ??= new Map()); // handle -> { db, dir, path }
const ident = (name) => '"' + String(name).replace(/"/g, '""') + '"';

function closeOne(session, id) {
  const it = session.sqlite?.get(id);
  if (!it) return;
  session.sqlite.delete(id);
  try {
    it.db.close();
  } catch {
    /* already closed */
  }
  rm(it.dir, { recursive: true, force: true }).catch(() => {});
}

export function dropSqlite(session) {
  for (const id of [...(session.sqlite?.keys() || [])]) closeOne(session, id);
}

function get(session, handle) {
  const it = session.sqlite?.get(String(handle));
  if (!it) throw codeError('sqlite-closed', 'This database is no longer open');
  return it;
}

// A value as JSON can carry it: big integers as text, BLOBs as their size and
// first bytes, long text cut short.
function cell(v) {
  if (typeof v === 'bigint') return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : { int: v.toString() };
  if (v instanceof Uint8Array) return { blob: v.length, hex: Buffer.from(v.subarray(0, MAX_HEX)).toString('hex') };
  if (typeof v === 'number' && !Number.isFinite(v)) return { real: String(v) };
  if (typeof v === 'string' && v.length > MAX_TEXT) return { text: v.slice(0, MAX_TEXT), len: v.length };
  return v;
}

function rowsOf(stmt, limit) {
  stmt.setReadBigInts(true);
  stmt.setReturnArrays(true);
  const rows = [];
  let more = false;
  for (const r of stmt.iterate()) {
    if (rows.length >= limit) {
      more = true;
      break;
    }
    rows.push(r.map(cell));
  }
  return { rows, more };
}

function schemaOf(db) {
  const objs = db.prepare(`SELECT type, name, sql FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name COLLATE NOCASE`).all();
  return objs.map((o) => {
    const columns = db.prepare(`PRAGMA table_xinfo(${ident(o.name)})`).all()
      .filter((c) => c.hidden !== 1) // hidden columns of virtual tables
      .map((c) => ({ name: c.name, type: c.type, notnull: !!c.notnull, dflt: c.dflt_value, pk: c.pk, generated: c.hidden > 1 }));
    let rows = null;
    if (o.type === 'table') {
      try {
        rows = Number(db.prepare(`SELECT count(*) AS n FROM ${ident(o.name)}`).get().n);
      } catch {
        rows = null; // a virtual table whose module is not here
      }
    }
    const indexes = db.prepare(`SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`).all(o.name);
    return { type: o.type, name: o.name, sql: o.sql, columns, rows, indexes };
  });
}

// SQLite files start with this.
const MAGIC = 'SQLite format 3\0';

export async function sqliteOpen({ sftp, session }, msg) {
  const path = reqPath(msg.path);
  const st = await call(sftp, 'stat', path);
  if (typeOf(st) !== 'file') throw codeError('not-a-file', 'Not a file');
  if (st.size > MAX_BYTES) throw codeError('too-large', 'The database is too large');
  const { DatabaseSync } = await engine();
  const dir = await mkdtemp(join(tmpdir(), 'remogui-sqlite-'));
  const local = join(dir, 'db.sqlite');
  try {
    await call(sftp, 'fastGet', path, local, {});
    const head = Buffer.alloc(16);
    const fh = await openLocal(local, 'r');
    try {
      await fh.read(head, 0, 16, 0);
    } finally {
      await fh.close();
    }
    if (st.size > 0 && head.toString('latin1') !== MAGIC) throw codeError('not-sqlite', 'Not a SQLite database');
    // Changes not yet folded into the file are in its write-ahead log.
    const wal = await call(sftp, 'stat', path + '-wal').catch(() => null);
    if (wal && typeOf(wal) === 'file' && wal.size > 0 && wal.size <= MAX_BYTES) {
      await call(sftp, 'fastGet', path + '-wal', local + '-wal', {}).catch(() => {});
    }
    // Opened read-write so the log can be read; it is our own copy, and
    // query_only stops queries from changing even that.
    const db = new DatabaseSync(local);
    db.exec('PRAGMA query_only = ON');
    const tables = schemaOf(db);
    const mine = dbs(session);
    while (mine.size >= PER_SESSION) closeOne(session, mine.keys().next().value);
    const handle = randomBytes(12).toString('hex');
    mine.set(handle, { db, dir, path });
    return { db: handle, size: st.size, mtime: st.mtime, tables };
  } catch (err) {
    rm(dir, { recursive: true, force: true }).catch(() => {});
    if (!err.code && /not a database|malformed|encrypted/i.test(err.message)) throw codeError('not-sqlite', err.message);
    throw err;
  }
}

export async function sqliteClose({ session }, msg) {
  closeOne(session, String(msg.db));
  return {};
}

// One page of a table or view, optionally sorted by one of its columns.
export async function sqliteRows({ session }, msg) {
  const { db } = get(session, msg.db);
  const obj = schemaOf(db).find((o) => o.name === msg.table);
  if (!obj) throw codeError('not-found', 'No such table');
  const offset = Number.isInteger(msg.offset) && msg.offset >= 0 ? msg.offset : 0;
  const limit = Number.isInteger(msg.limit) && msg.limit > 0 ? Math.min(msg.limit, MAX_ROWS) : 100;
  let order = '';
  if (msg.order != null) {
    if (!obj.columns.some((c) => c.name === msg.order)) throw codeError('bad-request', 'No such column');
    order = ` ORDER BY ${ident(msg.order)} ${msg.desc ? 'DESC' : 'ASC'}`;
  }
  const stmt = db.prepare(`SELECT * FROM ${ident(obj.name)}${order} LIMIT ? OFFSET ?`);
  stmt.setReadBigInts(true);
  stmt.setReturnArrays(true);
  const columns = stmt.columns().map((c) => c.name);
  const rows = stmt.all(limit, offset).map((r) => r.map(cell));
  return { columns, rows, offset };
}

// The SQL with strings, quoted names and comments blanked out, so keywords and
// semicolons can be looked at.
function bare(sql) {
  let out = '';
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    const close = { "'": "'", '"': '"', '`': '`', '[': ']' }[c];
    if (close) {
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) j++;
          else break;
        }
      }
      out += ' x ';
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      out += ' ';
      i = j < 0 ? sql.length : j + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      out += ' ';
      i = j < 0 ? sql.length : j + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const READ_PRAGMAS = new Set(['table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list',
  'foreign_key_check', 'integrity_check', 'quick_check', 'database_list', 'collation_list', 'function_list', 'module_list', 'pragma_list',
  'compile_options', 'page_count', 'page_size', 'freelist_count', 'user_version', 'application_id', 'schema_version', 'encoding', 'journal_mode', 'auto_vacuum']);

// A read-only query of the user's own. One statement, and only the kinds that
// read: SELECT, WITH … SELECT, VALUES, EXPLAIN, PRAGMA.
export async function sqliteQuery({ session }, msg) {
  const { db } = get(session, msg.db);
  if (typeof msg.sql !== 'string' || !msg.sql.trim() || msg.sql.length > 100000) throw codeError('bad-request', 'Empty query');
  const b = bare(msg.sql).trim().replace(/;\s*$/, '');
  if (b.includes(';')) throw codeError('sqlite-one', 'Only one statement at a time');
  const first = (/^[A-Za-z]+/.exec(b)?.[0] || '').toUpperCase();
  if (!['SELECT', 'WITH', 'VALUES', 'EXPLAIN', 'PRAGMA'].includes(first)) throw codeError('sqlite-readonly', 'Only queries that read are allowed');
  if (first === 'PRAGMA') {
    const m = /^PRAGMA\s+(?:main\s*\.\s*)?([A-Za-z_]+)\s*(\(|$)/i.exec(b);
    if (!m || b.includes('=') || !READ_PRAGMAS.has(m[1].toLowerCase())) throw codeError('sqlite-readonly', 'Only pragmas that read are allowed');
  }
  const started = performance.now();
  let stmt;
  try {
    stmt = db.prepare(msg.sql);
  } catch (err) {
    throw codeError('sqlite-error', err.message);
  }
  const columns = stmt.columns().map((c) => c.name);
  let res;
  try {
    res = rowsOf(stmt, MAX_QUERY_ROWS);
  } catch (err) {
    throw codeError(/readonly|query_only/i.test(err.message) ? 'sqlite-readonly' : 'sqlite-error', err.message);
  }
  return { columns, ...res, ms: Math.round(performance.now() - started) };
}
