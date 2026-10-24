import { describe, expect, it } from 'vitest'
import {
  ErpcAbortedError,
  ErpcConfigError,
  ErpcInvalidResponseError,
  SUI_GRPC_WEB_CONTENT_TYPE,
  SUI_GRPC_WEB_METHODS,
  createErpcClient,
} from '../src'
import { createSuiClient } from '../src/rpc/sui'
import { SuiGrpcWebTransport } from '../src/transport/sui-grpc-web'
import { encodeGetObjectRequest } from '../src/transport/sui-proto'

const varint = (value: bigint): number[] => {
  const result: number[] = []
  do {
    const byte = Number(value & 0x7fn)
    value >>= 7n
    result.push(value === 0n ? byte : byte | 0x80)
  } while (value !== 0n)
  return result
}

const fieldVarint = (field: number, value: bigint): number[] => [
  ...varint(BigInt(field << 3)),
  ...varint(value),
]

const fieldVarintBytes = (field: number, bytes: number[]): number[] => [
  ...varint(BigInt(field << 3)),
  ...bytes,
]

const fieldString = (field: number, value: string): number[] => {
  const bytes = new TextEncoder().encode(value)
  return [...varint(BigInt((field << 3) | 2)), ...varint(BigInt(bytes.byteLength)), ...bytes]
}

const fieldMessage = (field: number, value: number[]): number[] => [
  ...varint(BigInt((field << 3) | 2)),
  ...varint(BigInt(value.length)),
  ...value,
]

const frame = (payload: number[], trailerText = 'grpc-status: 0\r\n'): Uint8Array => {
  const trailer = new TextEncoder().encode(trailerText)
  const result = new Uint8Array(5 + payload.length + 5 + trailer.length)
  result[0] = 0
  new DataView(result.buffer).setUint32(1, payload.length, false)
  result.set(payload, 5)
  result[5 + payload.length] = 0x80
  new DataView(result.buffer).setUint32(6 + payload.length, trailer.length, false)
  result.set(trailer, 10 + payload.length)
  return result
}

const serviceInfoWithTimestampFragments = (fragments: number[][]): number[] => [
  ...fieldString(1, 'genesis'),
  ...fieldString(2, 'mainnet'),
  ...fieldVarint(3, 7n),
  ...fieldVarint(4, 9n),
  ...fragments.flatMap((fragment) => fieldMessage(5, fragment)),
  ...fieldVarint(6, 0n),
  ...fieldVarint(7, 10n),
  ...fieldString(8, 'sui-node'),
  ...fieldVarint(9, 5n),
]

const serviceInfoPayload = (): number[] => serviceInfoWithTimestampFragments([
  [...fieldVarint(1, 123n), ...fieldVarint(2, 4n)],
])

const objectPayloadWithGroups = (count: number): number[] => [
  ...fieldMessage(1, [
    ...fieldString(2, ''),
    ...fieldVarint(3, 0n),
    ...fieldString(4, ''),
    ...Array.from({ length: count }, () => 0x4b),
    ...Array.from({ length: count }, () => 0x4c),
  ]),
]

const objectResponsePayload = (): number[] => [
  ...fieldMessage(1, [
    ...fieldString(2, 'id'),
    ...fieldVarint(3, 0n),
    ...fieldString(4, 'digest'),
  ]),
]

const balanceResponsePayload = (): number[] => [
  ...fieldMessage(1, [
    ...fieldString(1, '0x2::sui::SUI'),
    ...fieldVarint(3, 3n),
    ...fieldVarint(4, 1n),
    ...fieldVarint(5, 2n),
  ]),
]

const signedVarint = (value: bigint): number[] =>
  varint(value < 0n ? value + (1n << 64n) : value)

describe('Sui bounded gRPC-Web facade', () => {
  it('sends exact unary paths and decodes the three typed reads', async () => {
    const requests: Array<{ url: string; body: Uint8Array; headers: Headers }> = []
    const transport = new SuiGrpcWebTransport({
      direct: true,
      endpoint: new URL('https://sui.example/prefix%2Ftenant?token=a%2Fb'),
      headers: { authorization: 'Bearer direct-secret', 'x-scope': 'sui-only' },
      timeoutMs: 1000,
      fetch: async (input, init) => {
        const url = String(input)
        const body = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer())
        requests.push({ url, body, headers: new Headers(init?.headers) })
        const path = new URL(url).pathname
        const payload = path.endsWith('GetServiceInfo')
          ? serviceInfoPayload()
          : path.endsWith('GetObject')
            ? [
                ...fieldMessage(1, fieldVarint(3, 2n)),
                ...fieldMessage(1, fieldString(2, '0xobject')),
                ...fieldMessage(1, fieldString(4, 'digest')),
              ]
            : [
                ...fieldMessage(1, fieldVarint(3, 30n)),
                ...fieldMessage(1, fieldString(1, '0x2::sui::SUI')),
                ...fieldMessage(1, fieldVarint(4, 10n)),
                ...fieldMessage(1, fieldVarint(5, 20n)),
              ]
        return new Response(frame(payload) as unknown as BodyInit, {
          status: 200,
          headers: { 'content-type': SUI_GRPC_WEB_CONTENT_TYPE },
        })
      },
    })
    const grpc = createSuiClient(transport).grpc
    expect(SUI_GRPC_WEB_METHODS).toEqual([
      '/sui.rpc.v2.LedgerService/GetServiceInfo',
      '/sui.rpc.v2.LedgerService/GetObject',
      '/sui.rpc.v2.StateService/GetBalance',
    ])
    const info = await grpc.getServiceInfo().send()
    const object = await grpc.getObject('0xobject', 0n).send()
    const balance = await grpc.getBalance('0xowner', '0x2::sui::SUI').send()
    expect(info).toEqual({
      chainId: 'genesis',
      chain: 'mainnet',
      epoch: 7n,
      checkpointHeight: 9n,
      timestampSeconds: 123n,
      timestampNanos: 4,
      lowestAvailableCheckpoint: 0n,
      lowestAvailableCheckpointObjects: 10n,
      server: 'sui-node',
    })
    expect(Object.isFrozen(info)).toBe(true)
    expect(object).toEqual({ objectId: '0xobject', version: 2n, digest: 'digest' })
    expect(balance).toEqual({
      coinType: '0x2::sui::SUI',
      balance: 30n,
      addressBalance: 10n,
      coinBalance: 20n,
    })
    expect(requests.map(({ url }) => url)).toEqual([
      'https://sui.example/prefix%2Ftenant/sui.rpc.v2.LedgerService/GetServiceInfo?token=a%2Fb',
      'https://sui.example/prefix%2Ftenant/sui.rpc.v2.LedgerService/GetObject?token=a%2Fb',
      'https://sui.example/prefix%2Ftenant/sui.rpc.v2.StateService/GetBalance?token=a%2Fb',
    ])
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer direct-secret')
    expect(requests[0]?.headers.get('x-scope')).toBe('sui-only')
    expect(requests[0]?.headers.get('content-type')).toBe(SUI_GRPC_WEB_CONTENT_TYPE)
    expect(requests[0]?.body).toEqual(new Uint8Array([0, 0, 0, 0, 0]))
    expect(Array.from(requests[1]?.body.slice(5) ?? [])).toContain(0x10)
    expect(Array.from(encodeGetObjectRequest('0xobject').slice(5))).not.toContain(0x10)
  })

  it('rejects pre-aborted calls before fetch and rejects malformed framing', async () => {
    let fetchCount = 0
    const transport = new SuiGrpcWebTransport({
      direct: true,
      endpoint: new URL('https://sui.example/prefix'),
      headers: {},
      timeoutMs: 1000,
      fetch: async () => {
        fetchCount += 1
        return new Response(new Uint8Array([0]) as unknown as BodyInit, { status: 200, headers: { 'content-type': SUI_GRPC_WEB_CONTENT_TYPE } })
      },
    })
    const controller = new AbortController()
    controller.abort()
    await expect(transport.execute(SUI_GRPC_WEB_METHODS[0], new Uint8Array([0]), { signal: controller.signal }))
      .rejects.toBeInstanceOf(ErpcAbortedError)
    expect(fetchCount).toBe(0)

    const malformed = new SuiGrpcWebTransport({
      direct: true,
      endpoint: new URL('https://sui.example/'),
      headers: {},
      timeoutMs: 1000,
      fetch: async () => new Response(new Uint8Array([0, 0, 0, 0, 0]) as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': SUI_GRPC_WEB_CONTENT_TYPE },
      }),
    })
    await expect(malformed.execute(SUI_GRPC_WEB_METHODS[0], new Uint8Array([0])))
      .rejects.toBeInstanceOf(ErpcInvalidResponseError)
  })

  it('cancels an open body on invalid content type and trims only SP/HTAB in trailers', async () => {
    let cancellations = 0
    const invalidContentType = createErpcClient({
      suiGrpcWeb: { baseUrl: 'https://sui.example/' },
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        pull() {},
        cancel() { cancellations += 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    })
    await expect(invalidContentType.sui.grpc.getObject('x').send())
      .rejects.toBeInstanceOf(ErpcInvalidResponseError)
    expect(cancellations).toBe(1)
    invalidContentType.close()

    const sendWithTrailer = async (trailer: string) => {
      const client = createErpcClient({
        suiGrpcWeb: { baseUrl: 'https://sui.example/' },
        fetch: async () => new Response(
          frame(objectResponsePayload(), trailer) as unknown as BodyInit,
          { status: 200, headers: { 'content-type': SUI_GRPC_WEB_CONTENT_TYPE } },
        ),
      })
      try { return await client.sui.grpc.getObject('x').send() }
      finally { client.close() }
    }

    await expect(sendWithTrailer('grpc-status: \t 0 \t\r\n')).resolves.toMatchObject({
      objectId: 'id',
    })
    await expect(sendWithTrailer('grpc-status: \u00a00\u00a0\r\n'))
      .rejects.toBeInstanceOf(ErpcInvalidResponseError)
  })

  it('accepts the inclusive 1 MiB request boundary and rejects one-byte overflow before I/O', async () => {
    const bodies: Uint8Array[] = []
    const client = createErpcClient({
      suiGrpcWeb: { baseUrl: 'https://sui.example/' },
      fetch: async (input, init) => {
        const body = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer())
        bodies.push(body)
        const payload = String(input).endsWith('GetObject')
          ? objectResponsePayload()
          : balanceResponsePayload()
        return new Response(frame(payload) as unknown as BodyInit, {
          status: 200,
          headers: { 'content-type': SUI_GRPC_WEB_CONTENT_TYPE },
        })
      },
    })
    await client.sui.grpc.getObject('x'.repeat(1_048_567)).send()
    await client.sui.grpc.getBalance(
      'a'.repeat(524_281),
      'b'.repeat(524_282),
    ).send()
    expect(bodies.map((body) => body.byteLength)).toEqual([1_048_576, 1_048_576])
    client.close()

    let fetchCount = 0
    const rejected = createErpcClient({
      suiGrpcWeb: { baseUrl: 'https://sui.example/' },
      fetch: async () => {
        fetchCount += 1
        throw new Error('unexpected fetch')
      },
    })
    expect(() => rejected.sui.grpc.getObject('x'.repeat(1_048_568))).toThrow(ErpcConfigError)
    expect(() => rejected.sui.grpc.getBalance(
      'a'.repeat(524_281),
      'b'.repeat(524_283),
    )).toThrow(ErpcConfigError)
    expect(fetchCount).toBe(0)
    rejected.close()
  })

  it('rejects malformed UTF-16 and wrong runtime string values before any fetch', () => {
    let fetchCount = 0
    const client = createErpcClient({
      suiGrpcWeb: { baseUrl: 'https://sui.example/' },
      fetch: async () => {
        fetchCount += 1
        throw new Error('unexpected fetch')
      },
    })
    const malformed = ['\ud800', '\udc00']
    const wrongValues: unknown[] = [null, undefined, 42, true, {}]
    for (const value of [...malformed, ...wrongValues]) {
      expect(() => client.sui.grpc.getObject(value as never)).toThrow(ErpcConfigError)
      expect(() => client.sui.grpc.getBalance(value as never, 'coin')).toThrow(ErpcConfigError)
      expect(() => client.sui.grpc.getBalance('owner', value as never)).toThrow(ErpcConfigError)
    }
    expect(fetchCount).toBe(0)
    client.close()
  })

  it('preserves valid supplementary Unicode as exact UTF-8 request bytes', async () => {
    const bodies: Uint8Array[] = []
    const client = createErpcClient({
      suiGrpcWeb: { baseUrl: 'https://sui.example/' },
      fetch: async (_input, init) => {
        bodies.push(new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer()))
        return new Response(frame(objectResponsePayload()) as unknown as BodyInit, {
          status: 200,
          headers: { 'content-type': SUI_GRPC_WEB_CONTENT_TYPE },
        })
      },
    })
    await client.sui.grpc.getObject('😀').send()
    expect(Array.from(bodies[0]?.slice(5) ?? [])).toEqual([
      0x0a, 0x04, 0xf0, 0x9f, 0x98, 0x80,
    ])
    client.close()
  })

  it('preserves a valid leading U+FEFF in protobuf response strings', async () => {
    const payload = fieldMessage(1, [
      ...fieldString(2, '\ufeff'),
      ...fieldVarint(3, 0n),
      ...fieldString(4, ''),
    ])
    const client = createErpcClient({
      suiGrpcWeb: { baseUrl: 'https://sui.example/' },
      fetch: async () => new Response(frame(payload) as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': SUI_GRPC_WEB_CONTENT_TYPE },
      }),
    })
    await expect(client.sui.grpc.getObject('x').send()).resolves.toMatchObject({
      objectId: '\ufeff',
    })
    client.close()
  })

  it('counts embedded messages and unknown groups in one depth budget', async () => {
    const createObjectClient = (payload: number[]) => createErpcClient({
      suiGrpcWeb: { baseUrl: 'https://sui.example/' },
      fetch: async () => new Response(frame(payload) as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': SUI_GRPC_WEB_CONTENT_TYPE },
      }),
    })
    const valid = createObjectClient(objectPayloadWithGroups(99))
    await expect(valid.sui.grpc.getObject('id').send()).resolves.toEqual({
      objectId: '',
      version: 0n,
      digest: '',
    })
    valid.close()

    const invalid = createObjectClient(objectPayloadWithGroups(100))
    await expect(invalid.sui.grpc.getObject('id').send())
      .rejects.toBeInstanceOf(ErpcInvalidResponseError)
    invalid.close()
  })

  it('merges Timestamp fragments before applying final nanos validation', async () => {
    const sendServiceInfo = async (fragments: number[][]) => {
      const client = createErpcClient({
        suiGrpcWeb: { baseUrl: 'https://sui.example/' },
        fetch: async () => new Response(
          frame(serviceInfoWithTimestampFragments(fragments)) as unknown as BodyInit,
          { status: 200, headers: { 'content-type': SUI_GRPC_WEB_CONTENT_TYPE } },
        ),
      })
      try { return await client.sui.grpc.getServiceInfo().send() }
      finally { client.close() }
    }

    await expect(sendServiceInfo([
      fieldVarint(2, 1_000_000_000n),
      fieldVarint(2, 0n),
    ])).resolves.toMatchObject({ timestampSeconds: 0n, timestampNanos: 0 })
    await expect(sendServiceInfo([
      fieldVarint(2, 0n),
      fieldVarint(2, 1_000_000_000n),
    ])).rejects.toBeInstanceOf(ErpcInvalidResponseError)
    await expect(sendServiceInfo([
      fieldVarintBytes(1, signedVarint(-1n)),
      fieldVarint(2, 4n),
    ])).resolves.toMatchObject({ timestampSeconds: -1n, timestampNanos: 4 })
    await expect(sendServiceInfo([
      [],
      fieldVarint(2, 0n),
    ])).resolves.toMatchObject({ timestampSeconds: 0n, timestampNanos: 0 })
  })
})
