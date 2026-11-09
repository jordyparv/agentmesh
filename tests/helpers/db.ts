import { createDb, runMigrations, type DbHandle } from "@agentmesh/database";
import { startEmbeddedPostgres, type EmbeddedPg } from "../../packages/database/src/dev-server.ts";

export interface TestDb extends DbHandle {
  pg: EmbeddedPg;
  url: string;
  teardown(): Promise<void>;
}

/** Fresh in-memory Postgres (PGlite) per test file, reached over the wire protocol. */
export async function createTestDb(): Promise<TestDb> {
  const pg = await startEmbeddedPostgres();
  const handle = createDb(pg.url);
  await runMigrations(handle.db);
  return {
    ...handle,
    pg,
    url: pg.url,
    async teardown() {
      await handle.close();
      await pg.stop();
    },
  };
}
