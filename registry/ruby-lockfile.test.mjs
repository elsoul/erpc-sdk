import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeRubyLockVersion,
  replaceRubyLockVersion,
  rubyLockVersion,
} from "./ruby-lockfile.mjs";

const VALID = `PATH\n  remote: .\n  specs:\n    erpc-sdk (0.6.0)\n\nGEM\n  remote: https://rubygems.org/\n  specs:\n    minitest (5.27.0)\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  erpc-sdk!\n`;

test("reads and replaces exactly the local PATH erpc-sdk version", () => {
  assert.equal(rubyLockVersion(VALID), "0.6.0");
  const replaced = replaceRubyLockVersion(VALID, "1.0.1");
  assert.equal(replaced, VALID.replace("erpc-sdk (0.6.0)", "erpc-sdk (1.0.1)"));
  assert.equal(normalizeRubyLockVersion(VALID), VALID.replace("erpc-sdk (0.6.0)", "erpc-sdk (<VERSION>)"));
  assert.equal(replaceRubyLockVersion(VALID, "01.0.1"), null);
  assert.equal(replaceRubyLockVersion(VALID, "1.0.1-beta.1"), null);
});

test("preserves every byte outside the anchored version", () => {
  const source = VALID.replaceAll("\n", "\r\n").replace("minitest (5.27.0)", "minitest (5.27.0)  \r");
  const replaced = replaceRubyLockVersion(source, "0.6.1");
  assert.equal(replaced.slice(0, replaced.indexOf("0.6.1")), source.slice(0, source.indexOf("0.6.0")));
  assert.equal(replaced.slice(replaced.indexOf("0.6.1") + "0.6.1".length), source.slice(source.indexOf("0.6.0") + "0.6.0".length));
});

test("rejects missing, foreign, ambiguous, duplicate, and malformed local specs", () => {
  const cases = [
    VALID.replace("PATH\n", ""),
    VALID.replace("remote: .", "remote: https://rubygems.org/"),
    `${VALID}PATH\n  remote: .\n  specs:\n    erpc-sdk (0.6.0)\n`,
    VALID.replace("erpc-sdk (0.6.0)", "erpc-sdk (0.6.0)\n    erpc-sdk (0.6.1)"),
    VALID.replace("erpc-sdk (0.6.0)", "other-sdk (0.6.0)"),
    VALID.replace("erpc-sdk (0.6.0)", "erpc-sdk (01.0.0)"),
    VALID.replace("  remote: .\n  specs:", "  specs:").replace("  specs:", "  specs:\n  remote: ."),
  ];
  for (const source of cases) {
    assert.equal(rubyLockVersion(source), null);
    assert.equal(replaceRubyLockVersion(source, "1.0.1"), null);
    assert.equal(normalizeRubyLockVersion(source), null);
  }
});

test("foreign GEM entries cannot create an ambiguous SDK lock identity", () => {
  const source = VALID.replace("    minitest (5.27.0)", "    erpc-sdk (9.9.9)\n    minitest (5.27.0)");
  assert.equal(rubyLockVersion(source), null);
  assert.equal(replaceRubyLockVersion(source, "1.0.1"), null);
  assert.equal(normalizeRubyLockVersion(source), null);
});
