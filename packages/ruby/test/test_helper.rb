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
  end

  attr_writer :stream_chunks

  def request(**request)
    @requests << request
    @handler.call(request)
  end

  def stream(**request)
    @requests << request.merge(method: :stream)
    @stream_chunks.each
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
