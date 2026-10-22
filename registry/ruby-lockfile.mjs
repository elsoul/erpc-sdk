#!/usr/bin/env node

/*
 * Small, byte-preserving parser for the local Ruby package lock entry.
 *
 * Bundler's PATH section is the only trusted source for the SDK version in a
 * checked-in Gemfile.lock.  A gem with the same name from GEM or GIT is not
 * the package being prepared, so every operation below anchors to the one
 * PATH block whose remote is exactly ".".
 */

const STABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function pathBlock(text) {
  if (typeof text !== "string") return null;
  const headers = [...text.matchAll(/^PATH\r?$/gmu)];
  if (headers.length !== 1) return null;
  const header = headers[0];
  const start = header.index + header[0].length;
  const nextHeader = /^[A-Z][A-Z0-9 _-]*\r?$/mu.exec(text.slice(start));
  const end = nextHeader === null ? text.length : start + nextHeader.index;
  const block = text.slice(start, end);
  const remotes = [...block.matchAll(/^[ \t]{2}remote:[ \t]*([^\r\n]*)\r?$/gmu)];
  if (remotes.length !== 1 || remotes[0][1] !== ".") return null;
  const specs = [...block.matchAll(/^[ \t]{2}specs:\r?$/gmu)];
  if (specs.length !== 1 || remotes[0].index >= specs[0].index) return null;
  const specsStart = start + specs[0].index + specs[0][0].length;
  const entries = [...text.matchAll(/^([ \t]{4}erpc-sdk \()([^()\s]+)(\))\r?$/gmu)];
  // Count every four-space SDK declaration in the lockfile, including a
  // same-named foreign GEM/GIT entry.  A duplicate or malformed declaration
  // must never be hidden by the valid local PATH line.
  const sdkLike = [...text.matchAll(/^[ \t]{4}erpc-sdk(?:[ \t(]|$).*$/gmu)];
  if (entries.length !== 1 || sdkLike.length !== 1 || entries[0].index !== sdkLike[0].index || entries[0].index < specsStart || entries[0].index >= end || !STABLE_VERSION_RE.test(entries[0][2])) return null;
  const entry = entries[0];
  const versionStart = entry.index + entry[1].length;
  return { version: entry[2], versionStart, versionEnd: versionStart + entry[2].length };
}

export function rubyLockVersion(text) {
  return pathBlock(text)?.version ?? null;
}

export function replaceRubyLockVersion(text, version) {
  const match = pathBlock(text);
  if (match === null || typeof version !== "string" || !STABLE_VERSION_RE.test(version)) return null;
  return `${text.slice(0, match.versionStart)}${version}${text.slice(match.versionEnd)}`;
}

export function normalizeRubyLockVersion(text) {
  const match = pathBlock(text);
  if (match === null) return null;
  return `${text.slice(0, match.versionStart)}<VERSION>${text.slice(match.versionEnd)}`;
}
