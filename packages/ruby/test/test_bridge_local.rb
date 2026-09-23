# frozen_string_literal: true

require_relative "test_helper"
require "base64"
require "digest"
require "json"

class LocalFixtureCancellation
  def initialize
    @cancelled = false
  end

  def cancel!
    @cancelled = true
  end

  def cancelled?
    @cancelled
  end
end

class LocalFixtureAdapter
  attr_reader :requests

  def initialize(fixture, source_mocks:, rpc_mocks:, event: nil, cancellation: nil)
    @fixture = fixture
    @source_mocks = source_mocks
    @rpc_mocks = rpc_mocks
    @event = event
    @cancellation = cancellation
    @requests = []
  end

  def request(**request)
    if %w[credential-forwarding hosted-build-attempt].include?(@event)
      raise ERPC::BridgeError.new(ERPC::BridgeErrorCode::LOCAL_PLAN_INVALID), cause: RuntimeError.new("fixture event injected")
    end
    @requests << request
    if @event == "rpc-transport-error"
      raise RuntimeError, "fixture rpc transport"
    end
    if %w[source-swap-timeout rpc-timeout].include?(@event)
      raise ERPC::TimeoutError.new(0.001), cause: RuntimeError.new("fixture timeout")
    end
    if %w[source-swap-abort rpc-abort].include?(@event)
      @cancellation&.cancel!
      raise ERPC::TransportError.new("fixture abort"), cause: RuntimeError.new("fixture abort cause")
    end

    if request.fetch(:method).to_sym == :get
      mock = @source_mocks.values.find { |value| value.fetch("request") == trace_for(request) }
    else
      actual = request_body(request[:body])
      mock = @rpc_mocks.values.find do |value|
        expected = value.fetch("request")
        expected_body = request_body(expected.fetch("body"))
        expected.fetch("url") == request.fetch(:url) &&
          expected_body && actual && expected_body.fetch("method") == actual.fetch("method") &&
          expected_body.fetch("params") == actual.fetch("params")
      end
    end
    raise RuntimeError, "unexpected local provider request" unless mock

    response = mock.fetch("response")
    ERPC::HttpResponse.new(status: response.fetch("status"), body: response.fetch("body"))
  end

  private

  def request_body(value)
    value.nil? ? nil : JSON.parse(value)
  rescue JSON::ParserError
    nil
  end

  def trace_for(request)
    headers = request.fetch(:headers).transform_keys(&:downcase)
    %w[host content-length user-agent].each { |name| headers.delete(name) }
    {
      "method" => request.fetch(:method).to_s.upcase,
      "url" => request.fetch(:url),
      "headers" => headers,
      "body" => request.fetch(:body, nil)
    }
  end
end

class LocalChunkedResponse
  attr_reader :status

  def initialize(status, chunks, delay: 0, on_chunk: nil)
    @status = status
    @chunks = chunks
    @delay = delay
    @on_chunk = on_chunk
    @closed = false
  end

  def read_body
    @chunks.each do |chunk|
      sleep(@delay) if @delay.positive?
      yield chunk
      @on_chunk&.call
    end
  end

  def close
    @closed = true
  end

  def closed?
    @closed
  end
end

class LocalStreamingAdapter < LocalFixtureAdapter
  attr_reader :responses

  def initialize(*args, delay: 0, on_chunk: nil, **kwargs)
    super(*args, **kwargs)
    @delay = delay
    @on_chunk = on_chunk
    @responses = []
  end

  def request(**request)
    response = super
    chunks = response.body.to_s.scan(/.{1,4096}/m)
    streamed = LocalChunkedResponse.new(response.status, chunks, delay: @delay, on_chunk: @on_chunk)
    @responses << streamed
    streamed
  end
end

class LocalControlledResponse
  attr_reader :status, :headers, :read_count, :close_count

  def initialize(status:, body:, headers: {}, delay: 0, forbid_body: false)
    @status = status
    @body = body
    @headers = headers
    @delay = delay
    @forbid_body = forbid_body
    @read_count = 0
    @close_count = 0
  end

  def body
    raise "eager body getter was used" if @forbid_body

    @body
  end

  def read_body
    @read_count += 1
    sleep(@delay) if @delay.positive?
    yield @body
  end

  def close
    @close_count += 1
  end
end

class LocalControlledAdapter
  attr_reader :requests

  def initialize(response, delay: 0)
    @response = response
    @delay = delay
    @requests = []
  end

  def request(**request)
    @requests << request
    sleep(@delay) if @delay.positive?
    @response
  end
end

class BridgeLocalTest < Minitest::Test
  ROOT = File.expand_path("../../..", __dir__)
  FIXTURE_PATH = File.join(ROOT, "registry", "fixtures", "mayan-swift-v2-local-build-cases.json")
  FIXTURE = JSON.parse(File.read(FIXTURE_PATH)).freeze
  FIXTURE_LOCAL_DIGEST = "19b1a9d601e7dedaf4e5ad8f8cbe9c7aec0d2b1f2f625b56eea53c48b16ee2d1"

  def self.native_capture_behavior
    runs, = new("native-capture").send(:replay_cases)
    {
      "prepareSourceSwap" => runs.select { |case_id, _| case_id.start_with?("prepare-") }.sort_by(&:first).map do |case_id, (outcome, http_trace, rpc_trace)|
        { "caseId" => case_id, "outcome" => outcome, "httpTrace" => http_trace, "rpcTrace" => rpc_trace }
      end,
      "buildLocalUnsigned" => runs.select { |case_id, _| case_id.start_with?("build-") }.sort_by(&:first).map do |case_id, (outcome, http_trace, rpc_trace)|
        { "caseId" => case_id, "outcome" => outcome, "httpTrace" => http_trace, "rpcTrace" => rpc_trace }
      end
    }
  end

  def test_replays_all_local_cases_through_public_methods
    assert_equal 1, FIXTURE.fetch("schemaVersion")
    assert_equal "mayan-swift-v2-local-build-fixtures", FIXTURE.fetch("fixtureKind")
    assert_equal FIXTURE_LOCAL_DIGEST, FIXTURE.fetch("localFixtureDigest")
    runs, plans = replay_cases
    FIXTURE.fetch("cases").each do |entry|
      outcome, http_trace, rpc_trace = runs.fetch(entry.fetch("caseId"))
      assert_equal entry.fetch("expected"), outcome, entry.fetch("caseId")
      assert_equal entry.fetch("httpTrace"), http_trace, entry.fetch("caseId")
      assert_equal entry.fetch("rpcTrace"), rpc_trace, entry.fetch("caseId")
    end
    assert_equal 5, plans.length
  end

  def test_direct_usdc_preparation_performs_no_source_io
    entry = FIXTURE.fetch("cases").find { |item| item.fetch("caseId") == "prepare-usdc-ethereum-to-solana" }
    quote = quote_for(entry.fetch("quoteId"))
    adapter = LocalFixtureAdapter.new(FIXTURE, source_mocks: {}, rpc_mocks: {})
    client = client_for(entry, adapter)
    plan = client.prepare_source_swap(context_for(entry, quote))
    assert_equal({ "kind" => "none" }, plan.fetch("sourceSwap"))
    assert_empty adapter.requests
  ensure
    client&.close
  end

  def test_mutable_public_context_strings_are_snapshotted
    entry = FIXTURE.fetch("cases").find { |item| item.fetch("caseId") == "prepare-eurc-ethereum-to-solana" }
    quote = quote_for(entry.fetch("quoteId"))
    swapper = entry.fetch("context").fetch("swapperAddress").dup
    destination = entry.fetch("context").fetch("destinationAddress").dup
    source_mocks = mocks_for(entry, nil, :source)
    rpc_mocks = mocks_for(entry, nil, :rpc)
    adapter = LocalFixtureAdapter.new(FIXTURE, source_mocks: source_mocks, rpc_mocks: rpc_mocks)
    original_request = adapter.method(:request)
    adapter.define_singleton_method(:request) do |**request|
      swapper.replace("0x#{'b' * 40}")
      destination.replace("So11111111111111111111111111111111111111112")
      original_request.call(**request)
    end
    client = client_for(entry, adapter)
    value = client.prepare_source_swap({
      "quote" => quote,
      "swapperAddress" => swapper,
      "destinationAddress" => destination,
      "orderNonce" => entry.fetch("context").fetch("orderNonce")
    })
    assert_equal entry.fetch("context").fetch("swapperAddress"), value.fetch("swapperAddress")
    assert_equal entry.fetch("context").fetch("destinationAddress"), value.fetch("destinationAddress")
    refute swapper.frozen?
    refute destination.frozen?
  ensure
    client&.close
  end

  def test_local_public_errors_have_no_native_cause_or_secrets
    entry = FIXTURE.fetch("cases").find { |item| item.fetch("caseId") == "build-usdc-rpc-transport" }
    quote = quote_for(entry.fetch("quoteId"))
    plan_entry = FIXTURE.fetch("cases").find { |item| item.fetch("caseId") == "prepare-usdc-ethereum-to-solana" }
    plan = prepare_plan(plan_entry)
    adapter = LocalFixtureAdapter.new(
      FIXTURE,
      source_mocks: {},
      rpc_mocks: mocks_for(entry, entry.fetch("mutation"), :rpc),
      event: "rpc-transport-error"
    )
    client = client_for(entry, adapter)
    error = assert_raises(ERPC::BridgeError) do
      client.build_local_unsigned(context_for(entry, quote).merge("sourceSwapPlan" => plan))
    end
    assert_equal ERPC::BridgeErrorCode::SOURCE_RPC_TRANSPORT, error.code
    assert_nil error.cause
    refute_includes error.full_message, "fixture rpc transport"
  ensure
    client&.close
  end

  def test_local_client_constructor_performs_no_io
    calls = 0
    adapter = Object.new
    adapter.define_singleton_method(:request) { |**| calls += 1 }
    client = ERPC::MayanSwiftV2BridgeClient.new(
      "localBuild" => { "ethereumRpc" => { "httpUrl" => "https://ethereum.example/rpc" } },
      http_adapter: adapter
    )
    client.close
    assert_equal 0, calls
  ensure
    client&.close
  end

  def test_zip215_and_pda_boundaries_are_checked_by_native_helpers
    local = ERPC::MayanSwiftV2BridgeLocal
    identity = "\x01" + ("\0" * 31)
    assert local.is_on_curve_zip215(identity)
    signed_identity = identity.dup
    signed_identity.setbyte(31, signed_identity.getbyte(31) | 0x80)
    assert local.is_on_curve_zip215(signed_identity)

    noncanonical_y = "\xed" + ("\xff" * 30) + "\x7f"
    assert local.is_on_curve_zip215(noncanonical_y)
    refute local.is_on_curve_zip215("\x02" * 32)

    assert local.find_program_address(["STATE_SOURCE".b], local::SOLANA_SWIFT_PROGRAM).last.between?(0, 255)
    assert_raises(local::LocalValidationError) do
      local.find_program_address(["x" * 33], local::SOLANA_SWIFT_PROGRAM)
    end
    assert_raises(local::LocalValidationError) do
      local.find_program_address(Array.new(17) { "x".b }, local::SOLANA_SWIFT_PROGRAM)
    end
  end

  def test_rpc_body_timeout_abort_and_size_are_enforced_while_streaming
    positive = FIXTURE.fetch("cases").find { |item| item.fetch("caseId") == "prepare-usdc-ethereum-to-solana" }
    plan = prepare_plan(positive)
    solana_positive = FIXTURE.fetch("cases").find { |item| item.fetch("caseId") == "prepare-usdc-solana-to-ethereum" }
    solana_plan = prepare_plan(solana_positive)

    timeout_entry = FIXTURE.fetch("cases").find { |item| item.fetch("caseId") == "build-usdc-rpc-timeout" }
    timeout_adapter = LocalStreamingAdapter.new(
      FIXTURE,
      source_mocks: {},
      rpc_mocks: mocks_for(timeout_entry, timeout_entry.fetch("mutation"), :rpc),
      delay: 0.02
    )
    timeout_client = client_for(timeout_entry, timeout_adapter, mutation: timeout_entry.fetch("mutation"))
    timeout_error = assert_raises(ERPC::BridgeError) do
      timeout_client.build_local_unsigned(context_for(timeout_entry, quote_for(timeout_entry.fetch("quoteId"))).merge("sourceSwapPlan" => solana_plan))
    end
    assert_equal ERPC::BridgeErrorCode::TIMEOUT, timeout_error.code
    assert timeout_adapter.responses.any?(&:closed?)

    abort_entry = FIXTURE.fetch("cases").find { |item| item.fetch("caseId") == "build-usdc-rpc-abort" }
    cancellation = LocalFixtureCancellation.new
    abort_adapter = LocalStreamingAdapter.new(
      FIXTURE,
      source_mocks: {},
      rpc_mocks: mocks_for(abort_entry, abort_entry.fetch("mutation"), :rpc),
      on_chunk: -> { cancellation.cancel! }
    )
    abort_client = client_for(abort_entry, abort_adapter, mutation: abort_entry.fetch("mutation"))
    abort_error = assert_raises(ERPC::BridgeError) do
      abort_client.build_local_unsigned(
        context_for(abort_entry, quote_for(abort_entry.fetch("quoteId"))).merge("sourceSwapPlan" => solana_plan),
        cancellation
      )
    end
    assert_equal ERPC::BridgeErrorCode::ABORTED, abort_error.code
    assert abort_adapter.responses.any?(&:closed?)

    size_entry = FIXTURE.fetch("cases").find { |item| item.fetch("caseId") == "build-usdc-rpc-size-limit" }
    size_adapter = LocalStreamingAdapter.new(
      FIXTURE,
      source_mocks: {},
      rpc_mocks: mocks_for(size_entry, size_entry.fetch("mutation"), :rpc)
    )
    size_client = client_for(size_entry, size_adapter, mutation: size_entry.fetch("mutation"))
    size_error = assert_raises(ERPC::BridgeError) do
      size_client.build_local_unsigned(context_for(size_entry, quote_for(size_entry.fetch("quoteId"))).merge("sourceSwapPlan" => plan))
    end
    assert_equal ERPC::BridgeErrorCode::SOURCE_RPC_INVALID_RESPONSE, size_error.code
    assert size_adapter.responses.any?(&:closed?)
  ensure
    timeout_client&.close
    abort_client&.close
    size_client&.close
  end

  def test_source_body_keeps_one_deadline_and_disposes_all_early_responses
    entry = FIXTURE.fetch("cases").find { |item| item.fetch("caseId") == "prepare-eurc-ethereum-to-solana" }
    quote = quote_for(entry.fetch("quoteId"))
    context = context_for(entry, quote)
    source_body = FIXTURE.fetch("sourceSwapMocks").find { |mock| mock.fetch("mockId") == entry.fetch("sourceSwapMockIds").fetch(0) }.fetch("response").fetch("body")

    http_error_response = LocalControlledResponse.new(status: 500, body: source_body)
    http_error_client = ERPC::MayanSwiftV2BridgeClient.new(timeout: 0.2, minimum_quote_validity_seconds: 0, http_adapter: LocalControlledAdapter.new(http_error_response))
    http_error_client.instance_variable_set(:@clock, -> { quote.fetch("deadline").to_i - 1 })
    error = assert_raises(ERPC::BridgeError) { http_error_client.prepare_source_swap(context) }
    assert_equal ERPC::BridgeErrorCode::PROVIDER_HTTP, error.code
    assert_operator http_error_response.close_count, :>, 0

    oversized_response = LocalControlledResponse.new(
      status: 200,
      body: source_body,
      headers: { "content-length" => (ERPC::MayanSwiftV2BridgeLocal::MAX_RESPONSE_BYTES + 1).to_s }
    )
    oversized_client = ERPC::MayanSwiftV2BridgeClient.new(timeout: 0.2, minimum_quote_validity_seconds: 0, http_adapter: LocalControlledAdapter.new(oversized_response))
    oversized_client.instance_variable_set(:@clock, -> { quote.fetch("deadline").to_i - 1 })
    error = assert_raises(ERPC::BridgeError) { oversized_client.prepare_source_swap(context) }
    assert_equal ERPC::BridgeErrorCode::PROVIDER_INVALID_RESPONSE, error.code
    assert_equal 0, oversized_response.read_count
    assert_operator oversized_response.close_count, :>, 0

    streaming_response = LocalControlledResponse.new(status: 200, body: source_body, forbid_body: true)
    streaming_client = ERPC::MayanSwiftV2BridgeClient.new(timeout: 0.2, minimum_quote_validity_seconds: 0, http_adapter: LocalControlledAdapter.new(streaming_response))
    streaming_client.instance_variable_set(:@clock, -> { quote.fetch("deadline").to_i - 1 })
    plan = streaming_client.prepare_source_swap(context)
    assert_equal "evm-router", plan.fetch("sourceSwap").fetch("kind")
    assert_equal 1, streaming_response.read_count
    assert_equal 0, streaming_response.close_count

    combined_response = LocalControlledResponse.new(status: 200, body: source_body, delay: 0.06)
    combined_client = ERPC::MayanSwiftV2BridgeClient.new(timeout: 0.1, minimum_quote_validity_seconds: 0, http_adapter: LocalControlledAdapter.new(combined_response, delay: 0.06))
    combined_client.instance_variable_set(:@clock, -> { quote.fetch("deadline").to_i - 1 })
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    error = assert_raises(ERPC::BridgeError) { combined_client.prepare_source_swap(context) }
    elapsed = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started
    assert_equal ERPC::BridgeErrorCode::TIMEOUT, error.code
    assert_operator elapsed, :<, 0.14
    assert_operator combined_response.close_count, :>, 0

    cancellation = LocalFixtureCancellation.new
    pending_response = LocalControlledResponse.new(status: 200, body: source_body, delay: 0.3)
    pending_client = ERPC::MayanSwiftV2BridgeClient.new(timeout: 1.0, minimum_quote_validity_seconds: 0, http_adapter: LocalControlledAdapter.new(pending_response))
    pending_client.instance_variable_set(:@clock, -> { quote.fetch("deadline").to_i - 1 })
    canceller = Thread.new { sleep(0.02); cancellation.cancel! }
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    error = assert_raises(ERPC::BridgeError) { pending_client.prepare_source_swap(context, cancellation) }
    elapsed = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started
    assert_equal ERPC::BridgeErrorCode::ABORTED, error.code
    assert_operator elapsed, :<, 0.2
    assert_operator pending_response.close_count, :>, 0
  ensure
    canceller&.join
    http_error_client&.close
    oversized_client&.close
    streaming_client&.close
    combined_client&.close
    pending_client&.close
  end

  private

  def quote_for(quote_id)
    FIXTURE.fetch("quotes").find { |record| record.fetch("quoteId") == quote_id }.fetch("normalizedQuote")
  end

  def context_for(entry, quote)
    context = entry.fetch("context")
    {
      "quote" => quote,
      "swapperAddress" => context.fetch("swapperAddress"),
      "destinationAddress" => context.fetch("destinationAddress"),
      "orderNonce" => context.fetch("orderNonce")
    }
  end

  def client_for(entry, adapter, mutation: nil)
    config = deep_clone(entry.fetch("config"))
    config.fetch("localBuild", {}).delete("altValidation") if config["localBuild"].is_a?(Hash)
    if mutation && mutation["kind"] == "config-set"
      set_path(config, mutation.fetch("path"), mutation.fetch("value"))
    end
    config["minimumQuoteValiditySeconds"] = 0
    event = entry.fetch("mutation", nil)
    if event && event["kind"] == "transport" && %w[source-swap-timeout rpc-timeout].include?(event["event"])
      config["timeoutMs"] = 5
    end
    client = ERPC::MayanSwiftV2BridgeClient.new(config, http_adapter: adapter)
    quote = quote_for(entry.fetch("quoteId"))
    client.instance_variable_set(:@clock, -> { quote.fetch("deadline").to_i - 1 })
    client
  end

  def prepare_plan(entry)
    quote = quote_for(entry.fetch("quoteId"))
    adapter = LocalFixtureAdapter.new(
      FIXTURE,
      source_mocks: mocks_for(entry, nil, :source),
      rpc_mocks: {}
    )
    client = client_for(entry, adapter)
    client.prepare_source_swap(context_for(entry, quote))
  ensure
    client&.close
  end

  def replay_cases
    plans = {}
    FIXTURE.fetch("cases").select { |entry| entry.fetch("method") == "prepareSourceSwap" && entry.fetch("mutation", nil).nil? }.each do |entry|
      plans[entry.fetch("caseId")] = prepare_plan(entry)
    end
    runs = {}
    FIXTURE.fetch("cases").each do |entry|
      outcome, http_trace, rpc_trace = run_case(entry, plans)
      runs[entry.fetch("caseId")] = [outcome, http_trace, rpc_trace]
    end
    [runs, plans]
  end

  def run_case(entry, plans)
    mutation = entry.fetch("mutation", nil)
    quote = mutate_quote(quote_for(entry.fetch("quoteId")), mutation)
    context = context_for(entry, quote)
    source_mocks = mocks_for(entry, mutation, :source)
    rpc_mocks = mocks_for(entry, mutation, :rpc)
    cancellation = LocalFixtureCancellation.new
    event = mutation && mutation["kind"] == "transport" ? mutation["event"] : nil
    adapter = LocalFixtureAdapter.new(FIXTURE, source_mocks: source_mocks, rpc_mocks: rpc_mocks, event: event, cancellation: cancellation)
    client = client_for(entry, adapter, mutation: mutation)
    options = event && event.end_with?("abort") ? cancellation : nil
    value = if entry.fetch("method") == "prepareSourceSwap"
              client.prepare_source_swap(context, options)
            else
              plan = deep_clone(plans.fetch(entry.fetch("sourceSwapPlanRef")))
              plan = mutate_plan(plan, mutation)
              client.build_local_unsigned(context.merge("sourceSwapPlan" => plan), options)
            end
    [{ "kind" => "success", "value" => value }, trace_for(adapter), rpc_trace_for(adapter)]
  rescue ERPC::BridgeError => error
    outcome = { "kind" => "sdk-error", "code" => error.code, "message" => error.message }
    outcome["status"] = error.status unless error.status.nil?
    [outcome, trace_for(adapter), rpc_trace_for(adapter)]
  rescue StandardError
    [{ "kind" => "transport-error", "sourcePreserved" => true }, trace_for(adapter), rpc_trace_for(adapter)]
  ensure
    client&.close
  end

  def mocks_for(entry, mutation, kind)
    ids = entry.fetch(kind == :source ? "sourceSwapMockIds" : "rpcMockIds")
    source = FIXTURE.fetch(kind == :source ? "sourceSwapMocks" : "rpcMocks")
    envelope_mutated = false
    source.each_with_object({}) do |mock, result|
      next unless ids.include?(mock.fetch("mockId"))
      copy = deep_clone(mock)
      if kind == :source && mutation && mutation["kind"] == "source-swap-response-set"
        body = JSON.parse(copy.fetch("response").fetch("body"))
        set_path(body, mutation.fetch("path"), mutation.fetch("value"))
        copy["response"]["body"] = JSON.generate(body)
      elsif kind == :rpc
        if mutation && mutation["kind"] == "rpc-envelope-set"
          mutate_rpc_mock!(copy, mutation) unless envelope_mutated
          envelope_mutated = true
        else
          mutate_rpc_mock!(copy, mutation)
        end
      end
      result[copy.fetch("mockId")] = copy
    end
  end

  def mutate_rpc_mock!(mock, mutation)
    return if mutation.nil?
    body = JSON.parse(mock.fetch("request").fetch("body"))
    response = JSON.parse(mock.fetch("response").fetch("body"))
    if mutation["kind"] == "boundary"
      return unless body["method"] == "getMultipleAccounts"
      encoded = Base64.strict_encode64("\x01\0\0\0".b + ("\xff".b * 8) + ("\0".b * 44))
      Array(response.dig("result", "value")).each do |account|
        account["data"][0] = encoded if account.is_a?(Hash) && account["data"].is_a?(Array)
      end
    elsif mutation["kind"] == "rpc-envelope-set"
      path = mutation.fetch("path")
      case path
      when "id", "jsonrpc"
        response[path] = mutation.fetch("value")
      when "version"
        response.delete("jsonrpc")
        response["version"] = mutation.fetch("value")
      when "depth"
        depth = Integer(mutation.fetch("value"))
        nested = response.fetch("result")
        depth.times { nested = { "nested" => nested } }
        response["result"] = nested
      when "size"
        response["result"] = "x" * Integer(mutation.fetch("value"))
      else
        raise "unsupported RPC envelope mutation"
      end
    elsif mutation["kind"] == "rpc-response-set"
      path = mutation.fetch("path")
      prefix = "#{body.fetch('method')}."
      return unless path.start_with?(prefix)
      response_path = path.delete_prefix(prefix)
      set_path(response, response_path == "result" ? "result" : "result.#{response_path}", mutation.fetch("value"))
    else
      return
    end
    mock["response"]["body"] = JSON.generate(response)
  end

  def mutate_quote(quote, mutation)
    result = deep_clone(quote)
    return result unless mutation && %w[quote-normalized-set quote-raw-set].include?(mutation["kind"])
    if mutation["kind"] == "quote-normalized-set"
      set_path(result, mutation.fetch("path"), mutation.fetch("value"))
    else
      raw = JSON.parse(result.fetch("rawSignedQuoteJson"))
      set_path(raw, mutation.fetch("path"), mutation.fetch("value"))
      result["rawSignedQuoteJson"] = JSON.generate(raw)
    end
    result
  end

  def mutate_plan(plan, mutation)
    return plan unless mutation && mutation["kind"] == "plan-set"
    set_path(plan, mutation.fetch("path"), mutation.fetch("value"))
    plan
  end

  def set_path(root, path, value)
    parts = path.gsub(/\[(\d+)\]/, '.\\1').split('.')
    raise "invalid mutation path" if parts.empty?
    cursor = root
    parts[0...-1].each do |part|
      cursor = cursor.is_a?(Array) ? cursor.fetch(Integer(part)) : cursor.fetch(part)
    end
    leaf = parts.fetch(-1)
    if cursor.is_a?(Array)
      cursor[Integer(leaf)] = value
    else
      cursor[leaf] = value
    end
  end

  def deep_clone(value)
    JSON.parse(JSON.generate(value))
  end

  def trace_for(adapter)
    return [] if adapter.nil?
    adapter.requests.select { |request| request.fetch(:method).to_sym == :get }.map { |request| trace_entry(request) }
  end

  def rpc_trace_for(adapter)
    return [] if adapter.nil?
    adapter.requests.reject { |request| request.fetch(:method).to_sym == :get }.map { |request| trace_entry(request) }
  end

  def trace_entry(request)
    headers = request.fetch(:headers).transform_keys(&:downcase)
    %w[host content-length user-agent].each { |name| headers.delete(name) }
    {
      "method" => request.fetch(:method).to_s.upcase,
      "url" => request.fetch(:url),
      "headers" => headers,
      "body" => request.fetch(:body, nil)
    }
  end
end
