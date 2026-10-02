// The tables from architecture.md, "store". One migration per released schema change,
// applied in order and tracked in `user_version`. Never edit a migration that shipped.

export const MIGRATIONS: string[] = [
  // 1: the foundation tables
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- conversations: the chat stream and its threads
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    topic TEXT,
    workspace TEXT,
    summary TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    sessions TEXT NOT NULL DEFAULT '[]',
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    thread TEXT NOT NULL REFERENCES threads(id),
    at INTEGER NOT NULL,
    role TEXT NOT NULL,
    source TEXT NOT NULL,
    content TEXT NOT NULL,
    streaming INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX messages_thread_at ON messages(thread, at);

  -- harness sessions with their events
  CREATE TABLE harness_sessions (
    id TEXT PRIMARY KEY,
    node TEXT NOT NULL,
    harness TEXT NOT NULL,
    native_id TEXT NOT NULL,
    native_pid INTEGER,
    native_transport TEXT NOT NULL,
    origin TEXT NOT NULL,
    workspace TEXT,
    task TEXT,
    cwd TEXT NOT NULL,
    title TEXT,
    intent TEXT,
    summary TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    ask TEXT,
    started_at INTEGER NOT NULL,
    last_activity INTEGER NOT NULL,
    ended_at INTEGER,
    stats TEXT,
    transcript_path TEXT
  );
  CREATE INDEX harness_sessions_node_status ON harness_sessions(node, status);
  CREATE INDEX harness_sessions_native ON harness_sessions(harness, native_id);
  CREATE TABLE session_events (
    session TEXT NOT NULL REFERENCES harness_sessions(id),
    seq INTEGER NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    raw TEXT,
    PRIMARY KEY (session, seq)
  );

  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    node TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    origin TEXT NOT NULL,
    repo TEXT,
    summary TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    last_activity INTEGER NOT NULL,
    UNIQUE (node, path)
  );

  -- tasks with their triggers
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    detail TEXT,
    workspace TEXT,
    thread TEXT,
    parent TEXT,
    created_by TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT NOT NULL,
    trigger TEXT,
    recurring INTEGER NOT NULL DEFAULT 0,
    blocker TEXT,
    sessions TEXT NOT NULL DEFAULT '[]',
    result TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE INDEX tasks_status ON tasks(status);

  CREATE TABLE asks (
    id TEXT PRIMARY KEY,
    node TEXT NOT NULL,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    options TEXT NOT NULL,
    allows_text INTEGER NOT NULL DEFAULT 0,
    answerable_by TEXT NOT NULL,
    status TEXT NOT NULL,
    answer TEXT,
    remember TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER
  );
  CREATE INDEX asks_status ON asks(status);

  -- node and custom events
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node TEXT NOT NULL,
    name TEXT NOT NULL,
    at INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX events_name_at ON events(name, at);

  -- every request with its decision and result
  CREATE TABLE audit (
    id TEXT PRIMARY KEY,
    node TEXT NOT NULL,
    at INTEGER NOT NULL,
    principal TEXT NOT NULL,
    via TEXT,
    action TEXT NOT NULL,
    target TEXT,
    args TEXT NOT NULL,
    decision TEXT NOT NULL,
    ask TEXT,
    outcome TEXT,
    result_summary TEXT,
    result_bytes INTEGER,
    result_sha256 TEXT,
    result_body TEXT,
    duration_ms INTEGER,
    thread TEXT,
    task TEXT,
    correlation TEXT
  );
  CREATE INDEX audit_at ON audit(at);
  CREATE INDEX audit_outcome ON audit(outcome);

  -- remembered gate answers: the part of policy that is not config
  CREATE TABLE policy (
    key TEXT PRIMARY KEY,
    principal TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    decision TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- brain state such as wake rules
  CREATE TABLE kv (
    ns TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (ns, key)
  );

  CREATE TABLE entitlement (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token TEXT NOT NULL,
    claims TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );

  -- local counters shown in the UI
  CREATE TABLE usage (
    period TEXT NOT NULL,
    metric TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    cap INTEGER,
    PRIMARY KEY (period, metric)
  );

  -- per-minute rollups
  CREATE TABLE metrics (
    node TEXT NOT NULL,
    minute INTEGER NOT NULL,
    sample TEXT NOT NULL,
    PRIMARY KEY (node, minute)
  );
  `,
  // 2: sessions belong to a harness profile; history is read newest-first per session
  `
  ALTER TABLE harness_sessions ADD COLUMN profile TEXT NOT NULL DEFAULT '';
  CREATE INDEX harness_sessions_profile ON harness_sessions(profile);
  CREATE INDEX session_events_session_at ON session_events(session, at);
  `,
  // 3: threads paged by start, tasks ordered by change
  `
  CREATE INDEX threads_started_at ON threads(started_at);
  CREATE INDEX tasks_updated_at ON tasks(updated_at);
  `,
  // 4: an ask may take several options at once
  `
  ALTER TABLE asks ADD COLUMN multiple INTEGER NOT NULL DEFAULT 0;
  `,
  // 5: the recall index. One chunk per message, per session event and per memory heading
  // section; full text in an FTS5 external-content table over chunks.text (no second copy of
  // the text, snippet() and bm25() still work), kept in step by triggers so every write path
  // is honest; int8 vectors for prose chunks in chunk_vectors, gone with their chunk.
  `
  CREATE TABLE chunks (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    corpus TEXT NOT NULL,
    thread TEXT,
    message TEXT,
    session TEXT,
    seq INTEGER,
    memory TEXT,
    line_from INTEGER,
    line_to INTEGER,
    tags TEXT NOT NULL DEFAULT '[]',
    kind TEXT,
    at INTEGER NOT NULL,
    text TEXT NOT NULL,
    prose INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX chunks_thread ON chunks(thread);
  CREATE INDEX chunks_session_seq ON chunks(session, seq);
  CREATE INDEX chunks_memory ON chunks(memory);
  CREATE INDEX chunks_at ON chunks(at);
  CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='porter unicode61');
  CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER chunks_au AFTER UPDATE OF text ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    DELETE FROM chunk_vectors WHERE chunk = new.id;
  END;
  CREATE TABLE chunk_vectors (
    chunk INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    scale REAL NOT NULL,
    q BLOB NOT NULL
  );
  `,
  // 6: the node registry. Every node of the user as the primary last saw it, with how to
  // reach it, the epoch it last saw and its backup rank; kept on every node, so a secondary
  // that loses the primary knows which backups to try.
  `
  CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    backup INTEGER NOT NULL DEFAULT 0,
    rank INTEGER,
    platform TEXT NOT NULL,
    scope TEXT NOT NULL,
    capabilities TEXT NOT NULL,
    versions TEXT NOT NULL,
    endpoints TEXT NOT NULL DEFAULT '[]',
    epoch INTEGER,
    last_seen INTEGER NOT NULL,
    status TEXT NOT NULL
  );
  `,
  // 7: the cloud backup's ledger. One row per object the sender knows: its opaque server
  // key, the row or file it stands for, the version last sent, the hash of what was sent,
  // and whether the server acknowledged it. The hash is what keeps an unchanged row or an
  // unchanged file from being sent again.
  `
  CREATE TABLE backup_sync (
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    id TEXT NOT NULL,
    version INTEGER NOT NULL,
    hash TEXT NOT NULL,
    synced INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, key)
  );
  `,
  // 8: how far each session's transcript has been recorded as events, so a fresh tail (a
  // daemon restart, a resume) records only what is new. The sessions module's own; never
  // part of a Session and never sent anywhere.
  `
  CREATE TABLE transcript_tails (
    session TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    offset INTEGER NOT NULL
  );
  `,
  // 9: a Muse session is read through its view, not its log: how far is the view's opaque
  // cursor, kept beside the log's size then, which still tells a resume from a finished session.
  `
  ALTER TABLE transcript_tails ADD COLUMN cursor TEXT;
  `,
  // 10: the prose chunks, the only ones the embed queue reads. Without it the queue's two
  // questions after every write (the next batch, what is left) each scanned every chunk of
  // every session event, a fifth of a second on a store of a year's work, on the thread
  // that answers the brain: each reply reached the brain that much later.
  `
  CREATE INDEX chunks_prose ON chunks(id) WHERE prose = 1;
  `,
  // 11: what an orchestrator's turn did to get to its reply, kept with the reply for the chat
  // to fold above it (JSON, a list of steps); none on anything else.
  `
  ALTER TABLE messages ADD COLUMN steps TEXT;
  `,
  // 12: what the brain's model calls cost each conversation: a row per thread and model, the
  // tokens added as each call ends, so the Context overlay reads a conversation's spend without
  // walking its audit rows, whose results sit behind the whole prompt each. Filled from the
  // calls the audit table already holds: the ones whose result was kept and reads as JSON.
  `
  CREATE TABLE thread_spend (
    thread TEXT NOT NULL,
    model TEXT NOT NULL,
    calls INTEGER NOT NULL,
    tokens_in INTEGER NOT NULL,
    tokens_out INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,
    cache_write INTEGER NOT NULL,
    first_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    PRIMARY KEY (thread, model)
  );
  INSERT INTO thread_spend (thread, model, calls, tokens_in, tokens_out, cache_read, cache_write, first_at, last_at)
  SELECT thread, model, COUNT(*), SUM(tin), SUM(tout), SUM(cread), SUM(cwrite), MIN(at), MAX(at) FROM (
    SELECT thread, at,
      json_extract(result_body, '$.model') AS model,
      COALESCE(json_extract(result_body, '$.usage.in'), 0) AS tin,
      COALESCE(json_extract(result_body, '$.usage.out'), 0) AS tout,
      COALESCE(json_extract(result_body, '$.usage.cacheRead'), 0) AS cread,
      COALESCE(json_extract(result_body, '$.usage.cacheWrite'), 0) AS cwrite
    FROM audit
    WHERE action = 'llm.complete' AND outcome = 'ok' AND thread IS NOT NULL AND result_body IS NOT NULL AND json_valid(result_body)
  )
  WHERE model IS NOT NULL
  GROUP BY thread, model;
  `,
];
