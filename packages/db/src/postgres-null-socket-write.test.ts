import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Regression guard for the 2026-09-06 outage (HOM-421 / HOM-418).
 *
 * A ~60s burst of `getaddrinfo EAI_AGAIN paperclip-pg-rw.paperclip` killed the
 * Paperclip process with:
 *
 *   TypeError: Cannot read properties of null (reading 'write')
 *     at Immediate.nextWrite (postgres@3.4.9/src/connection.js:255:22)
 *
 * and the app was unreachable for 9.7 hours.
 *
 * The mechanism is a race inside postgres.js, not in our code:
 *
 *   1. `drain` during the connect handshake calls `onopen()`, which moves the
 *      connection into the pool's `open` queue while `initial` is still set.
 *   2. The socket closes. `closed()` sets `socket = null`, then hits
 *      `if (initial) return reconnect()` and returns *before* telling the pool,
 *      so a connection with a null socket stays in the `open` queue.
 *   3. A query arriving inside the reconnect backoff window is handed to that
 *      connection. `execute()` calls `write()`, which schedules
 *      `setImmediate(nextWrite)`, and `nextWrite` dereferences the null socket.
 *
 * Because step 3 runs in a macrotask, the TypeError is an *uncaughtException*,
 * not a rejected query promise — Node's default handler terminates the process.
 * No amount of `.catch()` on our side can intercept it.
 *
 * Fixed by `patches/postgres@3.4.9.patch`. postgres@3.4.9 is the latest release
 * (checked 2026-09-15), so there is no upstream version to bump to.
 *
 * The patch covers all THREE copies of the driver the package ships — `src`
 * (ESM), `cjs` (CommonJS) and `cf` (workerd) — because the export map routes
 * `import` to `src` but `require` to `cjs`. Patching only the ESM build leaves
 * a process-killing crash one transpile or one CJS consumer away.
 *
 * The backoff half of the incident needs no fix: postgres.js already retries
 * with `(0.5 + random/2) * min(3^retries/100, 20)` seconds — exponential,
 * jittered, capped at 20s.
 */

const require = createRequire(import.meta.url);

// `postgres` blocks subpath imports in its export map, so resolve the package
// entry and walk to the sources from there rather than resolving them directly.
const DRIVER_ROOT = path.resolve(require.resolve("postgres"), "../../..");
const DRIVER_BUILDS = ["src/connection.js", "cjs/src/connection.js", "cf/src/connection.js"];

describe("postgres.js null-socket write guard (HOM-421)", () => {
  it.each(DRIVER_BUILDS)("keeps the patched guard in the installed driver (%s)", (build) => {
    // Fails loudly if the patch is dropped, if `pnpm.patchedDependencies` stops
    // covering postgres, or if the dependency is bumped without re-patching.
    // Without this, the behavioural test below could pass vacuously.
    const source = readFileSync(path.join(DRIVER_ROOT, build), "utf8");
    const nextWrite = source.slice(source.indexOf("function nextWrite("));
    const guard = nextWrite.indexOf("socket === null");
    const write = nextWrite.indexOf("socket.write(");

    expect(guard, `${build} is missing the HOM-421 null-socket guard — is patches/postgres@3.4.9.patch applied?`).toBeGreaterThan(-1);
    expect(guard, `${build}: the HOM-421 guard must precede the socket.write() it protects`).toBeLessThan(write);
  });

  describe("behaviour", () => {
    let restore: (() => void) | undefined;

    afterEach(() => {
      restore?.();
      restore = undefined;
    });

    it("does not crash the process when the socket is torn down mid-write", async () => {
      // A server that accepts and stays silent: the handshake never completes,
      // so the driver's `initial` query stays set — the exact state whose
      // early return in closed() strands a null-socket connection in the pool.
      const server = net.createServer((socket) => socket.on("error", () => {}));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as net.AddressInfo;

      // Vitest turns an uncaughtException into a failure of whichever test is
      // running, which would be confusing here. Capture it and assert instead.
      const uncaught: Error[] = [];
      const onUncaught = (error: Error) => uncaught.push(error);
      const previous = process.listeners("uncaughtException");
      process.removeAllListeners("uncaughtException");
      process.on("uncaughtException", onUncaught);
      restore = () => {
        process.removeListener("uncaughtException", onUncaught);
        for (const listener of previous) process.on("uncaughtException", listener);
      };

      let held: net.Socket | undefined;
      const sql = postgres(`postgres://u:p@127.0.0.1:${port}/db`, {
        max: 1,
        connect_timeout: 30,
        idle_timeout: 0,
        onnotice: () => {},
        socket: () => {
          held = new net.Socket();
          held.connect(port, "127.0.0.1");
          return held as never;
        },
      });

      try {
        void sql`select 1`.catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(held, "driver never asked for a socket — the repro no longer sets up").toBeDefined();

        // 1. 'drain' mid-handshake → pool moves the connection into `open`.
        held!.emit("drain");
        await new Promise((resolve) => setTimeout(resolve, 50));

        // 2. Connection loss → socket = null, and `initial` is still set, so
        //    closed() returns before moving the connection out of `open`.
        held!.emit("close", false);

        // 3. Same tick, inside the reconnect backoff: the pool hands this query
        //    to the null-socket connection. Unpatched, this exits the process.
        void sql`select 2`.catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 400));

        expect(uncaught.map((error) => error.message)).toEqual([]);
      } finally {
        await sql.end({ timeout: 1 }).catch(() => {});
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
