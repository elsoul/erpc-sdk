# frozen_string_literal: true

require_relative "test_helper"
require "json"

class BaseTest < Minitest::Test
  def facts
    @facts ||= ERPC.const_get(:SealedEvmContract, true).facts_from_contract(
      JSON.parse(File.read(File.expand_path("../../../registry/rpc-network-contract.json", __dir__))),
      "client-base-rpc"
    )
  end

  def transport_class
    ERPC.const_get(:SealedEvmHttpTransport, true)
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
        ERPC::HttpResponse.new(
          status: 200,
          body: JSON.generate("jsonrpc" => "2.0", "id" => body.fetch("id"), "result" => "0x2105")
        )
      end
    end.new
  end

  def test_direct_facade_preserves_exact_target_and_scoped_headers
    endpoint = ERPC::RpcEndpointConfig.new(
      http_url: "https://customer.example/base/path?token=a%2Fb&region=eu",
      headers: { "authorization" => "Bearer direct-secret", "x-chain-scope" => "base-only" }
    )
    transport = transport_class.new(
      facts: facts,
      direct_endpoint: endpoint,
      adapter: adapter,
      namespace: "base.rpc"
    )
    rpc = ERPC::BaseClient.new(transport).rpc

    assert_equal "0x2105", rpc.eth_chain_id.send
    assert_equal "0x2105", rpc.eth_get_balance("0xabc", "latest").send
    assert_equal "0x2105", rpc.eth_call({ "to" => "0xabc" }, "latest", { "0xabc" => {} }).send
    assert_equal "https://customer.example/", rpc.endpoint
    assert_equal "https://customer.example/base/path?token=a%2Fb&region=eu", adapter.requests.first.fetch(:url)
    assert_equal "Bearer direct-secret", adapter.requests.first.fetch(:headers).fetch("authorization")
    assert_equal "base-only", adapter.requests.first.fetch(:headers).fetch("x-chain-scope")
    assert_equal ["0xabc", "latest"], JSON.parse(adapter.requests[1].fetch(:body)).fetch("params")
  end

  def test_hosted_query_key_and_no_extra_suffix
    transport = transport_class.new(
      facts: facts,
      api_key: "shared-key",
      endpoint: "https://base.example/customer?api-key=stale&region=eu",
      adapter: adapter,
      namespace: "base.rpc"
    )
    assert_equal "0x2105", transport.request("eth_chainId", [])
    assert_equal "https://base.example/customer?region=eu&api-key=shared-key", adapter.requests.first.fetch(:url)
    assert_equal "https://base.example/", transport.endpoint
  end

  def test_direct_json_rpc_errors_redact_path_variants_without_rounding_numbers
    adapter_instance = adapter
    adapter_instance.define_singleton_method(:request) do |**request|
      body = JSON.parse(request.fetch(:body))
      ERPC::HttpResponse.new(
        status: 200,
        body: JSON.generate(
          "jsonrpc" => "2.0", "id" => body.fetch("id"),
          "error" => {
            "code" => -32000,
            "message" => "%66oo foo fixture-secret Bearer fixture-secret",
            "data" => { "encodedPath" => "%66oo", "decodedPath" => "foo", "count" => 7, "fraction" => 0.5 }
          }
        )
      )
    end
    endpoint = ERPC::RpcEndpointConfig.new(
      http_url: "https://redact.fixture.invalid/%66oo?key=fixture-secret",
      headers: { "authorization" => "Bearer fixture-secret" }
    )
    rpc = ERPC::BaseClient.new(transport_class.new(facts: facts, direct_endpoint: endpoint, adapter: adapter_instance, namespace: "base.rpc")).rpc

    error = assert_raises(ERPC::JsonRpcError) { rpc.eth_chain_id.send }
    assert_equal(-32000, error.code)
    assert_equal "[REDACTED]", error.data.fetch("encodedPath")
    assert_equal "[REDACTED]", error.data.fetch("decodedPath")
    assert_equal 7, error.data.fetch("count")
    assert_instance_of BigDecimal, error.data.fetch("fraction")
    assert_equal BigDecimal("0.5"), error.data.fetch("fraction")
    refute_includes error.message, "fixture-secret"
    refute_includes error.message, "%66oo"
  end

  def test_surface_has_only_three_reads
    rpc = ERPC::BaseClient.new(
      transport_class.new(facts: facts, api_key: "key", adapter: adapter, namespace: "base.rpc")
    ).rpc
    assert_equal %w[endpoint eth_call eth_chain_id eth_get_balance inspect].sort, rpc.public_methods(false).map(&:to_s).sort
    refute_includes rpc.inspect, "customer.example"
    refute_includes rpc.inspect, "direct-secret"
    refute rpc.respond_to?(:raw)
    refute rpc.respond_to?(:request)
    assert_raises(NameError) { ERPC::SealedEvmHttpTransport }
  end

  def test_unconfigured_is_local_and_websocket_is_rejected
    transport = transport_class.new(facts: facts, adapter: adapter, namespace: "base.rpc")
    error = assert_raises(ERPC::NotConfiguredError) { transport.request("eth_chainId", []) }
    assert_equal "base.rpc", error.namespace
    assert_empty adapter.requests

    endpoint = ERPC::RpcEndpointConfig.new(http_url: "https://node.example", websocket_url: "wss://node.example")
    assert_raises(ERPC::ConfigError) do
      transport_class.new(facts: facts, direct_endpoint: endpoint, adapter: adapter, namespace: "base.rpc")
    end
  end

  def test_public_method_values_cannot_mutate_private_wire_routing
    assert ERPC::BASE_RPC_METHODS.frozen?
    assert ERPC::BASE_RPC_METHODS.all?(&:frozen?)
    assert_raises(FrozenError) { ERPC::BASE_RPC_METHODS.first.replace("unexpected_method") }
    assert_equal "eth_chainId", facts.wire_method("eth_chain_id")
  end
end
