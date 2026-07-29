import Database from 'better-sqlite3';
import type { CandidateFact, Memory, StoredMessage } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id      TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  ts      TEXT NOT NULL,
  author  TEXT NOT NULL,
  text    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  channel        TEXT NOT NULL,
  scope          TEXT NOT NULL CHECK (scope IN ('person','channel')),
  subject        TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('decision','deadline','availability','preference','ownership','fact')),
  statement      TEXT NOT NULL,
  certainty      TEXT NOT NULL CHECK (certainty IN ('decided','tentative')),
  confidence     REAL NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('active','superseded')),
  created_at     TEXT NOT NULL,
  invalid_at     TEXT,
  superseded_by  INTEGER REFERENCES memories(id),
  source_msg_ids TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_lookup ON memories (channel, status, subject);
`;

interface MemoryRow {
  id: number;
  channel: string;
  scope: string;
  subject: string;
  kind: string;
  statement: string;
  certainty: string;
  confidence: number;
  status: string;
  created_at: string;
  invalid_at: string | null;
  superseded_by: number | null;
  source_msg_ids: string;
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    channel: row.channel,
    scope: row.scope as Memory['scope'],
    subject: row.subject,
    kind: row.kind as Memory['kind'],
    statement: row.statement,
    certainty: row.certainty as Memory['certainty'],
    confidence: row.confidence,
    status: row.status as Memory['status'],
    created_at: row.created_at,
    invalid_at: row.invalid_at,
    superseded_by: row.superseded_by,
    source_msg_ids: JSON.parse(row.source_msg_ids) as string[],
  };
}

export class MemoryStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  insertMessages(messages: StoredMessage[]): number {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO messages (id, channel, ts, author, text) VALUES (?, ?, ?, ?, ?)',
    );
    let inserted = 0;
    const tx = this.db.transaction((msgs: StoredMessage[]) => {
      for (const m of msgs) inserted += stmt.run(m.id, m.channel, m.ts, m.author, m.text).changes;
    });
    tx(messages);
    return inserted;
  }

  getMessages(ids: string[]): StoredMessage[] {
    const stmt = this.db.prepare('SELECT * FROM messages WHERE id = ?');
    return ids
      .map((id) => stmt.get(id) as StoredMessage | undefined)
      .filter((m): m is StoredMessage => m !== undefined);
  }

  latestMessageTs(): string | null {
    const row = this.db.prepare('SELECT MAX(ts) AS ts FROM messages').get() as { ts: string | null };
    return row.ts;
  }

  insertMemory(channel: string, fact: CandidateFact, createdAt: string): Memory {
    const info = this.db
      .prepare(
        `INSERT INTO memories
           (channel, scope, subject, kind, statement, certainty, confidence, status, created_at, source_msg_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        channel, fact.scope, fact.subject, fact.kind, fact.statement,
        fact.certainty, fact.confidence, createdAt, JSON.stringify(fact.source_msg_ids),
      );
    return this.byId(Number(info.lastInsertRowid));
  }

  private byId(id: number): Memory {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    if (!row) throw new Error(`memory ${id} not found`);
    return rowToMemory(row);
  }

  activeCandidates(channel: string, subject: string): Memory[] {
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE channel = ? AND status = 'active' AND subject = ? ORDER BY id")
      .all(channel, subject) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  activeMemories(): Memory[] {
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE status = 'active' ORDER BY id")
      .all() as MemoryRow[];
    return rows.map(rowToMemory);
  }

  allMemories(): Memory[] {
    const rows = this.db.prepare('SELECT * FROM memories ORDER BY id').all() as MemoryRow[];
    return rows.map(rowToMemory);
  }

  updateStatement(id: number, statement: string, extraSourceIds: string[]): void {
    this.db.prepare('UPDATE memories SET statement = ? WHERE id = ?').run(statement, id);
    this.mergeSourceIds(id, extraSourceIds);
  }

  mergeSourceIds(id: number, extraSourceIds: string[]): void {
    const current = this.byId(id).source_msg_ids;
    const merged = [...new Set([...current, ...extraSourceIds])];
    this.db.prepare('UPDATE memories SET source_msg_ids = ? WHERE id = ?').run(JSON.stringify(merged), id);
  }

  supersede(oldId: number, newId: number, invalidAt: string): void {
    this.db
      .prepare("UPDATE memories SET status = 'superseded', invalid_at = ?, superseded_by = ? WHERE id = ?")
      .run(invalidAt, newId, oldId);
  }

  /** Atomically inserts the superseding memory and closes the old row in one transaction. */
  insertSuperseding(channel: string, fact: CandidateFact, createdAt: string, oldId: number): Memory {
    const tx = this.db.transaction(() => {
      const created = this.insertMemory(channel, fact, createdAt);
      this.supersede(oldId, created.id, createdAt);
      return created;
    });
    return tx();
  }

  close(): void {
    this.db.close();
  }
}
