// Additive projections keep schema-2 clients able to read and write task history.
// Counters and summaries follow legacy writes too, through SQLite triggers.
function summaryPayload(payload: string): string {
  return `CASE WHEN json_valid(${payload}) THEN json_set(
    json_remove(${payload}, '$.events', '$.workflowEvidence'), '$.events',
    CASE WHEN json_type(${payload}, '$.events') = 'array'
      AND json_array_length(json_extract(${payload}, '$.events')) = 1
      AND json_type(${payload}, '$.events[0]') = 'object'
      THEN json_array(json(json_extract(${payload}, '$.events[0]')))
      ELSE json('[]') END
  ) ELSE ${payload} END`;
}

function summaryValues(id: string, stamp: string, payload: string): string {
  return `${id}, ${stamp},
    CASE WHEN json_valid(${payload}) THEN lower(COALESCE(json_extract(${payload}, '$.status'), '')) ELSE 'invalid' END,
    CASE WHEN json_valid(${payload}) THEN COALESCE(json_extract(${payload}, '$.workspace'), '') ELSE '' END,
    CASE WHEN json_valid(${payload}) THEN COALESCE(json_extract(${payload}, '$.correlation.conversationId'), '') ELSE '' END,
    ${summaryPayload(payload)}, length(CAST(${payload} AS BLOB))`;
}

function boundedJsonSearchText(payload: string, path: string, maxBytes = 2000): string {
  return `substr(COALESCE(CAST(json_extract(${payload}, '${path}') AS TEXT), ''), 1, ${maxBytes})`;
}

function eventSearchText(payload: string): string {
  const fields = [
    ['$.eventId', 500], ['$.operationId', 500], ['$.id', 500], ['$.summary', 2000], ['$.message', 2000],
    ['$.title', 1000], ['$.tool', 500], ['$.action', 500], ['$.command', 2000], ['$.path', 2000],
    ['$.error.code', 1000], ['$.error.message', 2000]
  ] as const;
  return `CASE WHEN json_valid(${payload}) THEN lower(trim(${fields
    .map(([field, limit]) => boundedJsonSearchText(payload, field, limit))
    .join(" || ' ' || ")})) ELSE '' END`;
}

const TASK_HISTORY_PROJECTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_history_summaries(
  id TEXT PRIMARY KEY, updated_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL, workspace TEXT NOT NULL, conversation_id TEXT NOT NULL,
  payload TEXT NOT NULL, bytes INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS task_history_summaries_recent_idx
  ON task_history_summaries(updated_at_ms DESC,id ASC);
CREATE INDEX IF NOT EXISTS task_history_summaries_workspace_idx
  ON task_history_summaries(workspace,updated_at_ms DESC,id ASC);
CREATE INDEX IF NOT EXISTS task_history_summaries_conversation_idx
  ON task_history_summaries(workspace,conversation_id,updated_at_ms DESC,id ASC);
CREATE TABLE IF NOT EXISTS task_history_storage_usage(
  kind TEXT PRIMARY KEY, bytes INTEGER NOT NULL
) STRICT;
INSERT INTO task_history_summaries(id,updated_at_ms,status,workspace,conversation_id,payload,bytes)
  SELECT ${summaryValues('id', 'updated_at_ms', 'payload')} FROM task_history WHERE true
  ON CONFLICT(id) DO UPDATE SET updated_at_ms=excluded.updated_at_ms,
    status=excluded.status,workspace=excluded.workspace,conversation_id=excluded.conversation_id,payload=excluded.payload,bytes=excluded.bytes;
INSERT INTO task_history_storage_usage(kind,bytes)
  VALUES('history',(SELECT COALESCE(SUM(bytes),0) FROM task_history_summaries)),
    ('events',(SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM task_history_events))
  ON CONFLICT(kind) DO UPDATE SET bytes=excluded.bytes;
${['insert', 'update'].map(action => `
CREATE TRIGGER IF NOT EXISTS task_history_summaries_after_${action}
AFTER ${action === 'insert' ? 'INSERT' : 'UPDATE OF updated_at_ms,payload'} ON task_history
BEGIN
  INSERT INTO task_history_summaries(id,updated_at_ms,status,workspace,conversation_id,payload,bytes)
    VALUES(${summaryValues('NEW.id', 'NEW.updated_at_ms', 'NEW.payload')})
    ON CONFLICT(id) DO UPDATE SET updated_at_ms=excluded.updated_at_ms,
      status=excluded.status,workspace=excluded.workspace,conversation_id=excluded.conversation_id,payload=excluded.payload,bytes=excluded.bytes;
END;`).join('\n')}
CREATE TRIGGER IF NOT EXISTS task_history_summaries_after_delete AFTER DELETE ON task_history
BEGIN DELETE FROM task_history_summaries WHERE id=OLD.id; END;
${([['task_history_summaries', 'history', 'bytes'], ['task_history_events', 'events', 'length(CAST($row.payload AS BLOB))']] as const).map(([table, kind, expression]) => {
  const value = (row: string) => expression === 'bytes' ? `${row}.bytes` : expression.replace('$row', row);
  return `
CREATE TRIGGER IF NOT EXISTS ${table}_bytes_after_insert AFTER INSERT ON ${table}
BEGIN UPDATE task_history_storage_usage SET bytes=bytes+${value('NEW')} WHERE kind='${kind}'; END;
CREATE TRIGGER IF NOT EXISTS ${table}_bytes_after_update AFTER UPDATE ON ${table}
WHEN ${expression === 'bytes' ? 'NEW.bytes <> OLD.bytes' : 'NEW.payload <> OLD.payload'}
BEGIN UPDATE task_history_storage_usage SET bytes=bytes+${value('NEW')}-${value('OLD')} WHERE kind='${kind}'; END;
CREATE TRIGGER IF NOT EXISTS ${table}_bytes_after_delete AFTER DELETE ON ${table}
BEGIN UPDATE task_history_storage_usage SET bytes=bytes-${value('OLD')} WHERE kind='${kind}'; END;`;
}).join('\n')}
`;

const TASK_HISTORY_EVENT_SEARCH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_history_event_search(
  task_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  workspace TEXT NOT NULL,
  session_id TEXT NOT NULL,
  search_text TEXT NOT NULL,
  PRIMARY KEY(task_id,event_key)
) STRICT;
CREATE INDEX IF NOT EXISTS task_history_event_search_workspace_idx
  ON task_history_event_search(workspace,task_id);
INSERT OR REPLACE INTO task_history_event_search(task_id,event_key,workspace,session_id,search_text)
  SELECT task_id,event_key,workspace,session_id,${eventSearchText('payload')} FROM task_history_events;
CREATE TRIGGER IF NOT EXISTS task_history_event_search_after_insert
AFTER INSERT ON task_history_events
BEGIN
  INSERT INTO task_history_event_search(task_id,event_key,workspace,session_id,search_text)
    VALUES(NEW.task_id,NEW.event_key,NEW.workspace,NEW.session_id,${eventSearchText('NEW.payload')})
    ON CONFLICT(task_id,event_key) DO UPDATE SET
      workspace=excluded.workspace,session_id=excluded.session_id,search_text=excluded.search_text;
END;
CREATE TRIGGER IF NOT EXISTS task_history_event_search_after_update
AFTER UPDATE OF event_key,workspace,session_id,payload ON task_history_events
BEGIN
  DELETE FROM task_history_event_search WHERE task_id=OLD.task_id AND event_key=OLD.event_key;
  INSERT INTO task_history_event_search(task_id,event_key,workspace,session_id,search_text)
    VALUES(NEW.task_id,NEW.event_key,NEW.workspace,NEW.session_id,${eventSearchText('NEW.payload')})
    ON CONFLICT(task_id,event_key) DO UPDATE SET
      workspace=excluded.workspace,session_id=excluded.session_id,search_text=excluded.search_text;
END;
CREATE TRIGGER IF NOT EXISTS task_history_event_search_after_delete
AFTER DELETE ON task_history_events
BEGIN
  DELETE FROM task_history_event_search WHERE task_id=OLD.task_id AND event_key=OLD.event_key;
END;
`;

export { TASK_HISTORY_EVENT_SEARCH_SCHEMA_SQL, TASK_HISTORY_PROJECTION_SCHEMA_SQL };
