import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const RELEASE_SCRIPT = new URL("../scripts/release.mjs", import.meta.url);
const FROZEN_HEAD = "1111111111111111111111111111111111111111";

function fakeRunnerFactory() {
  const calls = [];
  let statusChecks = 0;
  let headChecks = 0;
  const runner = (command, args, options = {}) => {
    calls.push({ command, args: [...args], options: { ...options } });
    if (command === "corepack") return { status: 0, stdout: "", stderr: "" };
    if (command !== "git") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "status" && args[1] === "--porcelain") {
      statusChecks += 1;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "branch" && args[1] === "--show-current") return { status: 0, stdout: "main\n", stderr: "" };
    if (args[0] === "fetch") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      headChecks += 1;
      return { status: 0, stdout: `${FROZEN_HEAD}\n`, stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === "origin/main") return { status: 0, stdout: `${FROZEN_HEAD}\n`, stderr: "" };
    if (args[0] === "rev-parse" && args[1] === "--verify") return { status: 1, stdout: "", stderr: "missing" };
    if (args[0] === "ls-remote") return { status: 2, stdout: "", stderr: "missing" };
    if (args[0] === "tag") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "push") return { status: 0, stdout: "", stderr: "" };
    throw new Error(`unexpected fake git call: ${args.join(" ")}`);
  };
  return { runner, calls, get statusChecks() { return statusChecks; }, get headChecks() { return headChecks; } };
}

test("release command is import-safe and exposes the injected runner", async () => {
  const source = await readFile(RELEASE_SCRIPT, "utf8");
  assert.match(source, /export\s+(?:async\s+)?function\s+runRelease\s*\(/u);
  const release = await import(`${RELEASE_SCRIPT.href}?release-command-test=${Date.now()}`);
  assert.equal(typeof release.runRelease, "function");
  assert.equal(typeof release.defaultRunner, "function");
});

test("release command rechecks clean main and frozen HEAD after the long suite", async () => {
  const release = await import(`${RELEASE_SCRIPT.href}?release-command-test-run=${Date.now()}`);
  const fake = fakeRunnerFactory();
  const result = await release.runRelease(["0.6.0"], fake.runner);
  assert.equal(result?.frozenHead ?? result?.head, FROZEN_HEAD);
  assert.ok(fake.statusChecks >= 2, "clean status must be checked before and after release:check");
  assert.ok(fake.headChecks >= 3, "HEAD must be captured and rechecked after release:check");
  const tags = fake.calls.filter(({ command, args }) => command === "git" && args[0] === "tag");
  assert.deepEqual(tags.map(({ args }) => args.slice(0, 4)), [
    ["tag", "-a", "v0.6.0", "-m"],
    ["tag", "-a", "packages/go/v0.6.0", "-m"],
  ]);
  assert.ok(tags.every(({ args }) => args.at(-1) === FROZEN_HEAD), "both annotated tags must target the frozen pre-suite commit");
  const tagHeads = tags.map(({ options }) => options);
  assert.ok(tagHeads.every((options) => options && options.capture !== true), "tag commands must be mutating calls");
  const push = fake.calls.find(({ command, args }) => command === "git" && args[0] === "push");
  assert.deepEqual(push?.args.slice(0, 3), ["push", "--atomic", "origin"]);
});

test("release command refuses a HEAD change after the long suite before tag mutation", async () => {
  const release = await import(`${RELEASE_SCRIPT.href}?release-command-test-moving=${Date.now()}`);
  const fake = fakeRunnerFactory();
  let headReads = 0;
  const movingRunner = (command, args, options) => {
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
      headReads += 1;
      if (headReads >= 2) return { status: 0, stdout: `${"2222222222222222222222222222222222222222"}\n`, stderr: "" };
    }
    return fake.runner(command, args, options);
  };
  await assert.rejects(() => release.runRelease(["0.6.0"], movingRunner), /source changed|expected|origin\/main/u);
  assert.equal(fake.calls.some(({ command, args }) => command === "git" && ["tag", "push"].includes(args[0])), false);
});

test("release command fails before mutation when the checkout is dirty", async () => {
  const release = await import(`${RELEASE_SCRIPT.href}?release-command-test-dirty=${Date.now()}`);
  const fake = fakeRunnerFactory();
  const dirtyRunner = (command, args, options) => {
    if (command === "git" && args[0] === "status") return { status: 0, stdout: " M CHANGELOG.md\n", stderr: "" };
    return fake.runner(command, args, options);
  };
  await assert.rejects(() => release.runRelease(["0.6.0"], dirtyRunner), /clean working tree|dirty/u);
  assert.equal(fake.calls.some(({ command, args }) => command === "git" && ["tag", "push"].includes(args[0])), false);
});
