# frozen_string_literal: true

require_relative "test_helper"
require "base64"

class ClientTest < Minitest::Test
  def test_config_normalizes_endpoints_and_redacts_credential
    config = ERPC::ClientConfig.new(
      api_key: " secret ",
      endpoint: "https://example.test/rpc/?discard=yes#fragment",
      avalanche_endpoint: "https://ava.example.test/c-chain/?discard=yes#fragment"
    )

    assert_equal "secret", config.api_key
    assert_equal "https://example.test/rpc", config.endpoint
    assert_equal "https://ava.example.test/c-chain", config.avalanche_endpoint
    assert_equal "wss://ava.example.test/c-chain/ava-ws?api-key=socket+key",
                 ERPC::URLs.websocket(config.avalanche_endpoint, "socket key", "/ava-ws")
    refute_includes config.inspect, "secret"
    assert_includes config.inspect, "[REDACTED]"
  end

  def test_avalanche_uses_the_c_chain_endpoint
    adapter = FakeHttpAdapter.new do |request|
      body = JSON.parse(request.fetch(:body))
      assert_equal "eth_chainId", body["method"]
      ERPC::HttpResponse.new(
        status: 200,
        body: JSON.generate("jsonrpc" => "2.0", "id" => body["id"], "result" => "0xa86a")
      )
    end
    erpc = ERPC::Client.new(ERPC::ClientConfig.new(api_key: "api key"), http_adapter: adapter)

    assert_equal "0xa86a", erpc.avalanche.rpc.eth_chain_id.send
    request_url = URI.parse(adapter.requests.first.fetch(:url))
    assert_equal "ava-rpc.erpc.global", request_url.host
    assert_equal "/ava", request_url.path
    assert_equal "api key", URI.decode_www_form(request_url.query).to_h["api-key"]
    refute_includes erpc.avalanche.rpc.endpoint, "api-key"
  ensure
    erpc&.close
  end

  def test_avalanche_native_and_index_namespaces_preserve_wire_routes
    adapter = FakeHttpAdapter.new do |request|
      body = JSON.parse(request.fetch(:body))
      ERPC::HttpResponse.new(
        status: 200,
        body: JSON.generate("jsonrpc" => "2.0", "id" => body["id"], "result" => body["method"])
      )
    end
    erpc = ERPC::Client.new(ERPC::ClientConfig.new(api_key: "key"), http_adapter: adapter)

    assert_equal "platform.getHeight", erpc.avalanche.p_chain.get_height.send
    assert_equal "index.getContainerByID",
                 erpc.avalanche.index.x_chain_transactions.get_container_by_id(id: "tx-id").send
    assert_equal "/ava", URI.parse(adapter.requests[0].fetch(:url)).path
    assert_equal "/ava/ext/index/X/tx", URI.parse(adapter.requests[1].fetch(:url)).path
    assert_raises(ERPC::BatchPolicyError) do
      erpc.avalanche.x_chain.batch([{ method: "getHeight" }])
    end
  ensure
    erpc&.close
  end

  def test_avalanche_method_catalogs_cover_native_apis
    assert_equal 4, ERPC::AVALANCHE_AVAX_METHODS.length
    assert_equal 11, ERPC::AVALANCHE_X_CHAIN_METHODS.length
    assert_equal 26, ERPC::AVALANCHE_P_CHAIN_METHODS.length
    assert_equal 2, ERPC::AVALANCHE_PROPOSER_VM_METHODS.length
    assert_equal 1, ERPC::AVALANCHE_INFO_METHODS.length
    assert_equal 6, ERPC::AVALANCHE_INDEX_METHODS.length
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

  def test_solana_v1_options_are_forwarded_and_zero_or_omitted_options_stay_unchanged
    adapter = FakeHttpAdapter.new do |request|
      body = JSON.parse(request.fetch(:body))
      ERPC::HttpResponse.new(
        status: 200,
        body: JSON.generate("jsonrpc" => "2.0", "id" => body["id"], "result" => body["params"])
      )
    end
    erpc = ERPC::Client.new(ERPC::ClientConfig.new(api_key: "key"), http_adapter: adapter)
    transaction_options = {
      "commitment" => "finalized",
      "encoding" => "jsonParsed",
      "maxSupportedTransactionVersion" => 1
    }
    block_options = {
      "commitment" => "confirmed",
      "encoding" => "jsonParsed",
      "maxSupportedTransactionVersion" => 1,
      "rewards" => true,
      "transactionDetails" => "full"
    }

    assert_equal ["signature-v1", transaction_options],
                 erpc.solana.rpc.get_transaction("signature-v1", transaction_options).send
    assert_equal [1035, block_options], erpc.solana.rpc.get_block(1035, block_options).send
    assert_equal ["signature-v0", { "maxSupportedTransactionVersion" => 0 }],
                 erpc.solana.rpc.get_transaction("signature-v0", { "maxSupportedTransactionVersion" => 0 }).send
    assert_equal [1034, { "maxSupportedTransactionVersion" => 0 }],
                 erpc.solana.rpc.get_block(1034, { "maxSupportedTransactionVersion" => 0 }).send
    assert_equal ["signature-legacy"], erpc.solana.rpc.get_transaction("signature-legacy").send
    assert_equal [1033], erpc.solana.rpc.get_block(1033).send

    assert_equal [
      { "method" => "getTransaction", "params" => ["signature-v1", transaction_options] },
      { "method" => "getBlock", "params" => [1035, block_options] },
      { "method" => "getTransaction", "params" => ["signature-v0", { "maxSupportedTransactionVersion" => 0 }] },
      { "method" => "getBlock", "params" => [1034, { "maxSupportedTransactionVersion" => 0 }] },
      { "method" => "getTransaction", "params" => ["signature-legacy"] },
      { "method" => "getBlock", "params" => [1033] }
    ], adapter.requests.map { |request|
      body = JSON.parse(request.fetch(:body))
      { "method" => body.fetch("method"), "params" => body.fetch("params") }
    }
  ensure
    erpc&.close
  end

  def test_solana_v1_responses_preserve_opaque_fields_and_versioned_config
    transaction_v1 = {
      "slot" => 123_456,
      "blockTime" => 1_700_000_001,
      "meta" => {
        "err" => nil,
        "fee" => 5_000,
        "computeUnitsConsumed" => 80_000,
        "unrelatedMetaField" => { "preserve" => [true, 7] }
      },
      "transaction" => {
        "signatures" => ["synthetic-signature"],
        "message" => {
          "accountKeys" => ["synthetic-account"],
          "instructions" => [],
          "recentBlockhash" => "synthetic-blockhash",
          "transactionConfig" => {
            "computeUnitLimit" => 1_400_000,
            "loadedAccountsDataSizeLimit" => 64_000,
            "heapSize" => nil,
            "priorityFee" => nil,
            "unrelatedConfigField" => "preserve"
          },
          "unrelatedMessageField" => { "keep" => "opaque" }
        },
        "unrelatedTransactionField" => ["preserve", 9]
      },
      "version" => 1,
      "unrelatedTopLevelField" => { "keep" => "opaque" }
    }
    transaction_v1_in_block = JSON.parse(JSON.generate(transaction_v1))
    transaction_v1_in_block.fetch("transaction").fetch("message").fetch("transactionConfig")["priorityFee"] = 5_000
    legacy = {
      "slot" => 123_457,
      "transaction" => {
        "signatures" => [],
        "message" => {
          "accountKeys" => [],
          "instructions" => [],
          "recentBlockhash" => "legacy-blockhash"
        }
      },
      "version" => "legacy",
      "unrelatedField" => "preserve"
    }
    v0 = {
      "slot" => 123_458,
      "transaction" => {
        "signatures" => [],
        "message" => {
          "accountKeys" => [],
          "addressTableLookups" => [],
          "instructions" => [],
          "recentBlockhash" => "v0-blockhash"
        }
      },
      "version" => 0,
      "unrelatedField" => { "preserve" => true }
    }
    block_v1 = {
      "blockhash" => "synthetic-blockhash",
      "blockTime" => 1_700_000_001,
      "blockHeight" => 98_765,
      "parentSlot" => 123_455,
      "previousBlockhash" => "synthetic-previous-blockhash",
      "rewards" => [],
      "signatures" => ["synthetic-signature"],
      "transactions" => [transaction_v1_in_block, legacy, v0],
      "unrelatedTopLevelField" => { "keep" => "opaque" }
    }
    adapter = FakeHttpAdapter.new do |request|
      body = JSON.parse(request.fetch(:body))
      result = body["method"] == "getTransaction" ? transaction_v1 : block_v1
      ERPC::HttpResponse.new(
        status: 200,
        body: JSON.generate("jsonrpc" => "2.0", "id" => body["id"], "result" => result)
      )
    end
    erpc = ERPC::Client.new(ERPC::ClientConfig.new(api_key: "key"), http_adapter: adapter)

    transaction = erpc.solana.rpc.get_transaction("signature-v1", { "maxSupportedTransactionVersion" => 1 }).send
    block = erpc.solana.rpc.get_block(123_456, { "maxSupportedTransactionVersion" => 1 }).send

    assert_equal transaction_v1, transaction
    assert_equal block_v1, block
    assert_equal({
      "computeUnitLimit" => 1_400_000,
      "loadedAccountsDataSizeLimit" => 64_000,
      "heapSize" => nil,
      "priorityFee" => nil,
      "unrelatedConfigField" => "preserve"
    }, transaction.fetch("transaction").fetch("message").fetch("transactionConfig"))
    assert_equal 5_000,
                 block.fetch("transactions").first.fetch("transaction").fetch("message").fetch("transactionConfig").fetch("priorityFee")
    block.fetch("transactions").values_at(1, 2).each do |entry|
      refute entry.fetch("transaction").fetch("message").key?("transactionConfig")
    end
  ensure
    erpc&.close
  end

  def test_solana_transaction_submission_forwards_one_exact_large_base64_fixture
    # Synthetic opaque fixture: NOT a valid signed transaction and NOT proof of chain acceptance.
    transaction = "A" * 5462 + "=="
    options = { "encoding" => "base64" }
    adapter = FakeHttpAdapter.new do |request|
      body = JSON.parse(request.fetch(:body))
      result = body["method"] == "sendTransaction" ? "synthetic-signature" : { "value" => ["synthetic"], "err" => nil }
      ERPC::HttpResponse.new(
        status: 200,
        body: JSON.generate("jsonrpc" => "2.0", "id" => body["id"], "result" => result)
      )
    end
    erpc = ERPC::Client.new(ERPC::ClientConfig.new(api_key: "key"), http_adapter: adapter)

    assert_equal transaction, Base64.strict_encode64("\0" * 4096)
    assert_equal 4096, Base64.strict_decode64(transaction).bytesize
    assert_equal "synthetic-signature", erpc.solana.rpc.send_transaction(transaction, options).send
    assert_equal({ "value" => ["synthetic"], "err" => nil }, erpc.solana.rpc.simulate_transaction(transaction, options).send)
    assert_equal 2, adapter.requests.length
    assert_equal [
      { "method" => "sendTransaction", "params" => [transaction, options] },
      { "method" => "simulateTransaction", "params" => [transaction, options] }
    ], adapter.requests.map { |request|
      body = JSON.parse(request.fetch(:body))
      { "method" => body.fetch("method"), "params" => body.fetch("params") }
    }
  ensure
    erpc&.close
  end

  def test_solana_transaction_version_rpc_error_surfaces_once_without_retry_or_fallback
    error_data = {
      "maxSupportedTransactionVersion" => 1,
      "transactionVersion" => 1,
      "detail" => "decoder capability is too old"
    }
    attempts = 0
    adapter = FakeHttpAdapter.new do |request|
      attempts += 1
      body = JSON.parse(request.fetch(:body))
      ERPC::HttpResponse.new(
        status: 200,
        body: JSON.generate(
          "jsonrpc" => "2.0",
          "id" => body["id"],
          "error" => {
            "code" => -32_015,
            "message" => "transaction version is not supported",
            "data" => error_data
          }
        )
      )
    end
    erpc = ERPC::Client.new(ERPC::ClientConfig.new(api_key: "key"), http_adapter: adapter)

    error = assert_raises(ERPC::JsonRpcError) do
      erpc.solana.rpc.get_transaction("unsupported-signature", { "maxSupportedTransactionVersion" => 0 }).send
    end

    assert_equal(-32_015, error.code)
    assert_equal error_data, error.data
    assert_equal 1, attempts
    assert_equal 1, adapter.requests.length
    assert_equal "getTransaction", JSON.parse(adapter.requests.first.fetch(:body)).fetch("method")
  ensure
    erpc&.close
  end
end
