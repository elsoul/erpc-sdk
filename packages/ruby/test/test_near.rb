# frozen_string_literal: true

require_relative "test_helper"
require "json"

class NearTest < Minitest::Test
  def facts
    @facts ||= ERPC.const_get(:NearContract, true).facts_from_contract(
      JSON.parse(File.read(File.expand_path("../../../registry/rpc-network-contract.json", __dir__)))
    )
  end

  def transport_class
    ERPC.const_get(:NearHttpTransport, true)
  end

  def adapter
    @adapter ||= Class.new do
      attr_reader :requests

      def initialize
        @requests = []
      end

      def request(**request)
        @requests << request
        body = JSON.parse(request.fetch(:body))
        result = case body.fetch("method")
                 when "status"
                   {
                     "chain_id" => "mainnet",
                     "genesis_hash" => "genesis",
                     "latest_protocol_version" => 1,
                     "protocol_version" => 1,
                     "sync_info" => {
                       "latest_block_hash" => "block",
                       "latest_block_height" => 5,
                       "latest_block_time" => "2024-01-01T00:00:00Z",
                       "latest_state_root" => "state",
                       "syncing" => false,
                       "unknown_numeric" => "__NEAR_NUMERIC__"
                     },
                     "version" => { "version" => "1", "build" => "a", "rustc_version" => nil }
                   }
                 when "block"
                   {
                     "author" => "node",
                     "header" => {
                       "hash" => "hash", "height" => 5, "prev_hash" => "prev", "timestamp" => 5,
                       "timestamp_nanosec" => "5000000000", "gas_price" => "100", "total_supply" => "200"
                     },
                     "chunks" => [], "unknown" => 18446744073709551616
                   }
                 else
                   {
                     "amount" => "100", "locked" => "0", "code_hash" => "hash", "storage_usage" => 1,
                     "storage_paid_at" => nil, "block_height" => 5, "block_hash" => "hash"
                   }
                 end
        response_body = JSON.generate("jsonrpc" => "2.0", "id" => body.fetch("id"), "result" => result)
        response_body = response_body.sub('"__NEAR_NUMERIC__"', "1e-1000")
        ERPC::HttpResponse.new(status: 200, body: response_body)
      end
    end.new
  end

  def test_typed_reads_preserve_selectors_and_unknown_exact_numbers
    direct = ERPC::RpcEndpointConfig.new(
      http_url: "https://customer.example/near?token=a%2Fb",
      headers: { "authorization" => "Bearer direct-secret", "x-near" => "near-only" }
    )
    rpc = ERPC::NearClient.new(
      transport_class.new(facts: facts, direct_endpoint: direct, adapter: adapter, namespace: "near.rpc")
    ).rpc

    status = rpc.status.send
    assert_equal "mainnet", status.chain_id
    assert_equal BigDecimal("1e-1000"), status.sync_info.additional.fetch("unknown_numeric")
    assert_equal "node", rpc.block(ERPC::NearBlockReference.height(5)).send.author
    account = rpc.view_account("alice", ERPC::NearBlockReference.final).send
    assert_equal "100", account.amount
    assert_equal "https://customer.example/", rpc.endpoint
    assert_equal "https://customer.example/near?token=a%2Fb", adapter.requests.first.fetch(:url)
    assert_equal "Bearer direct-secret", adapter.requests.first.fetch(:headers).fetch("authorization")
    refute adapter.requests.first.fetch(:headers).key?("x-global")
    refute_includes rpc.inspect, "customer.example/near"
    refute_includes rpc.inspect, "direct-secret"
    assert_equal({ "request_type" => "view_account", "account_id" => "alice", "finality" => "final" }, JSON.parse(adapter.requests.last.fetch(:body)).fetch("params"))
  end

  def test_selector_is_exclusive_and_typed
    rpc = ERPC::NearClient.new(transport_class.new(facts: facts, api_key: "key", adapter: adapter, namespace: "near.rpc")).rpc
    assert_raises(ERPC::ConfigError) { rpc.block({ "finality" => "final" }) }
    assert_raises(ERPC::ConfigError) { ERPC::NearBlockReference.height(-1) }
    assert_raises(ERPC::ConfigError) { ERPC::NearBlockReference.height(true) }
    assert_equal({ "block_id" => "hash" }, ERPC::NearBlockReference.from_hash("hash").to_h)
    assert_raises(ERPC::ConfigError) { ERPC::NearBlockReference.new(:finality, "invalid-finality") }
    assert_raises(ERPC::ConfigError) { ERPC::NearBlockReference.new(:unsupported, 1) }
  end

  def test_known_u64_fields_reject_negative_and_overflow_values
    status = {
      "chain_id" => "mainnet", "genesis_hash" => "genesis", "latest_protocol_version" => 1,
      "protocol_version" => 1,
      "sync_info" => {
        "latest_block_hash" => "hash", "latest_block_height" => 1, "latest_block_time" => "time",
        "latest_state_root" => "root", "syncing" => false
      },
      "version" => { "version" => "v", "build" => "b" }
    }
    [-1, 18_446_744_073_709_551_616].each do |value|
      assert_raises(ERPC::InvalidResponseError) { ERPC::NearStatus.from(status.merge("latest_protocol_version" => value)) }
      account = { "amount" => "1", "locked" => "0", "code_hash" => "h", "storage_usage" => 1,
                  "storage_paid_at" => value, "block_height" => 1, "block_hash" => "h" }
      assert_raises(ERPC::InvalidResponseError) { ERPC::NearAccountView.from(account) }
    end
  end

  def test_subclass_selector_injection_fails_before_adapter_io
    evil_class = Class.new(ERPC::NearBlockReference) do
      def to_h
        { "request_type" => "call_function", "account_id" => "overridden", "finality" => "invalid" }
      end
    end
    evil = evil_class.new(:finality, "final")
    rpc = ERPC::NearClient.new(transport_class.new(facts: facts, api_key: "key", adapter: adapter, namespace: "near.rpc")).rpc
    assert_raises(ERPC::ConfigError) { rpc.view_account("alice", evil) }
    assert_empty adapter.requests
  end

  def test_approved_native_getters_preserve_core_object_behavior
    header = ERPC::NearBlockHeader.from(
      "hash" => "wire-hash", "height" => 1, "prev_hash" => "prev", "timestamp" => 1,
      "timestamp_nanosec" => "1", "gas_price" => "1", "total_supply" => "2"
    )
    assert_equal "wire-hash", header.block_hash
    assert_kind_of Integer, header.hash
    assert_equal header, { header => true }.keys.first
    summary = ERPC::SuiObjectSummary.new(object_id: "0x1", version: 0, digest: "d")
    assert_equal "0x1", summary.sui_object_id
    assert_kind_of Integer, summary.object_id
    assert_equal summary, { summary => true }.keys.first
    assert_equal({ "block_id" => "wire-hash" }, ERPC::NearBlockReference.from_hash("wire-hash").to_h)
    assert_kind_of Integer, ERPC::NearBlockReference.hash
  end

  def test_near_public_method_values_are_deeply_immutable
    assert ERPC::NEAR_RPC_METHODS.frozen?
    assert ERPC::NEAR_RPC_METHODS.all?(&:frozen?)
    assert_raises(FrozenError) { ERPC::NEAR_RPC_METHODS.first.replace("unexpected_method") }
    assert_raises(NameError) { ERPC::NearHttpTransport }
    assert_raises(NameError) { ERPC::NearTokenScanner }
  end

  def test_hosted_auth_uses_query_key_without_injected_bearer_and_preserves_explicit_auth
    transport = transport_class.new(
      facts: facts,
      api_key: "shared-key",
      endpoint: "https://near.example/root?api-key=stale&region=eu",
      headers: { "x-global" => "hosted", "authorization" => "Bearer explicit-global" },
      adapter: adapter,
      namespace: "near.rpc"
    )
    transport.request("status", [])
    request = adapter.requests.last
    assert_equal "https://near.example/root?region=eu&api-key=shared-key", request.fetch(:url)
    assert_equal "Bearer explicit-global", request.fetch(:headers).fetch("authorization")
    assert_equal "hosted", request.fetch(:headers).fetch("x-global")
  end

  def test_direct_json_rpc_errors_redact_path_variants
    adapter = Object.new
    adapter.define_singleton_method(:request) do |**request|
      body = JSON.parse(request.fetch(:body))
      ERPC::HttpResponse.new(
        status: 200,
        body: JSON.generate(
          "jsonrpc" => "2.0", "id" => body.fetch("id"),
          "error" => {
            "code" => -32000,
            "message" => "%66oo foo fixture-secret Bearer fixture-secret",
            "data" => { "encodedPath" => "%66oo", "decodedPath" => "foo", "%66oo" => "fixture-secret", "count" => 7 }
          }
        )
      )
    end
    endpoint = ERPC::RpcEndpointConfig.new(
      http_url: "https://redact.fixture.invalid/%66oo?key=fixture-secret",
      headers: { "authorization" => "Bearer fixture-secret" }
    )
    rpc = ERPC::NearClient.new(transport_class.new(facts: facts, direct_endpoint: endpoint, adapter: adapter, namespace: "near.rpc")).rpc

    error = assert_raises(ERPC::JsonRpcError) { rpc.status.send }
    assert_equal(-32000, error.code)
    assert_equal "[REDACTED]", error.data.fetch("encodedPath")
    assert_equal "[REDACTED]", error.data.fetch("decodedPath")
    assert_equal "[REDACTED]", error.data.fetch("[REDACTED]")
    assert_equal 7, error.data.fetch("count")
    refute_includes error.message, "fixture-secret"
    refute_includes error.message, "%66oo"
  end

  def test_raw_known_u64_tokens_are_classified_before_json_normalization
    cases = {
      "status" => lambda do |token|
        %({"chain_id":"mainnet","genesis_hash":"g","latest_protocol_version":#{token},"protocol_version":1,"sync_info":{"latest_block_hash":"h","latest_block_height":1,"latest_block_time":"t","latest_state_root":"s","syncing":false},"version":{"version":"v","build":"b"}})
      end,
      "block" => lambda do |token|
        %({"author":"a","header":{"hash":"h","height":#{token},"prev_hash":"p","timestamp":1,"timestamp_nanosec":"1","gas_price":"1","total_supply":"2"},"chunks":[]})
      end,
      "query" => lambda do |token|
        %({"amount":"1","locked":"0","code_hash":"h","storage_usage":1,"storage_paid_at":#{token},"block_height":1,"block_hash":"h"})
      end
    }
    methods = { "status" => :status, "block" => :block, "query" => :view_account }
    ["0", "1", "18446744073709551615"].each do |token|
      cases.each do |method, builder|
        adapter = Object.new
        adapter.define_singleton_method(:request) do |**request|
          body = JSON.parse(request.fetch(:body))
          response = %({"jsonrpc":"2.0","id":#{body.fetch("id")},"result":#{builder.call(token)}})
          ERPC::HttpResponse.new(status: 200, body: response)
        end
        rpc = ERPC::NearClient.new(transport_class.new(facts: facts, api_key: "key", adapter: adapter, namespace: "near.rpc")).rpc
        pending = case methods.fetch(method)
                  when :status then rpc.status
                  when :block then rpc.block(ERPC::NearBlockReference.final)
                  else rpc.view_account("alice", ERPC::NearBlockReference.final)
                  end
        refute_nil pending.send
      end
    end

    ["-0", "-1", "1.0", "1e0", "18446744073709551616"].each do |token|
      adapter = Object.new
      adapter.define_singleton_method(:request) do |**request|
        body = JSON.parse(request.fetch(:body))
        response = %({"jsonrpc":"2.0","id":#{body.fetch("id")},"result":#{cases.fetch("status").call(token)}})
        ERPC::HttpResponse.new(status: 200, body: response)
      end
      rpc = ERPC::NearClient.new(transport_class.new(facts: facts, api_key: "key", adapter: adapter, namespace: "near.rpc")).rpc
      assert_raises(ERPC::InvalidResponseError) { rpc.status.send }
    end
  end

  def test_unknown_numeric_tokens_keep_existing_exact_policy_and_last_duplicate_wins
    adapter = Object.new
    adapter.define_singleton_method(:request) do |**request|
      body = JSON.parse(request.fetch(:body))
      raw = %({"jsonrpc":"2.0","id":#{body.fetch("id")},"result":{"chain_id":"mainnet","genesis_hash":"g","latest_protocol_version":0,"protocol_version":-0,"\\u0070rotocol_version":0,"sync_info":{"latest_block_hash":"h","latest_block_height":1,"latest_block_time":"t","latest_state_root":"s","syncing":false,"extra":1e-1000},"version":{"version":"v","build":"b"}}})
      ERPC::HttpResponse.new(status: 200, body: raw)
    end
    status = ERPC::NearClient.new(transport_class.new(facts: facts, api_key: "key", adapter: adapter, namespace: "near.rpc")).rpc.status.send
    assert_equal 0, status.protocol_version
    assert_equal BigDecimal("1e-1000"), status.sync_info.additional.fetch("extra")
  end

  def test_optional_duplicate_numeric_then_null_uses_the_last_decoded_key
    responses = [
      %({"amount":"1","locked":"0","code_hash":"h","storage_usage":0,"block_height":0,"block_hash":"h","storage_paid_at":-0,"storage_paid_at":null}),
      %({"amount":"1","locked":"0","code_hash":"h","storage_usage":0,"block_height":0,"block_hash":"h","storage_paid_at":null,"storage_paid_at":-0})
    ]
    responses.each_with_index do |result, index|
      adapter = Object.new
      adapter.define_singleton_method(:request) do |**request|
        body = JSON.parse(request.fetch(:body))
        ERPC::HttpResponse.new(status: 200, body: %({"jsonrpc":"2.0","id":#{body.fetch("id")},"result":#{result}}))
      end
      rpc = ERPC::NearClient.new(transport_class.new(facts: facts, api_key: "key", adapter: adapter, namespace: "near.rpc")).rpc
      if index.zero?
        assert_nil rpc.view_account("alice", ERPC::NearBlockReference.final).send.storage_paid_at
      else
        assert_raises(ERPC::InvalidResponseError) { rpc.view_account("alice", ERPC::NearBlockReference.final).send }
      end
    end
  end
end
