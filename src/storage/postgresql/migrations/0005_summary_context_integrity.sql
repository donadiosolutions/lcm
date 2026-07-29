LOCK TABLE lcm.summary_parents IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  damaged_edge record;
BEGIN
  SELECT edge.project_id,
         edge.conversation_id,
         edge.summary_key
  INTO damaged_edge
  FROM lcm.summary_parents AS edge
  LEFT JOIN lcm.summaries AS child
    ON child.project_id OPERATOR(pg_catalog.=) edge.project_id
   AND child.conversation_id OPERATOR(pg_catalog.=) edge.conversation_id
   AND child.summary_key OPERATOR(pg_catalog.=) edge.summary_key
  WHERE child.summary_key IS NULL
  ORDER BY edge.project_id, edge.conversation_id, edge.summary_key,
           edge.parent_summary_key
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'cannot install summary DAG integrity: missing or cross-scope child summary at project %, conversation %, summary %',
      damaged_edge.project_id,
      damaged_edge.conversation_id,
      damaged_edge.summary_key
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'summary_parents_project_id_conversation_id_summary_key_fkey';
  END IF;

  SELECT edge.project_id,
         edge.conversation_id,
         edge.parent_summary_key AS summary_key
  INTO damaged_edge
  FROM lcm.summary_parents AS edge
  LEFT JOIN lcm.summaries AS parent
    ON parent.project_id OPERATOR(pg_catalog.=) edge.project_id
   AND parent.conversation_id OPERATOR(pg_catalog.=) edge.conversation_id
   AND parent.summary_key OPERATOR(pg_catalog.=) edge.parent_summary_key
  WHERE parent.summary_key IS NULL
  ORDER BY edge.project_id, edge.conversation_id, edge.summary_key,
           edge.parent_summary_key
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'cannot install summary DAG integrity: missing or cross-scope parent summary at project %, conversation %, summary %',
      damaged_edge.project_id,
      damaged_edge.conversation_id,
      damaged_edge.summary_key
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT =
              'summary_parents_project_id_conversation_id_parent_summary__fkey';
  END IF;

  SELECT edge.project_id,
         edge.conversation_id,
         edge.summary_key
  INTO damaged_edge
  FROM lcm.summary_parents AS edge
  WHERE edge.summary_key OPERATOR(pg_catalog.=) edge.parent_summary_key
  ORDER BY edge.project_id, edge.conversation_id, edge.summary_key
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'cannot install summary DAG integrity: self edge at project %, conversation %, summary %',
      damaged_edge.project_id,
      damaged_edge.conversation_id,
      damaged_edge.summary_key
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'summary_parents_check';
  END IF;

  WITH RECURSIVE parent_walk (
    project_id,
    conversation_id,
    origin_summary_key,
    current_summary_key
  ) AS (
    SELECT edge.project_id,
           edge.conversation_id,
           edge.summary_key,
           edge.parent_summary_key
    FROM lcm.summary_parents AS edge
    UNION
    SELECT walk.project_id,
           walk.conversation_id,
           walk.origin_summary_key,
           edge.parent_summary_key
    FROM parent_walk AS walk
    JOIN lcm.summary_parents AS edge
      ON edge.project_id OPERATOR(pg_catalog.=) walk.project_id
     AND edge.conversation_id OPERATOR(pg_catalog.=) walk.conversation_id
     AND edge.summary_key OPERATOR(pg_catalog.=) walk.current_summary_key
  )
  SELECT walk.project_id,
         walk.conversation_id,
         walk.current_summary_key AS summary_key
  INTO damaged_edge
  FROM parent_walk AS walk
  WHERE walk.origin_summary_key OPERATOR(pg_catalog.=)
    walk.current_summary_key
  ORDER BY walk.project_id, walk.conversation_id, walk.origin_summary_key,
           walk.current_summary_key
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'cannot install summary DAG integrity: cycle at project %, conversation %, summary %',
      damaged_edge.project_id,
      damaged_edge.conversation_id,
      damaged_edge.summary_key
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'summary_parents_dag_acyclic';
  END IF;
END
$preflight$;

CREATE FUNCTION lcm.enforce_summary_parent_dag_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')
       OPERATOR(pg_catalog.<>) 'read committed' THEN
    RAISE EXCEPTION
      'summary DAG integrity enforcement requires READ COMMITTED isolation'
      USING ERRCODE = 'feature_not_supported';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.lower(NEW.project_id::pg_catalog.text)
        OPERATOR(pg_catalog.||) ':conversation:'
        OPERATOR(pg_catalog.||) pg_catalog.encode(
          public.digest(
            NEW.conversation_id::pg_catalog.text,
            'sha256'
          ),
          'hex'
        ),
      0
    )
  );

  IF NEW.summary_key OPERATOR(pg_catalog.=) NEW.parent_summary_key THEN
    RAISE EXCEPTION 'summary cannot be its own parent'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'summary_parents_check';
  END IF;

  PERFORM 1
  FROM lcm.summaries AS child
  WHERE child.project_id OPERATOR(pg_catalog.=) NEW.project_id
    AND child.conversation_id OPERATOR(pg_catalog.=) NEW.conversation_id
    AND child.summary_key OPERATOR(pg_catalog.=) NEW.summary_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'summary parent edge references a missing or cross-scope child summary'
      USING ERRCODE = 'foreign_key_violation',
            CONSTRAINT = 'summary_parents_project_id_conversation_id_summary_key_fkey';
  END IF;

  PERFORM 1
  FROM lcm.summaries AS parent
  WHERE parent.project_id OPERATOR(pg_catalog.=) NEW.project_id
    AND parent.conversation_id OPERATOR(pg_catalog.=) NEW.conversation_id
    AND parent.summary_key OPERATOR(pg_catalog.=) NEW.parent_summary_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'summary parent edge references a missing or cross-scope parent summary'
      USING ERRCODE = 'foreign_key_violation',
            CONSTRAINT =
              'summary_parents_project_id_conversation_id_parent_summary__fkey';
  END IF;

  IF EXISTS (
    WITH RECURSIVE ancestors (summary_key) AS (
      SELECT NEW.parent_summary_key
      UNION
      SELECT edge.parent_summary_key
      FROM ancestors
      JOIN lcm.summary_parents AS edge
        ON edge.project_id OPERATOR(pg_catalog.=) NEW.project_id
       AND edge.conversation_id OPERATOR(pg_catalog.=) NEW.conversation_id
       AND edge.summary_key OPERATOR(pg_catalog.=) ancestors.summary_key
      WHERE NOT (
        CASE
          WHEN TG_OP OPERATOR(pg_catalog.=) 'UPDATE' THEN
            edge.project_id OPERATOR(pg_catalog.=) OLD.project_id
            AND edge.summary_key OPERATOR(pg_catalog.=) OLD.summary_key
            AND edge.parent_summary_key OPERATOR(pg_catalog.=)
              OLD.parent_summary_key
          ELSE false
        END
      )
    )
    SELECT 1
    FROM ancestors
    WHERE ancestors.summary_key OPERATOR(pg_catalog.=) NEW.summary_key
  ) THEN
    RAISE EXCEPTION 'summary parent edge would create a cycle'
      USING ERRCODE = 'raise_exception',
            CONSTRAINT = 'summary_parents_dag_acyclic';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER summary_parents_enforce_dag_integrity
BEFORE INSERT OR UPDATE OF
  project_id, conversation_id, summary_key, parent_summary_key
ON lcm.summary_parents
FOR EACH ROW EXECUTE FUNCTION lcm.enforce_summary_parent_dag_integrity();
ALTER TABLE lcm.summary_parents
  ENABLE ALWAYS TRIGGER summary_parents_enforce_dag_integrity;

REVOKE ALL PRIVILEGES
ON FUNCTION lcm.enforce_summary_parent_dag_integrity()
FROM PUBLIC;
