# frozen_string_literal: true

require_relative "test_helper"
require "json"

class ArbitrumTest < Minitest::Test
  def facts
    @facts ||= ERPC.const_get(:SealedEvmContract, true).facts_from_contract(
      JSON.parse(File.read(File.expand_path("../../../registry/rpc-network-contract.json", __dir__))),
      "client-arbitrum-rpc"
    )
  end

  def transport_class
    ERPC.const_get(:SealedEvmHttpTransport, true)
  end

  def test_arbitrum_uses_three_named_reads_and_preserves_optional_params
    requests = []
    adapter = Object.new
    adapter.define_singleton_method(:request) do |**request|
      requests << request
      body = JSON.parse(request.fetch(:body))
      ERPC::HttpResponse.new(
        status: 200,
        body: JSON.generate("jsonrpc" => "2.0", "id" => body.fetch("id"), "result" => "0xa4b1")
      )
    end
    transport = transport_class.new(
      facts: facts,
      api_key: "key",
      adapter: adapter,
      namespace: "arbitrum.rpc"
    )
    rpc = ERPC::ArbitrumClient.new(transport).rpc
    assert_equal "0xa4b1", rpc.eth_chain_id.send
    assert_equal "0xa4b1", rpc.eth_get_balance("0xabc").send
    assert_equal "0xa4b1", rpc.eth_call({ "to" => "0xabc" }).send
    assert_equal %w[endpoint eth_call eth_chain_id eth_get_balance].sort, rpc.public_methods(false).map(&:to_s).sort
    refute rpc.respond_to?(:raw)
    assert_equal [], JSON.parse(requests[0].fetch(:body)).fetch("params")
    assert_equal ["0xabc"], JSON.parse(requests[1].fetch(:body)).fetch("params")
  end
end
