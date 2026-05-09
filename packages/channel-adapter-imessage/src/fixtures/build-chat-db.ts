/**
 * Test helper — build a fixture chat.db with the minimum schema and
 * representative rows. Returns the path to the temp .db file.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function buildFixtureChatDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-imessage-fix-"));
  const path = join(dir, "chat.db");
  const db = new Database(path);
  db.run(`
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY,
      id TEXT NOT NULL,
      service TEXT NOT NULL DEFAULT 'iMessage'
    );
  `);
  db.run(`
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      text TEXT,
      is_from_me INTEGER DEFAULT 0,
      date INTEGER DEFAULT 0,
      handle_id INTEGER REFERENCES handle(ROWID)
    );
  `);

  db.run("INSERT INTO handle (ROWID, id) VALUES (1, 'alice@example.com')");
  db.run("INSERT INTO handle (ROWID, id) VALUES (2, '+15551234567')");

  db.run(
    "INSERT INTO message (ROWID, text, is_from_me, date, handle_id) VALUES (1, 'first inbound from alice', 0, 700000000000000000, 1)",
  );
  db.run(
    "INSERT INTO message (ROWID, text, is_from_me, date, handle_id) VALUES (2, 'me replying', 1, 700000001000000000, 1)",
  );
  db.run(
    "INSERT INTO message (ROWID, text, is_from_me, date, handle_id) VALUES (3, 'inbound from phone handle', 0, 700000002000000000, 2)",
  );
  db.run(
    "INSERT INTO message (ROWID, text, is_from_me, date, handle_id) VALUES (4, '', 0, 700000003000000000, 1)",
  );
  db.run(
    "INSERT INTO message (ROWID, text, is_from_me, date, handle_id) VALUES (5, 'another inbound', 0, 700000004000000000, 1)",
  );

  db.close();
  return path;
}
