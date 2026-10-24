// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0 AND BSD-3-Clause
//
// This file is an adapted and modified handwritten bounded TypeScript
// projection of the Mysten Labs Sui RPC v2 schema. It is limited to the three
// read-only unary methods implemented by this SDK, omits unrelated schema
// fields, and is pinned to commit aa9ba2c13b2a9348059b38110e64af39849a0377.
// Adapted source paths:
//   proto/sui/rpc/v2/ledger_service.proto
//   proto/sui/rpc/v2/state_service.proto
//   proto/sui/rpc/v2/object.proto
//   proto/google/protobuf/timestamp.proto
// The codec mechanics are handwritten and dependency-free; this is not an
// upstream generated file.

// Protocol Buffers - Google's data interchange format
// Copyright 2008 Google Inc.  All rights reserved.
// https://developers.google.com/protocol-buffers/
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//     * Redistributions of source code must retain the above copyright
// notice, this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above
// copyright notice, this list of conditions and the following disclaimer
// in the documentation and/or other materials provided with the
// distribution.
//     * Neither the name of Google Inc. nor the names of its
// contributors may be used to endorse or promote products derived from
// this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

import { ErpcConfigError, ErpcInvalidResponseError } from '../errors'

export const SUI_REQUEST_LIMIT = 1_048_576
export const SUI_RESPONSE_LIMIT = 8 * 1024 * 1024
export const SUI_TRAILER_LIMIT = 8 * 1024

const MAX_U64 = 18_446_744_073_709_551_615n
const MAX_I64 = (1n << 63n) - 1n
const MAX_DEPTH = 100

const invalid = (): ErpcInvalidResponseError => new ErpcInvalidResponseError('Sui protobuf response is invalid')

const encodeVarint = (value: bigint): number[] => {
  if (value < 0n || value > MAX_U64) throw new ErpcConfigError('Sui integer is out of range')
  const bytes: number[] = []
  do {
    const next = Number(value & 0x7fn)
    value >>= 7n
    bytes.push(value === 0n ? next : next | 0x80)
  } while (value !== 0n)
  return bytes
}

const appendKey = (output: number[], field: number, wire: number): void => {
  output.push(...encodeVarint(BigInt((field << 3) | wire)))
}

const appendBytes = (output: number[], field: number, bytes: Uint8Array): void => {
  const key = encodeVarint(BigInt((field << 3) | 2))
  const length = encodeVarint(BigInt(bytes.byteLength))
  if (output.length + key.length + length.length + bytes.byteLength > SUI_REQUEST_LIMIT - 5) {
    throw new ErpcConfigError('Sui request exceeds 1 MiB')
  }
  output.push(...key, ...length)
  for (const byte of bytes) output.push(byte)
}

const appendString = (output: number[], field: number, value: string): void => {
  appendBytes(output, field, new TextEncoder().encode(value))
}

const appendU64 = (output: number[], field: number, value: bigint): void => {
  if (value < 0n || value > MAX_U64) throw new ErpcConfigError('Sui integer is out of range')
  appendKey(output, field, 0)
  output.push(...encodeVarint(value))
}

const frameRequest = (payload: Uint8Array): Uint8Array => {
  const frameLength = payload.byteLength + 5
  if (frameLength > SUI_REQUEST_LIMIT) throw new ErpcConfigError('Sui request exceeds 1 MiB')
  const frame = new Uint8Array(frameLength)
  frame[0] = 0
  new DataView(frame.buffer).setUint32(1, payload.byteLength, false)
  frame.set(payload, 5)
  return frame
}

function validateInput(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new ErpcConfigError(`Sui ${label} is invalid`)
  }
  if (value.length === 0) throw new ErpcConfigError(`Sui ${label} is invalid`)
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) throw new ErpcConfigError(`Sui ${label} is invalid`)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        throw new ErpcConfigError(`Sui ${label} is invalid`)
      }
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new ErpcConfigError(`Sui ${label} is invalid`)
    }
  }
}

export const encodeGetServiceInfoRequest = (): Uint8Array => frameRequest(new Uint8Array())

export const encodeGetObjectRequest = (objectId: string, version?: bigint): Uint8Array => {
  validateInput(objectId, 'object ID')
  const payload: number[] = []
  appendString(payload, 1, objectId)
  if (version !== undefined) appendU64(payload, 2, version)
  return frameRequest(Uint8Array.from(payload))
}

export const encodeGetBalanceRequest = (owner: string, coinType: string): Uint8Array => {
  validateInput(owner, 'owner')
  validateInput(coinType, 'coin type')
  const payload: number[] = []
  appendString(payload, 1, owner)
  appendString(payload, 2, coinType)
  return frameRequest(Uint8Array.from(payload))
}

class Reader {
  readonly #bytes: Uint8Array
  #offset = 0
  #depth = 0

  constructor(bytes: Uint8Array, depth = 0) {
    this.#bytes = bytes
    this.#depth = depth
  }

  get done(): boolean { return this.#offset === this.#bytes.byteLength }

  key(): { readonly field: number; readonly wire: number } {
    const key = this.varint()
    const field = Number(key >> 3n)
    const wire = Number(key & 7n)
    if (field <= 0 || field > 0x1fffffff || wire === 6 || wire === 7) throw invalid()
    return { field, wire }
  }

  varint(): bigint {
    let value = 0n
    for (let index = 0; index < 10; index += 1) {
      if (this.#offset >= this.#bytes.byteLength) throw invalid()
      const byte = this.#bytes[this.#offset++]!
      if (index === 9 && byte > 1) throw invalid()
      value |= BigInt(byte & 0x7f) << BigInt(index * 7)
      if ((byte & 0x80) === 0) return value
    }
    throw invalid()
  }

  lengthDelimited(): Uint8Array {
    const length = this.varint()
    if (length > BigInt(this.#bytes.byteLength - this.#offset)) throw invalid()
    const end = this.#offset + Number(length)
    const result = this.#bytes.slice(this.#offset, end)
    this.#offset = end
    return result
  }

  string(): string {
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.lengthDelimited())
    } catch { throw invalid() }
  }

  skip(wire: number, field: number): void {
    if (wire === 4) throw invalid()
    if (wire === 0) { this.varint(); return }
    if (wire === 1) { this.skipBytes(8); return }
    if (wire === 2) { this.lengthDelimited(); return }
    if (wire === 3) {
      this.#depth += 1
      if (this.#depth > MAX_DEPTH) throw invalid()
      try {
        while (true) {
          const key = this.key()
          if (key.wire === 4) {
            if (key.field !== field) throw invalid()
            return
          }
          this.skip(key.wire, key.field)
        }
      } finally { this.#depth -= 1 }
    }
    if (wire === 5) { this.skipBytes(4); return }
    throw invalid()
  }

  nested<T>(decode: (reader: Reader) => T): T {
    const depth = this.#depth + 1
    if (depth > MAX_DEPTH) throw invalid()
    const child = new Reader(this.lengthDelimited(), depth)
    const result = decode(child)
    if (!child.done) throw invalid()
    return result
  }

  skipBytes(length: number): void {
    if (length < 0 || this.#offset + length > this.#bytes.byteLength) throw invalid()
    this.#offset += length
  }
}

const requireWire = (actual: number, expected: number): void => { if (actual !== expected) throw invalid() }

const signedI64 = (value: bigint): bigint => value > MAX_I64 ? value - (1n << 64n) : value
const signedI32 = (value: bigint): number => {
  const lower = Number(value & 0xffffffffn)
  return lower >= 0x80000000 ? lower - 0x100000000 : lower
}

export interface SuiTimestampWire { seconds: bigint; nanos: number }
export interface SuiServiceInfoWire { chainId: string; chain: string; epoch: bigint; checkpointHeight: bigint; timestamp: SuiTimestampWire; lowestAvailableCheckpoint: bigint; lowestAvailableCheckpointObjects: bigint; server?: string }
export interface SuiObjectSummaryWire { objectId: string; version: bigint; digest: string }
export interface SuiBalanceWire { coinType: string; balance: bigint; addressBalance: bigint; coinBalance: bigint }

const decodeTimestamp = (reader: Reader): Partial<SuiTimestampWire> => {
  const result: Partial<SuiTimestampWire> = {}
  while (!reader.done) {
    const { field, wire } = reader.key()
    if (field === 1) { requireWire(wire, 0); result.seconds = signedI64(reader.varint()) }
    else if (field === 2) { requireWire(wire, 0); result.nanos = signedI32(reader.varint()) }
    else reader.skip(wire, field)
  }
  return result
}

const decodeServiceInfo = (reader: Reader): SuiServiceInfoWire => {
  const result: Partial<SuiServiceInfoWire> = {}
  while (!reader.done) {
    const { field, wire } = reader.key()
    if (field === 1) { requireWire(wire, 2); result.chainId = reader.string() }
    else if (field === 2) { requireWire(wire, 2); result.chain = reader.string() }
    else if (field === 3) { requireWire(wire, 0); result.epoch = reader.varint() }
    else if (field === 4) { requireWire(wire, 0); result.checkpointHeight = reader.varint() }
    else if (field === 5) {
      requireWire(wire, 2)
      const next = reader.nested(decodeTimestamp)
      const current: Partial<SuiTimestampWire> = result.timestamp ?? {}
      result.timestamp = { ...current, ...next, seconds: next.seconds ?? current.seconds ?? 0n, nanos: next.nanos ?? current.nanos ?? 0 }
    }
    else if (field === 6) { requireWire(wire, 0); result.lowestAvailableCheckpoint = reader.varint() }
    else if (field === 7) { requireWire(wire, 0); result.lowestAvailableCheckpointObjects = reader.varint() }
    else if (field === 8) { requireWire(wire, 2); result.server = reader.string() }
    else reader.skip(wire, field)
  }
  if (result.chainId === undefined || result.chain === undefined || result.epoch === undefined || result.checkpointHeight === undefined || result.timestamp === undefined || result.lowestAvailableCheckpoint === undefined || result.lowestAvailableCheckpointObjects === undefined) throw invalid()
  if (result.timestamp.nanos < 0 || result.timestamp.nanos >= 1_000_000_000) throw invalid()
  return result as SuiServiceInfoWire
}

const decodeObject = (reader: Reader): Partial<SuiObjectSummaryWire> => {
  const result: Partial<SuiObjectSummaryWire> = {}
  while (!reader.done) {
    const { field, wire } = reader.key()
    if (field === 2) { requireWire(wire, 2); result.objectId = reader.string() }
    else if (field === 3) { requireWire(wire, 0); result.version = reader.varint() }
    else if (field === 4) { requireWire(wire, 2); result.digest = reader.string() }
    else reader.skip(wire, field)
  }
  return result
}

const decodeObjectEnvelope = (reader: Reader): SuiObjectSummaryWire => {
  let object: Partial<SuiObjectSummaryWire> = {}
  while (!reader.done) {
    const { field, wire } = reader.key()
    if (field === 1) {
      requireWire(wire, 2)
      const next = reader.nested(decodeObject)
      object = { ...object, ...next }
    } else reader.skip(wire, field)
  }
  if (object.objectId === undefined || object.version === undefined || object.digest === undefined) throw invalid()
  return object as SuiObjectSummaryWire
}

const decodeBalance = (reader: Reader): Partial<SuiBalanceWire> => {
  const result: Partial<SuiBalanceWire> = {}
  while (!reader.done) {
    const { field, wire } = reader.key()
    if (field === 1) { requireWire(wire, 2); result.coinType = reader.string() }
    else if (field === 3) { requireWire(wire, 0); result.balance = reader.varint() }
    else if (field === 4) { requireWire(wire, 0); result.addressBalance = reader.varint() }
    else if (field === 5) { requireWire(wire, 0); result.coinBalance = reader.varint() }
    else reader.skip(wire, field)
  }
  return result
}

const decodeBalanceEnvelope = (reader: Reader): SuiBalanceWire => {
  let balance: Partial<SuiBalanceWire> = {}
  while (!reader.done) {
    const { field, wire } = reader.key()
    if (field === 1) {
      requireWire(wire, 2)
      const next = reader.nested(decodeBalance)
      balance = { ...balance, ...next }
    } else reader.skip(wire, field)
  }
  if (balance.coinType === undefined || balance.balance === undefined || balance.addressBalance === undefined || balance.coinBalance === undefined) throw invalid()
  if (balance.addressBalance + balance.coinBalance !== balance.balance) throw invalid()
  return balance as SuiBalanceWire
}

export const decodeServiceInfoResponse = (payload: Uint8Array): SuiServiceInfoWire => decodeServiceInfo(new Reader(payload))
export const decodeObjectResponse = (payload: Uint8Array): SuiObjectSummaryWire => decodeObjectEnvelope(new Reader(payload))
export const decodeBalanceResponse = (payload: Uint8Array): SuiBalanceWire => decodeBalanceEnvelope(new Reader(payload))
