CREATE ROLE agent_hq_local_migration
  LOGIN
  PASSWORD 'agent_hq_local_migration'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION
  NOBYPASSRLS;

CREATE ROLE agent_hq_local_app
  LOGIN
  PASSWORD 'agent_hq_local_app'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION
  NOBYPASSRLS;

GRANT CONNECT ON DATABASE agent_hq TO agent_hq_local_app, agent_hq_local_migration;
GRANT CREATE ON DATABASE agent_hq TO agent_hq_local_migration;

SET ROLE agent_hq_local_migration;
CREATE SCHEMA app;
GRANT USAGE ON SCHEMA app TO agent_hq_local_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agent_hq_local_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO agent_hq_local_app;
RESET ROLE;

ALTER ROLE agent_hq_local_app IN DATABASE agent_hq SET search_path = app, public;
ALTER ROLE agent_hq_local_migration IN DATABASE agent_hq SET search_path = app, public;
