# frozen_string_literal: true

require_relative "test_helper"
require "json"
require "zlib"

class BitcoinTest < Minitest::Test
  def facts
    @facts ||= ERPC.const_get(:BitcoinTransportContract, true).facts_from_contract(
      JSON.parse(File.read(File.expand_path("../../../registry/rpc-network-contract.json", __dir__)))
    )
  end

  def transport_class
    ERPC.const_get(:BitcoinHttpTransport, true)
  end

  class StreamingAdapter
    attr_reader :requests

    def initialize(status: 200, &handler)
      @status = status
      @handler = handler
      @requests = []
    end

    def request_stream(**request)
      @requests << request
      body = @handler.call(request)
      yield(@status, [body].flatten)
    end
  end

  class ClosingBlockingStream
    attr_reader :closed

    def initialize
      @closed = false
    end

    def each
      sleep 1.0
    end

    def close
      @closed = true
    end
  end

  def response_for(request, result:)
    body = JSON.parse(request.fetch(:body))
    JSON.generate("jsonrpc" => "2.0", "id" => body.fetch("id"), "result" => result)
  end

  def public_bitcoin_rpc(response_body)
    requests = []
    adapter = Object.new
    adapter.define_singleton_method(:request_stream) do |**request, &block|
      requests << request
      block.call(200, [response_body])
    end
    endpoint = ERPC::RpcEndpointConfig.new(http_url: "https://customer.example/bitcoin")
    client = ERPC::Client.new(ERPC::ClientConfig.new(bitcoin_rpc: endpoint), http_adapter: adapter)
    [client.bitcoin.rpc, requests]
  end

  def nested_container_json(shape, depth)
    value = "0"
    depth.times do |index|
      value = case shape
              when :array
                "[#{value}]"
              when :object
                %({"value":#{value}})
              when :alternating
                index.even? ? "[#{value}]" : %({"value":#{value}})
              else
                raise ArgumentError, "unknown shape"
              end
    end
    value
  end

  def test_direct_named_reads_preserve_target_headers_and_are_inert
    adapter = StreamingAdapter.new do |request|
      body = JSON.parse(request.fetch(:body))
      if body.fetch("method") == "getblockcount"
        response_for(request, result: 18_446_744_073_709_551_615)
      else
        response_for(request, result: { "value" => 1.2300, "tiny" => 1e-1000 })
      end
    end
    direct = ERPC::RpcEndpointConfig.new(
      http_url: "https://customer.example/rpc?token=a%2Fb&region=eu",
      headers: { "authorization" => "Bearer direct-secret", "x-node-scope" => "bitcoin-only" }
    )
    transport = transport_class.new(facts: facts, direct_endpoint: direct, adapter: adapter)
    rpc = ERPC::BitcoinClient.new(transport).rpc

    pending = rpc.get_block_count
    assert_empty adapter.requests
    assert_equal 18_446_744_073_709_551_615, pending.send
    assert_equal "https://customer.example/", rpc.endpoint
    assert_equal "https://customer.example/rpc?token=a%2Fb&region=eu", adapter.requests.first.fetch(:url)
    assert_equal "Bearer direct-secret", adapter.requests.first.fetch(:headers).fetch("authorization")
    assert_equal "bitcoin-only", adapter.requests.first.fetch(:headers).fetch("x-node-scope")
    assert_equal [], JSON.parse(adapter.requests.first.fetch(:body)).fetch("params")
  end

  def test_hosted_target_uses_bitcoin_path_and_bearer_without_api_key_query
    adapter = StreamingAdapter.new { |request| response_for(request, result: "hash") }
    transport = transport_class.new(
      facts: facts,
      api_key: "shared-secret",
      endpoint: "https://edge.example/base?api-key=stale&region=eu",
      headers: { "Authorization" => "old", "x-global" => "hosted-only" },
      adapter: adapter
    )
    assert_equal "hash", transport.request("getbestblockhash", [])
    request = adapter.requests.fetch(0)
    assert_equal "https://edge.example/base/bitcoin?region=eu", request.fetch(:url)
    assert_equal "Bearer shared-secret", request.fetch(:headers).fetch("authorization")
    assert_equal "hosted-only", request.fetch(:headers).fetch("x-global")
    refute request.fetch(:url).include?("api-key")
  end

  def test_direct_json_rpc_errors_redact_raw_decoded_and_encoded_path_variants
    adapter = StreamingAdapter.new do |request|
      body = JSON.parse(request.fetch(:body))
      JSON.generate(
        "jsonrpc" => "2.0", "id" => body.fetch("id"),
        "error" => {
          "code" => -32000,
          "message" => "%66oo foo fixture-secret Bearer fixture-secret",
          "data" => {
            "encodedPath" => "%66oo", "decodedPath" => "foo", "query" => "fixture-secret",
            "header" => "Bearer fixture-secret", "%66oo" => "fixture-secret", "count" => 7, "fraction" => 0.5
          }
        }
      )
    end
    endpoint = ERPC::RpcEndpointConfig.new(
      http_url: "https://redact.fixture.invalid/%66oo?key=fixture-secret",
      headers: { "authorization" => "Bearer fixture-secret" }
    )
    rpc = ERPC::BitcoinClient.new(transport_class.new(facts: facts, direct_endpoint: endpoint, adapter: adapter)).rpc

    error = assert_raises(ERPC::JsonRpcError) { rpc.get_network_info.send }
    assert_equal(-32000, error.code)
    assert_equal "[REDACTED]", error.data.fetch("encodedPath")
    assert_equal "[REDACTED]", error.data.fetch("decodedPath")
    assert_equal "[REDACTED]", error.data.fetch("[REDACTED]")
    assert_equal 7, error.data.fetch("count")
    assert_equal BigDecimal("0.5"), error.data.fetch("fraction")
    refute_includes error.message, "fixture-secret"
    refute_includes error.message, "%66oo"
  end

  def test_surface_is_explicit_and_optional_parameters_preserve_wire_params
    adapter = StreamingAdapter.new { |request| response_for(request, result: "ok") }
    rpc = ERPC::BitcoinClient.new(
      transport_class.new(facts: facts, api_key: "key", adapter: adapter)
    ).rpc
    public = rpc.public_methods(false).map(&:to_s).sort
    assert_equal %w[endpoint estimate_smart_fee get_best_block_hash get_block get_block_count get_block_hash
                    get_block_header get_blockchain_info get_mempool_info get_network_info get_raw_mempool
                    get_raw_transaction get_tx_out inspect].sort, public
    refute_includes rpc.inspect, "customer.example"
    refute_includes rpc.inspect, "Bearer"
    refute rpc.respond_to?(:raw)
    refute rpc.respond_to?(:request)
    assert_raises(NameError) { ERPC::BitcoinHttpTransport }

    rpc.estimate_smart_fee(6, "ECONOMICAL").send
    rpc.get_block("hash", 2).send
    rpc.get_raw_transaction("tx", true, "block").send
    assert_equal ["estimatesmartfee", [6, "ECONOMICAL"]], request_method_and_params(adapter.requests[0])
    assert_equal ["getblock", ["hash", 2]], request_method_and_params(adapter.requests[1])
    assert_equal ["getrawtransaction", ["tx", true, "block"]], request_method_and_params(adapter.requests[2])
  end

  def test_missing_stream_capability_fails_on_send_without_fallback_io
    adapter = Object.new
    transport = transport_class.new(facts: facts, api_key: "key", adapter: adapter)
    error = assert_raises(ERPC::ConfigError) { transport.request("getnetworkinfo", []) }
    assert_nil error.cause
    assert_includes error.message, "streaming"
  end

  def test_public_method_values_cannot_mutate_private_wire_routing
    assert ERPC::BITCOIN_RPC_METHODS.frozen?
    assert ERPC::BITCOIN_RPC_METHODS.all?(&:frozen?)
    assert_raises(FrozenError) { ERPC::BITCOIN_RPC_METHODS.first.replace("unexpected_method") }
    assert_equal "getblockcount", ERPC.const_get(:BitcoinTransportContract, true).facts_from_contract(JSON.parse(File.read(File.expand_path("../../../registry/rpc-network-contract.json", __dir__)))).wire_method("get_block_count")
  end

  def test_websocket_overrides_are_rejected_before_request
    endpoint = ERPC::RpcEndpointConfig.new(
      http_url: "https://node.example/rpc",
      websocket_url: "wss://node.example/rpc"
    )
    assert_raises(ERPC::ConfigError) do
      transport_class.new(facts: facts, direct_endpoint: endpoint, adapter: StreamingAdapter.new { "" })
    end
  end

  def test_real_net_http_stream_reads_loopback_body
    server = TCPServer.new("127.0.0.1", 0)
    port = server.local_address.ip_port
    response_body = JSON.generate("jsonrpc" => "2.0", "id" => 1, "result" => 123)
    thread = Thread.new do
      socket = server.accept
      socket.gets
      content_length = 0
      while (line = socket.gets)
        break if line == "\r\n"

        name, value = line.split(":", 2)
        content_length = value.to_i if name&.casecmp?("content-length")
      end
      socket.read(content_length) if content_length.positive?
      socket.write(
        "HTTP/1.1 200 OK\r\n" \
        "Content-Type: application/json\r\n" \
        "Content-Length: #{response_body.bytesize}\r\n" \
        "Connection: close\r\n\r\n"
      )
      response_body.bytes.each_slice(5) do |bytes|
        chunk = bytes.pack("C*")
        socket.write(chunk)
      end
    ensure
      socket&.close
    end
    thread.report_on_exception = false

    transport = transport_class.new(
      facts: facts,
      direct_endpoint: ERPC::RpcEndpointConfig.new(http_url: "http://127.0.0.1:#{port}/rpc"),
      timeout: 2.0
    )
    assert_equal 123, transport.request("getblockcount", [])
    Timeout.timeout(2.0) { thread.join }
  ensure
    thread&.kill if thread&.alive?
    server&.close
  end

  def test_encoded_content_length_is_not_compared_with_decoded_stream_bytes
    response_body = JSON.generate("jsonrpc" => "2.0", "id" => 1, "result" => 123)
    encoded_length = Zlib.gzip(response_body).bytesize
    adapter = Object.new
    adapter.define_singleton_method(:request_stream) do |**_request, &block|
      # Net::HTTP transparently yields decoded bytes while retaining the
      # wire Content-Length of the compressed entity in response headers.
      block.call(200, [response_body], { "content-encoding" => ["gzip"], "content-length" => [encoded_length.to_s] })
    end
    transport = transport_class.new(
      facts: facts,
      direct_endpoint: ERPC::RpcEndpointConfig.new(http_url: "http://127.0.0.1/rpc"),
      adapter: adapter
    )

    assert_equal 123, transport.request("getblockcount", [])
  end

  def test_identity_content_encoding_array_keeps_plain_truncation_guard
    response_body = JSON.generate("jsonrpc" => "2.0", "id" => 1, "result" => 123)
    adapter = Object.new
    adapter.define_singleton_method(:request_stream) do |**_request, &block|
      block.call(200, [response_body], { "content-encoding" => ["identity"], "content-length" => [(response_body.bytesize + 7).to_s] })
    end
    transport = transport_class.new(
      facts: facts,
      direct_endpoint: ERPC::RpcEndpointConfig.new(http_url: "http://127.0.0.1/rpc"),
      adapter: adapter
    )

    error = assert_raises(ERPC::TransportError) { transport.request("getblockcount", []) }
    assert_nil error.cause
  end

  def test_total_deadline_interrupts_a_body_read_and_closes_the_stream
    stream = ClosingBlockingStream.new
    adapter = Object.new
    adapter.define_singleton_method(:request_stream) do |**_request, &block|
      block.call(200, stream)
    end
    transport = transport_class.new(
      facts: facts,
      api_key: "key",
      adapter: adapter,
      timeout: 0.01
    )
    assert_raises(ERPC::TimeoutError) { transport.request("getnetworkinfo", []) }
    assert stream.closed
  end

  def test_public_sdk_accepts_depth64_and_rejects_depth65_for_all_container_shapes
    limits = ERPC.const_get(:BITCOIN_RESPONSE_LIMITS, true)
    result_depth = limits.container_depth - 1
    %i[array object alternating].each do |shape|
      valid_body = %({"jsonrpc":"2.0","id":1,"result":#{nested_container_json(shape, result_depth)}})
      rpc, requests = public_bitcoin_rpc(valid_body)
      assert rpc.get_blockchain_info.send
      assert_equal 1, requests.length

      invalid_body = %({"jsonrpc":"2.0","id":1,"result":#{nested_container_json(shape, limits.container_depth)}})
      rpc, requests = public_bitcoin_rpc(invalid_body)
      error = assert_raises(ERPC::InvalidResponseError) { rpc.get_blockchain_info.send }
      assert_nil error.cause
      assert_equal 1, requests.length
    end
  end

  def test_public_sdk_rejects_very_deep_open_container_before_json_conversion
    body = %({"jsonrpc":"2.0","id":1,"result":#{"[" * 10_000}1e1000)
    rpc, requests = public_bitcoin_rpc(body)
    error = assert_raises(ERPC::InvalidResponseError) { rpc.get_blockchain_info.send }
    assert_nil error.cause
    refute_instance_of SystemStackError, error
    assert_equal 1, requests.length
  end

  def test_public_sdk_transport_uses_bound_decoded_byte_limit
    limits = ERPC.const_get(:BITCOIN_RESPONSE_LIMITS, true)
    oversized = Object.new
    oversized.define_singleton_method(:to_s) { self }
    oversized.define_singleton_method(:b) { self }
    oversized.define_singleton_method(:bytesize) { limits.decoded_entity_bytes + 1 }
    rpc, requests = public_bitcoin_rpc(oversized)

    error = assert_raises(ERPC::InvalidResponseError) { rpc.get_blockchain_info.send }
    assert_nil error.cause
    assert_equal 1, requests.length
  end

  private

  def request_method_and_params(request)
    body = JSON.parse(request.fetch(:body))
    [body.fetch("method"), body.fetch("params")]
  end
end
