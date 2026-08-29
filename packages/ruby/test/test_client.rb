# frozen_string_literal: true

require_relative "test_helper"

class ClientTest < Minitest::Test
  def test_config_normalizes_endpoints_and_redacts_credential
    config = ERPC::ClientConfig.new(
      api_key: " secret ",
      endpoint: "https://example.test/rpc/?discard=yes#fragment"
    )

    assert_equal "secret", config.api_key
    assert_equal "https://example.test/rpc", config.endpoint
    refute_includes config.inspect, "secret"
    assert_includes config.inspect, "[REDACTED]"
  end

  def test_request_is_inert_and_uses_exact_wire_method
    adapter = FakeHttpAdapter.new do |request|
      body = JSON.parse(request.fetch(:body))
      assert_equal "getBalance", body["method"]
      assert_equal ["address", { "commitment" => "finalized" }], body["params"]
      ERPC::HttpResponse.new(
        status: 200,
        body: JSON.generate("jsonrpc" => "2.0", "id" => body["id"], "result" => { "value" => 42 })
      )
    end
    erpc = ERPC::Client.new(
      ERPC::ClientConfig.new(api_key: "api key", endpoint: "https://example.test"),
      http_adapter: adapter
    )

    pending = erpc.solana.rpc.get_balance("address", { "commitment" => "finalized" })
    assert_empty adapter.requests
    assert_equal({ "value" => 42 }, pending.send)
    assert_equal "api key", URI.decode_www_form(URI.parse(adapter.requests.first[:url]).query).to_h["api-key"]
    refute_includes erpc.solana.rpc.endpoint, "api-key"
  ensure
    erpc&.close
  end

  def test_batch_is_intact_and_restores_caller_order
    adapter = FakeHttpAdapter.new do |request|
      body = JSON.parse(request.fetch(:body))
      assert_instance_of Array, body
      ERPC::HttpResponse.new(
        status: 200,
        body: JSON.generate([
          { "jsonrpc" => "2.0", "id" => body[1]["id"], "result" => 200 },
          { "jsonrpc" => "2.0", "id" => body[0]["id"], "result" => 100 }
        ])
      )
    end
    erpc = ERPC::Client.new(ERPC::ClientConfig.new(api_key: "key"), http_adapter: adapter)

    result = erpc.solana.rpc.batch([
      { method: "getSlot", params: [] },
      { method: "getBlockHeight", params: [] }
    ]).send
    assert_equal [100, 200], result
    assert_equal 1, adapter.requests.length
  ensure
    erpc&.close
  end

  def test_raw_supports_forward_compatible_method_and_decoder
    adapter = FakeHttpAdapter.new do |request|
      body = JSON.parse(request.fetch(:body))
      assert_equal "futureMethod", body["method"]
      ERPC::HttpResponse.new(
        status: 200,
        body: JSON.generate("jsonrpc" => "2.0", "id" => body["id"], "result" => "ok")
      )
    end
    erpc = ERPC::Client.new(ERPC::ClientConfig.new(api_key: "key"), http_adapter: adapter)

    result = erpc.solana.rpc.raw("futureMethod", {}, decoder: ->(value) { value.upcase }).send
    assert_equal "OK", result
  ensure
    erpc&.close
  end

  def test_batch_policies_are_rejected_before_network_io
    adapter = FakeHttpAdapter.new { raise "network should not be reached" }
    erpc = ERPC::Client.new(ERPC::ClientConfig.new(api_key: "key"), http_adapter: adapter)

    assert_raises(ERPC::BatchPolicyError) do
      erpc.solana.rpc.batch([
        { method: "getSlot", params: [] },
        { method: "getProgramAccounts", params: ["address"] }
      ])
    end
    assert_raises(ERPC::BatchPolicyError) do
      erpc.solana.leaders.batch([{ method: "getLeaderSlots", params: [] }])
    end
    assert_empty adapter.requests
  ensure
    erpc&.close
  end

  def test_batch_limit_is_enforced_without_splitting
    adapter = FakeHttpAdapter.new { raise "network should not be reached" }
    erpc = ERPC::Client.new(ERPC::ClientConfig.new(api_key: "key"), http_adapter: adapter)

    error = assert_raises(ERPC::InvalidResponseError) do
      erpc.ethereum.rpc.batch(Array.new(257) { { method: "eth_chainId" } }).send
    end
    assert_match(/at most 256/, error.message)
    assert_empty adapter.requests
  ensure
    erpc&.close
  end

  def test_rpc_error_redacts_raw_and_encoded_credentials
    credential = "s e/c"
    adapter = FakeHttpAdapter.new do |request|
      body = JSON.parse(request.fetch(:body))
      ERPC::HttpResponse.new(
        status: 200,
        body: JSON.generate(
          "jsonrpc" => "2.0",
          "id" => body["id"],
          "error" => {
            "code" => -32_000,
            "message" => "failed for #{credential} and s+e%2Fc",
            "data" => { "url" => "https://example.test?api-key=s%20e%2Fc" }
          }
        )
      )
    end
    erpc = ERPC::Client.new(ERPC::ClientConfig.new(api_key: credential), http_adapter: adapter)

    error = assert_raises(ERPC::JsonRpcError) { erpc.ethereum.rpc.eth_chain_id.send }
    rendered = "#{error.message} #{error.data}"
    refute_includes rendered, credential
    refute_includes rendered, "s+e%2Fc"
    refute_includes rendered, "s%20e%2Fc"
    assert_equal 3, rendered.scan("[REDACTED]").length
  ensure
    erpc&.close
  end

  def test_duplicate_batch_ids_are_invalid
    adapter = FakeHttpAdapter.new do |request|
      body = JSON.parse(request.fetch(:body))
      ERPC::HttpResponse.new(
        status: 200,
        body: JSON.generate([
          { "jsonrpc" => "2.0", "id" => body[0]["id"], "result" => 1 },
          { "jsonrpc" => "2.0", "id" => body[0]["id"], "result" => 2 }
        ])
      )
    end
    erpc = ERPC::Client.new(ERPC::ClientConfig.new(api_key: "key"), http_adapter: adapter)

    error = assert_raises(ERPC::InvalidResponseError) do
      erpc.ethereum.rpc.batch([{ method: "eth_chainId" }, { method: "eth_blockNumber" }]).send
    end
    assert_match(/duplicate/, error.message)
  ensure
    erpc&.close
  end

  def test_state_changing_request_is_not_retried
    attempts = 0
    adapter = FakeHttpAdapter.new do
      attempts += 1
      raise ERPC::TransportError, "Unable to reach ERPC"
    end
    erpc = ERPC::Client.new(ERPC::ClientConfig.new(api_key: "key"), http_adapter: adapter)

    assert_raises(ERPC::TransportError) do
      erpc.solana.rpc.send_transaction("signed-transaction").send
    end
    assert_equal 1, attempts
  ensure
    erpc&.close
  end
end
