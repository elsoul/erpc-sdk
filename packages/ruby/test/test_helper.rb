# frozen_string_literal: true

require "json"
require "minitest/autorun"
require "uri"

require "erpc_sdk"

class FakeHttpAdapter
  attr_reader :requests

  def initialize(&handler)
    @handler = handler
    @requests = []
    @stream_chunks = []
    @stream_status = 200
  end

  attr_writer :stream_chunks, :stream_status

  def request(**request)
    @requests << request
    @handler.call(request)
  end

  def stream(**request)
    @requests << request.merge(method: :stream)
    @stream_chunks.each
  end

  # Additive streaming capability used by the dedicated Bitcoin transport.
  # Legacy request/stream behavior above remains unchanged.
  def request_stream(**request)
    @requests << request
    body = @stream_chunks.each
    return ERPC::HttpStreamResponse.new(status: @stream_status, body: body) unless block_given?

    yield(@stream_status, body)
  end
end

class FakeWebSocketTransport
  attr_reader :calls, :listeners

  def initialize(subscription_id)
    @subscription_id = subscription_id
    @calls = []
    @listeners = {}
    @next_listener_id = 0
    @closed = false
  end

  def request(method, params = nil)
    @calls << [method, params]
    return true if method.end_with?("Unsubscribe") || method == "eth_unsubscribe"

    @subscription_id
  end

  def on_notification(listener = nil, &block)
    selected = listener || block
    @next_listener_id += 1
    id = @next_listener_id
    @listeners[id] = selected
    -> { @listeners.delete(id) }
  end

  def notify(subscription_id, result)
    notification = {
      "jsonrpc" => "2.0",
      "method" => "notification",
      "params" => { "subscription" => subscription_id, "result" => result }
    }
    @listeners.values.dup.each { |listener| listener.call(notification) }
  end

  def close
    @closed = true
  end

  def closed?
    @closed
  end
end

module SealedChainTestSupport
  def exercise_sealed_chain(contract_id:, client_class:, rpc_client_name:)
    contract = JSON.parse(File.read(File.expand_path("../../../registry/rpc-network-contract.json", __dir__)))
    contract_factory = ERPC.const_get(:SealedEvmContract, true)
    transport_class = ERPC.const_get(:SealedEvmHttpTransport, true)
    facts = contract_factory.facts_from_contract(contract, contract_id)
    requests = []
    adapter = Object.new
    adapter.define_singleton_method(:request) do |**request|
      requests << request
      body = JSON.parse(request.fetch(:body))
      ERPC::HttpResponse.new(
        status: 200,
        body: JSON.generate("jsonrpc" => "2.0", "id" => body.fetch("id"), "result" => "0xresult")
      )
    end
    endpoint = ERPC::RpcEndpointConfig.new(
      http_url: "https://customer.example/#{rpc_client_name}?token=direct&region=eu",
      headers: { "authorization" => "Bearer direct-secret", "x-chain-scope" => rpc_client_name }
    )
    transport = transport_class.new(
      facts: facts,
      direct_endpoint: endpoint,
      adapter: adapter,
      namespace: "#{rpc_client_name}.rpc"
    )
    rpc = client_class.new(transport).rpc
    assert_equal "0xresult", rpc.eth_chain_id.send
    assert_equal "0xresult", rpc.eth_get_balance("0xabc", "latest").send
    assert_equal "0xresult", rpc.eth_call({ "to" => "0xabc" }, "latest", { "0xabc" => {} }).send
    assert_equal "https://customer.example/", rpc.endpoint
    assert_equal "https://customer.example/#{rpc_client_name}?token=direct&region=eu", requests.first.fetch(:url)
    assert_equal "Bearer direct-secret", requests.first.fetch(:headers).fetch("authorization")
    assert_equal rpc_client_name, requests.first.fetch(:headers).fetch("x-chain-scope")
    refute requests.first.fetch(:headers).key?("x-global")
    assert_equal ["0xabc", "latest"], JSON.parse(requests[1].fetch(:body)).fetch("params")
    assert_equal [ { "to" => "0xabc" }, "latest", { "0xabc" => {} } ], JSON.parse(requests[2].fetch(:body)).fetch("params")
    assert_equal %w[endpoint eth_call eth_chain_id eth_get_balance].sort, rpc.public_methods(false).map(&:to_s).sort
    refute rpc.respond_to?(:raw)
    refute rpc.respond_to?(:request)
  end
end
