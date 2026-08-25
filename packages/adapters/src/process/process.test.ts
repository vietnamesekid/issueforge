import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildChildEnvironment,
  currentProcessIdentity,
  isGroupAlive,
  isSameProcess,
  killGroup,
  processStartTime,
  spawnSupervised,
} from './index.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'if-proc-')); });
afterEach(() => {
  killIssuedTags();
  rmSync(dir, { recursive: true, force: true });
});

/** Count real processes matching `sleep <tag>` by exact argv, never `ps | grep -c`. */
function countSleepers(tag: number): number {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' });
  const re = new RegExp(`^\\s*\\d+\\s+(/bin/)?sleep\\s+${tag}\\s*$`);
  return out.split('\n').filter((line) => re.test(line)).length;
}

/** A stand-in for a harness that backgrounds work, as npm test & or a dev server does. */
function writeBackgroundingScript(tag: number): string {
  // Named per tag: a single shared filename would be rewritten by the next test,
  // and a still-running child would then be executing different content.
  const path = join(dir, `harness-${tag}.sh`);
  writeFileSync(path, `#!/bin/sh\nsleep ${tag} &\nsleep ${tag}\n`);
  chmodSync(path, 0o755);
  return path;
}

const settle = (ms = 400): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A `sleep` duration unique to this process and this call.
 *
 * Test files run in parallel workers and each spawns real processes, so a hardcoded
 * duration is a shared global: one file's leftovers get counted by another's
 * assertion — and reused worker pids make a pid-derived base collide too. A random
 * base per module is the only seed that is actually unique here.
 */
/** Every tag handed out here, so afterEach can guarantee nothing outlives the run. */
const issuedTags: number[] = [];
let tagCounter = 0;
const TAG_BASE = 20_000 + Math.floor(Math.random() * 40_000);
const nextTag = (): number => {
  const tag = TAG_BASE + tagCounter++;
  issuedTags.push(tag);
  return tag;
};

/**
 * Kill anything this file spawned.
 *
 * A test that leaves processes behind is a test that pollutes the developer's
 * machine and the next run's counts. Assertions cover the code under test; this
 * covers the cases where an assertion failed before its own cleanup could run.
 */
function killIssuedTags(): void {
  for (const tag of issuedTags) {
    try {
      execFileSync('pkill', ['-f', `sleep ${tag}`], { stdio: 'ignore' });
    } catch {
      // pkill exits non-zero when nothing matched, which is the expected case.
    }
  }
}

/**
 * Wait until no process matches `sleep <tag>`, or fail loudly after `timeoutMs`.
 *
 * Polling beats a fixed sleep here: process teardown is asynchronous at the OS level,
 * so a constant delay is either flaky when the machine is loaded or wasteful when it
 * is not. It also keeps one test's leftovers from being counted by the next.
 */
/**
 * Wait until the spawned tree is actually running.
 *
 * A fixed delay is a guess about scheduler latency: too short and the assertion runs
 * before the shell has forked, too long and every test pays for it. Polling for the
 * condition removes the guess.
 */
async function expectSleepers(tag: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countSleepers(tag) > 0) return;
    await settle(50);
  }
  expect(countSleepers(tag), `no process matching "sleep ${tag}" ever started`).toBeGreaterThan(0);
}

async function expectNoSleepers(tag: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countSleepers(tag) === 0) return;
    await settle(50);
  }
  expect(countSleepers(tag), `processes matching "sleep ${tag}" survived`).toBe(0);
}

describe('process identity', () => {
  it('reports a start time for a live process and null for a dead one', () => {
    expect(processStartTime(process.pid)).toBeTruthy();
    // PID 1 exists; a very high pid almost certainly does not.
    expect(processStartTime(0x7ffffff)).toBeNull();
  });

  it('distinguishes a recycled PID from the original process', () => {
    // This is what stops the reaper killing an innocent bystander: a new process
    // inheriting a dead supervisor's pid has a different start time.
    const me = currentProcessIdentity();
    expect(isSameProcess(me.pid, me.startedAt)).toBe(true);
    expect(isSameProcess(me.pid, 'Mon Jan  1 00:00:00 2001')).toBe(false);
  });
});

describe('child environment', { timeout: 20_000 }, () => {
  it('forwards only the allowlist, never the ambient environment', () => {
    process.env['IF_TEST_LEAK'] = 'should-not-appear';
    try {
      const env = buildChildEnvironment();
      expect(env['PATH']).toBeTruthy();
      expect(env['IF_TEST_LEAK']).toBeUndefined();
      expect(Object.keys(env).length).toBeLessThan(10);
    } finally {
      delete process.env['IF_TEST_LEAK'];
    }
  });

  it('refuses credential-shaped names even if the allowlist asks for them', () => {
    // A widened allowlist must not be able to admit a credential by accident.
    process.env['MY_SECRET_TOKEN'] = 'ghp_leak';
    try {
      const env = buildChildEnvironment({ allow: ['PATH', 'MY_SECRET_TOKEN'] });
      expect(env['MY_SECRET_TOKEN']).toBeUndefined();
    } finally {
      delete process.env['MY_SECRET_TOKEN'];
    }
  });

  it('still allows a credential the caller names deliberately', () => {
    // A harness may legitimately need an API key; that is the caller's decision.
    const env = buildChildEnvironment({ extra: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-test');
  });

  it('the spawned environment contains no token, key or secret', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_must_not_reach_the_child';
    try {
      const child = spawnSupervised('sh', ['-c', 'env'], { cwd: dir });
      const seen: string[] = [];
      for await (const line of child.lines()) seen.push(line);
      await child.wait();

      const dump = seen.join('\n');
      expect(dump).not.toContain('ghp_must_not_reach_the_child');
      expect(dump).not.toMatch(/^(?!PATH).*(?:TOKEN|SECRET|PASSWORD)=/m);
    } finally {
      delete process.env['GITHUB_TOKEN'];
    }
  });
});

// These spawn real processes and poll the OS for their disappearance, which the 5s
// default does not comfortably allow for. A test that dies mid-assertion also leaves
// its children behind, which then pollutes the next test's count.
describe('supervised process', { timeout: 20_000 }, () => {
  it('streams interleaved output line by line', async () => {
    const child = spawnSupervised('sh', ['-c', 'echo one; echo two >&2; echo three'], { cwd: dir });
    const lines: string[] = [];
    for await (const line of child.lines()) lines.push(line);

    const result = await child.wait();
    expect(result.reason).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(lines).toEqual(expect.arrayContaining(['one', 'two', 'three']));
  });

  it('reports a non-zero exit as an outcome, not an exception', async () => {
    // Harnesses fail. "Ran and said no" is different from "never ran", and only the
    // caller can decide what each means.
    const child = spawnSupervised('sh', ['-c', 'exit 3'], { cwd: dir });
    const result = await child.wait();
    expect(result.reason).toBe('completed');
    expect(result.exitCode).toBe(3);
  });

  it('is a process-group leader, so termination can reach descendants', async () => {
    const tag = nextTag();
    const child = spawnSupervised(writeBackgroundingScript(tag), [], { cwd: dir });
    await expectSleepers(tag);

    const pgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(child.pgid)], { encoding: 'utf8' }).trim();
    expect(Number(pgid)).toBe(child.pgid);

    child.terminate();
    await child.wait();
    await expectNoSleepers(tag);
  });

  it('terminate() leaves no survivor, including backgrounded children', async () => {
    // The acceptance criterion. A harness that runs `sleep &` leaves a child that
    // killing only the leader would not reach.
    const tag = nextTag();
    const child = spawnSupervised(writeBackgroundingScript(tag), [], { cwd: dir });
    await expectSleepers(tag);

    child.terminate();
    await child.wait();

    await expectNoSleepers(tag);
  });

  it('times out and takes the whole tree with it', async () => {
    const tag = nextTag();
    const started = Date.now();
    const child = spawnSupervised(writeBackgroundingScript(tag), [], { cwd: dir, timeoutMs: 700 });

    const result = await child.wait();
    const elapsed = Date.now() - started;

    expect(result.reason).toBe('timeout');
    expect(elapsed).toBeLessThan(5_000);
    await expectNoSleepers(tag);
  });

  it('cancels via AbortSignal', async () => {
    const tag = nextTag();
    const controller = new AbortController();
    const child = spawnSupervised(writeBackgroundingScript(tag), [], {
      cwd: dir,
      signal: controller.signal,
    });
    await expectSleepers(tag);

    controller.abort();
    const result = await child.wait();
    child.terminate();

    expect(result.reason).toBe('cancelled');
    await expectNoSleepers(tag);
  });

  it('hands the caller ownership to persist before the run starts', async () => {
    // Persisted BEFORE awaiting: a supervisor killed mid-run cannot write this
    // afterwards, and without it the group would be unreapable.
    const child = spawnSupervised('sh', ['-c', 'exit 0'], { cwd: dir });
    const me = currentProcessIdentity();

    expect(child.ownership.pgid).toBe(child.pgid);
    expect(child.ownership.ownerPid).toBe(me.pid);
    expect(child.ownership.ownerStart).toBe(me.startedAt);

    await child.wait();
  });

  it('settles even when killed by something that never awaited it', async () => {
    // The reaper terminates orphaned groups by pgid, and timeouts fire on their own —
    // neither awaits the process. execa rejects on a signalled exit, so if that
    // rejection were left for the caller it would surface as an unhandled rejection
    // on the ordinary "process was killed" path.
    const tag = nextTag();
    const child = spawnSupervised(writeBackgroundingScript(tag), [], { cwd: dir });
    await expectSleepers(tag);

    // Kill the group directly, exactly as the reaper does, without awaiting first.
    killGroup(child.pgid);

    const result = await child.wait();
    // `terminated`, not `error`: being signalled is routine here, and reporting the
    // reaper's own cleanup as a fault would be actively misleading.
    expect(result.reason).toBe('terminated');
    expect(result.signal).toBe('SIGTERM');
    await expectNoSleepers(tag);
  });

  it('wait() can be called more than once and reports the same outcome', async () => {
    const child = spawnSupervised('sh', ['-c', 'exit 7'], { cwd: dir });
    const [a, b] = await Promise.all([child.wait(), child.wait()]);
    expect(a).toEqual(b);
    expect(a.exitCode).toBe(7);
  });

  it('does not interpret shell metacharacters in arguments', async () => {
    // Issue text reaches commands as data. argv with no shell makes $(...) inert.
    const child = spawnSupervised('echo', ['$(touch /tmp/if-pwned) `id`; rm -rf /'], { cwd: dir });
    const lines: string[] = [];
    for await (const line of child.lines()) lines.push(line);
    await child.wait();

    expect(lines.join('')).toContain('$(touch /tmp/if-pwned)');
  });
});

describe('group liveness', { timeout: 20_000 }, () => {
  it('sees a live group and stops seeing it once gone', async () => {
    const tag = nextTag();
    const child = spawnSupervised(writeBackgroundingScript(tag), [], { cwd: dir });
    await expectSleepers(tag);
    expect(isGroupAlive(child.pgid)).toBe(true);

    child.terminate();
    await child.wait();
    await expectNoSleepers(tag);
    expect(isGroupAlive(child.pgid)).toBe(false);
  });
});
