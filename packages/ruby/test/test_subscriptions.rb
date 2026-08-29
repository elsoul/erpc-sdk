# frozen_string_literal: true

require_relative "test_helper"

class FakeSocketConnection
  attr_reader :sent

  def initialize
    @incoming = Queue.new
    @sent = []
  end

  def write_text(text)
    request = JSON.parse(text)
    @sent << request
    result = request["method"] == "eth_subscribe" ? "socket-sub" : true
    @incoming << JSON.generate("jsonrpc" => "2.0", "id" => request["id"], "result" => result)
  end

  def notify(subscription_id, result)
    @incoming << JSON.generate(
      "jsonrpc" => "2.0",
      "method" => "eth_subscription",
      "params" => { "subscription" => subscription_id, "result" => result }
    )
  end

  def read_message
    value = @incoming.pop
    raise value if value.is_a?(Exception)

    value
  end

  def close
    @incoming << ERPC::TransportError.new("closed")
  end
end

class SubscriptionsTest < Minitest::Test
  def test_solana_routes_notifications_and_unsubscribes_once
    transport = FakeWebSocketTransport.new(7)
    subscriptions = ERPC::SolanaSubscriptions.new(transport)
    received = []
    subscription = subscriptions.account_subscribe(
      "address",
      { "commitment" => "processed" },
      listener: ->(value) { received << value }
    )

    transport.notify(8, "wrong")
    transport.notify(7, { "slot" => 12 })
    assert_equal({ "slot" => 12 }, subscription.next(timeout: 0.1))
    assert_equal [{ "slot" => 12 }], received
    assert subscription.unsubscribe
    assert subscription.unsubscribe
    assert_equal [
      ["accountSubscribe", ["address", { "commitment" => "processed" }]],
      ["accountUnsubscribe", [7]]
    ], transport.calls
    assert_empty transport.listeners
  end

  def test_ethereum_subscription_requires_string_id
    transport = FakeWebSocketTransport.new("sub-id")
    subscriptions = ERPC::EthereumSubscriptions.new(transport)
    subscription = subscriptions.subscribe("newHeads", { "include" => "full" })

    transport.notify("sub-id", { "number" => "0x1" })
    assert_equal({ "number" => "0x1" }, subscription.next(timeout: 0.1))
    assert subscription.unsubscribe
    assert_equal [
      ["eth_subscribe", ["newHeads", { "include" => "full" }]],
      ["eth_unsubscribe", ["sub-id"]]
    ], transport.calls
  end

  def test_transport_close_is_idempotent
    transport = FakeWebSocketTransport.new(1)
    subscriptions = ERPC::SolanaSubscriptions.new(transport)

    subscriptions.close
    subscriptions.close
    assert transport.closed?
  end

  def test_websocket_json_rpc_transport_routes_real_request_and_notification
    connection = FakeSocketConnection.new
    captured_url = nil
    factory = lambda do |url, _timeout|
      captured_url = url
      connection
    end
    transport = ERPC::WebSocketJsonRpcTransport.new(
      "wss://example.test/eth?api-key=secret",
      "secret",
      0.5,
      connection_factory: factory
    )
    subscriptions = ERPC::EthereumSubscriptions.new(transport)
    subscription = subscriptions.subscribe("newHeads")

    connection.notify("socket-sub", { "number" => "0x2" })
    assert_equal({ "number" => "0x2" }, subscription.next(timeout: 0.5))
    assert subscription.unsubscribe
    assert_equal "eth_subscribe", connection.sent.first["method"]
    assert_equal "wss://example.test/eth?api-key=secret", captured_url
  ensure
    transport&.close
  end

  def test_native_websocket_handshake_and_masked_client_frame
    server = TCPServer.new("127.0.0.1", 0)
    request_queue = Queue.new
    server_thread = Thread.new do
      socket = server.accept
      request_line = socket.gets("\r\n")
      headers = {}
      while (line = socket.gets("\r\n"))
        break if line == "\r\n"

        name, value = line.split(":", 2)
        headers[name.downcase] = value.strip
      end
      accept = Base64.strict_encode64(
        Digest::SHA1.digest("#{headers.fetch("sec-websocket-key")}258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      )
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" \
        "Upgrade: websocket\r\n" \
        "Connection: Upgrade\r\n" \
        "Sec-WebSocket-Accept: #{accept}\r\n\r\n"
      )

      request = JSON.parse(read_client_frame(socket))
      request_queue << [request_line, request]
      response = JSON.generate("jsonrpc" => "2.0", "id" => request["id"], "result" => "0x1")
      socket.write([0x81, response.bytesize].pack("CC") + response)
      sleep 0.05
      socket.close
    end
    server_thread.report_on_exception = false

    url = "ws://127.0.0.1:#{server.local_address.ip_port}/eth?api-key=secret"
    transport = ERPC::WebSocketJsonRpcTransport.new(url, "secret", 1)
    assert_equal "0x1", transport.request("eth_chainId", [])
    request_line, request = request_queue.pop
    assert_equal "GET /eth?api-key=secret HTTP/1.1\r\n", request_line
    assert_equal "eth_chainId", request["method"]
    assert_equal [], request["params"]
    server_thread.value
  ensure
    transport&.close
    server&.close
    server_thread&.kill if server_thread&.alive?
  end

  private

  def read_client_frame(socket)
    first, second = read_exact(socket, 2).bytes
    raise "expected a final text frame" unless first == 0x81 && (second & 0x80) != 0

    length = second & 0x7F
    length = read_exact(socket, 2).unpack1("n") if length == 126
    mask = read_exact(socket, 4).bytes
    payload = read_exact(socket, length).bytes
    payload.each_with_index.map { |byte, index| byte ^ mask[index % 4] }.pack("C*")
  end

  def read_exact(socket, length)
    value = +"".b
    value << socket.readpartial(length - value.bytesize) while value.bytesize < length
    value
  end
end
