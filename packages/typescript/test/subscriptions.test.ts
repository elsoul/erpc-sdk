import { describe, expect, it } from 'vitest'
import { createErpcClient } from '../src'

class MockWebSocket extends EventTarget {
  static readonly instances: MockWebSocket[] = []

  readonly url: string
  readyState = 0
  sent: unknown[] = []

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    MockWebSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.dispatchEvent(new Event('open'))
    })
  }

  close(): void {
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }

  send(data: string): void {
    const request = JSON.parse(data) as {
      readonly id: number
      readonly method: string
    }
    this.sent.push(request)
    const result = request.method.endsWith('unsubscribe') ? true : 'sub-1'
    queueMicrotask(() => {
      this.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
        }),
      )
    })
  }

  notify(result: unknown): void {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_subscription',
          params: { subscription: 'sub-1', result },
        }),
      }),
    )
  }
}

describe('WebSocket subscriptions', () => {
  it('subscribes, dispatches notifications, and unsubscribes', async () => {
    MockWebSocket.instances.length = 0
    const received: unknown[] = []
    const avalancheReceived: unknown[] = []
    const client = createErpcClient({
      apiKey: 'ws-secret',
      fetch: async () => new Response('{}'),
      webSocket: MockWebSocket as unknown as typeof globalThis.WebSocket,
    })

    const subscription = await client.ethereum.subscriptions.subscribe(
      'newHeads',
      (value) => received.push(value),
    )
    const socket = MockWebSocket.instances[0]
    expect(socket).toBeDefined()
    expect(socket?.url).toBe(
      'wss://edge.erpc.global/eth?api-key=ws-secret',
    )

    socket?.notify({ number: '0x2a' })
    await Promise.resolve()
    expect(received).toEqual([{ number: '0x2a' }])
    await expect(subscription.unsubscribe()).resolves.toBe(true)

    const avalancheSubscription =
      await client.avalanche.subscriptions.subscribe('newHeads', (value) =>
        avalancheReceived.push(value),
      )
    const avalancheSocket = MockWebSocket.instances[1]
    expect(avalancheSocket?.url).toBe(
      'wss://ava-rpc.erpc.global/ava-ws?api-key=ws-secret',
    )
    avalancheSocket?.notify({ number: '0x10' })
    await Promise.resolve()
    expect(avalancheReceived).toEqual([{ number: '0x10' }])
    await expect(avalancheSubscription.unsubscribe()).resolves.toBe(true)
    client.close()
  })
})
