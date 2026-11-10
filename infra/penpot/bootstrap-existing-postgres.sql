-- Run against the EXISTING CodeLab database as a database administrator.
-- psql example:
--   psql "$DATABASE_URL" \
--     -v penpot_role=codelab_penpot \
--     -v penpot_password='REPLACE_WITH_UNIQUE_LONG_PASSWORD' \
--     -v penpot_schema=penpot
-- This creates no database and does not touch CodeLab tables.
\set ON_ERROR_STOP on

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'penpot_role', :'penpot_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'penpot_role')
\gexec

SELECT format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', :'penpot_schema', :'penpot_role')
\gexec

SELECT format('ALTER SCHEMA %I OWNER TO %I', :'penpot_schema', :'penpot_role')
\gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'penpot_role')
\gexec

SELECT format('ALTER ROLE %I IN DATABASE %I SET search_path = %I, public', :'penpot_role', current_database(), :'penpot_schema')
\gexec

GRANT USAGE, CREATE ON SCHEMA penpot TO codelab_penpot;

-- Verify before starting Penpot:
--   SET ROLE codelab_penpot;
--   SHOW search_path;  -- expected: penpot, public
--   RESET ROLE;
