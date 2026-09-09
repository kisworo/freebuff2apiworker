// Local unit test for the zombie-lease AbortSignal fix.
//
// In-process mock of the Freebuff upstream. Sessions stay "queued" while
// `hang` is true (simulating a slow upstream), and become "active" once the
// test flips `hang` off — this lets abandoned acquisitions settle so the test
// is fully deterministic.
//
// Run with: bun run test_pool.ts
import { CodebuffAccountPool } from "./src/codebuff";

const MOCK_PORT = 7399;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;

let hang = true;

Bun.serve({
  port: MOCK_PORT,
  fetch(req: Request) {
    const url = new URL(req.url);
    if (url.pathname === "/api/v1/freebuff/session") {
      if (hang) {
        return Response.json({ status: "queued", position: 1, estimatedWaitMs: 100, instanceId: "mock-instance" });
      }
      return Response.json({
        status: "active",
        instanceId: "mock-instance",
        model: "meta/muse-spark-1.3-contributor",
        remainingMs: 300000,
      });
    }
    return Response.json({ ok: true, path: url.pathname });
  },
});

const env: any = {
  FREEBUFF_TOKEN: "mock-token-1",
  CODEBUFF_API_URL: MOCK_URL,
  FREEBUFF_TIMEOUT: "300", // poll long enough for the test window
  FREEBUFF_AD_PROVIDERS: "", // skip ad chain
  FREEBUFF_DEBUG: "false",
  CLIENT_ID: "local-test",
  REQUEST_JITTER_MS: "0",
};

const pool = new CodebuffAccountPool(env);
console.log(`[test] pool initialized with accounts=${pool.accountCount}`);

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const ABORT_MSG = "Session acquisition aborted";

function expectAbortReject(p: Promise<any>, label: string): Promise<{ ok: boolean; msg: string }> {
  return p.then(
    () => ({ ok: false, msg: `${label}: expected abort rejection but it RESOLVED` }),
    (e: any) => {
      const msg = e?.message || String(e);
      if (msg.includes(ABORT_MSG) || e?.status_code === 504) {
        return { ok: true, msg: `${label}: rejected correctly → "${msg}"` };
      }
      return { ok: false, msg: `${label}: rejected with UNEXPECTED error → "${msg}"` };
    }
  );
}

async function main() {
  let pass = 0;
  let fail = 0;
  const report = (ok: boolean, msg: string) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${msg}`);
    ok ? pass++ : fail++;
  };

  // ============ T1: abort while session acquisition is in-flight ============
  hang = true;
  const ac1 = new AbortController();
  const p1 = pool.acquireSession("meta/muse-spark-1.3-contributor", [], "meta/muse-spark-1.3-contributor", ac1.signal);
  await sleep(1500); // it has reserved the account and is polling the queued session
  ac1.abort();       // caller times out → signal aborts
  hang = false;      // let the abandoned acquisition settle so p1 can reject
  const r1 = await expectAbortReject(p1, "T1 abort mid-acquisition");
  report(r1.ok, r1.msg);

  // ============ T2: account must be free again (no 429, no zombie) ==========
  // With the model-pool path, a still-busy account throws "All assigned
  // accounts busy". A fresh acquire must instead reserve + resolve.
  let busyThrow = false;
  const ac2 = new AbortController();
  const p2 = pool
    .acquireSession("meta/muse-spark-1.3-contributor", [], "meta/muse-spark-1.3-contributor", ac2.signal)
    .catch((e: any) => {
      if (String(e?.message || e).includes("All assigned accounts busy")) busyThrow = true;
      throw e;
    });
  const t2 = await Promise.race([
    p2.then(lease => ({ kind: "resolved" as const, lease })),
    sleep(4000).then(() => ({ kind: "timeout" as const })),
  ]);
  report(!busyThrow && t2.kind === "resolved", "T2 account released after abort — fresh acquire reserved (no 429, no hang)");
  if (t2.kind === "resolved") await t2.lease.release();
  else ac2.abort();

  // ============ T3: queued waiter removed from waitingQueue on abort ============
  hang = true;
  const ac3 = new AbortController();
  const p3 = pool.acquireSession("meta/muse-spark-1.3-contributor", [], "meta/muse-spark-1.3-contributor", ac3.signal); // holds the only account
  await sleep(1200);

  const ac4 = new AbortController();
  const p4 = pool.acquireSession("meta/muse-spark-1.3-contributor", [], "meta/muse-spark-1.3-contributor", ac4.signal); // queues behind p3
  await sleep(800);
  ac4.abort();
  const r4 = await expectAbortReject(p4, "T3a abort queued waiter");
  report(r4.ok, r4.msg);

  ac3.abort();
  hang = false;
  const r3 = await expectAbortReject(p3, "T3b account holder released on abort");
  report(r3.ok, r3.msg);

  // ============ T4: no zombie after aborts — fresh acquire resolves fast ============
  const ac5 = new AbortController();
  const t0 = Date.now();
  const p5 = pool.acquireSession("meta/muse-spark-1.3-contributor", [], "meta/muse-spark-1.3-contributor", ac5.signal);
  const t4 = await Promise.race([
    p5.then(lease => ({ kind: "resolved" as const, lease })),
    sleep(2500).then(() => ({ kind: "timeout" as const })),
  ]);
  report(t4.kind === "resolved", `T4 no zombie — fresh acquire reserved in ${Date.now() - t0}ms`);
  if (t4.kind === "resolved") await t4.lease.release();
  else ac5.abort();

  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => {
  console.error("[test] harness error", e);
  process.exit(1);
});
