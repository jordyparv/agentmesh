/**
 * Embedded Postgres for dev/test: PGlite (+pgvector) exposed over the Postgres wire
 * protocol so the API and worker processes connect with the regular `pg` driver, exactly
 * as they do to a real server. Production uses docker-compose Postgres (ADR-002).
 *
 * PGlite is a single backend, so concurrent connections must be serialized correctly:
 *  - A connection's messages are batched up to a protocol boundary (Sync / simple Query /
 *    Terminate / startup) and each batch runs atomically, so extended-protocol
 *    Parse/Bind/Execute sequences from different connections never interleave.
 *  - While a connection is inside a transaction it keeps exclusive ownership of the
 *    backend until the transaction ends (other connections wait = correct isolation).
 *  - A connection that disconnects or idles inside a transaction is rolled back.
 * (@electric-sql/pglite-socket queues per message and breaks under concurrency; see
 * docs/ai/DECISIONS.md ADR-002.)
 */
import net from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

export interface EmbeddedPg {
  url: string;
  port: number;
  stop(): Promise<void>;
}

const SSL_REQUEST = 80877103;
const GSS_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;
const PROTOCOL_V3 = 196608;

class Mutex {
  private owner: number | null = null;
  private waiters: { id: number; resolve: () => void }[] = [];
  async acquire(id: number): Promise<void> {
    if (this.owner === id) return;
    if (this.owner === null) {
      this.owner = id;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push({ id, resolve }));
  }
  release(id: number): void {
    if (this.owner !== id) return;
    const next = this.waiters.shift();
    this.owner = next ? next.id : null;
    next?.resolve();
  }
  ownedBy(id: number): boolean {
    return this.owner === id;
  }
}

export async function startEmbeddedPostgres(opts: { dataDir?: string; port?: number; host?: string; idleInTransactionMs?: number } = {}): Promise<EmbeddedPg> {
  const db = await PGlite.create({ ...(opts.dataDir ? { dataDir: opts.dataDir } : {}), extensions: { vector } });
  await db.exec("CREATE EXTENSION IF NOT EXISTS vector");
  const lock = new Mutex();
  const sockets = new Set<net.Socket>();
  let nextId = 1;
  const idleTxMs = opts.idleInTransactionMs ?? 60_000;

  const server = net.createServer((socket) => {
    const id = nextId++;
    sockets.add(socket);
    let buf = Buffer.alloc(0);
    let started = false;
    let pending: Buffer[] = [];
    let chain: Promise<void> = Promise.resolve();
    let idleTimer: NodeJS.Timeout | null = null;
    let closed = false;

    const write = (data: Uint8Array) => {
      if (data.length && !socket.destroyed) socket.write(Buffer.from(data));
    };

    const runBatch = async (batch: Buffer[]) => {
      if (idleTimer) clearTimeout(idleTimer);
      await lock.acquire(id);
      try {
        for (const msg of batch) {
          if (closed) break;
          await db.execProtocolRawStream(new Uint8Array(msg), { onRawData: write });
        }
      } finally {
        if (db.isInTransaction() && !closed) {
          // Keep ownership until the transaction ends; guard against abandoned transactions.
          idleTimer = setTimeout(() => {
            socket.destroy();
          }, idleTxMs);
        } else {
          lock.release(id);
        }
      }
    };

    const releaseOnClose = async () => {
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      await chain.catch(() => undefined);
      if (lock.ownedBy(id)) {
        if (db.isInTransaction()) await db.exec("ROLLBACK").catch(() => undefined);
        lock.release(id);
      }
    };
    socket.on("close", () => {
      sockets.delete(socket);
      void releaseOnClose();
    });
    socket.on("error", () => socket.destroy());

    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!started) {
          if (buf.length < 8) return;
          const len = buf.readInt32BE(0);
          const code = buf.readInt32BE(4);
          if (buf.length < len) return;
          const msg = buf.subarray(0, len);
          buf = buf.subarray(len);
          if (code === SSL_REQUEST || code === GSS_REQUEST) {
            socket.write("N");
            continue;
          }
          if (code === CANCEL_REQUEST) {
            socket.end();
            return;
          }
          if (code !== PROTOCOL_V3) {
            socket.destroy();
            return;
          }
          started = true;
          const startup = Buffer.from(msg);
          chain = chain.then(() => runBatch([startup]));
          continue;
        }
        if (buf.length < 5) return;
        const type = buf[0]!;
        const len = 1 + buf.readInt32BE(1);
        if (buf.length < len) return;
        const msg = Buffer.from(buf.subarray(0, len));
        buf = buf.subarray(len);
        pending.push(msg);
        // 'S' Sync, 'Q' simple query, 'X' terminate, 'H' flush, 'c'/'f' copy done/fail end a unit of work.
        if (type === 0x53 || type === 0x51 || type === 0x58 || type === 0x48 || type === 0x63 || type === 0x66) {
          const batch = pending;
          pending = [];
          chain = chain.then(() => runBatch(batch)).catch(() => void socket.destroy());
          if (type === 0x58) socket.end();
        }
      }
    });
  });

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `postgres://postgres@${host}:${port}/postgres`,
    port,
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      await db.close();
    },
  };
}
