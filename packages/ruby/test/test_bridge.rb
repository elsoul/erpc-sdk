# frozen_string_literal: true

require_relative "test_helper"
require "fileutils"

class BridgeCancellationFlag
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

class BridgeFixtureAdapter
  attr_reader :requests

  def initialize(entry, cancellation)
    @entry = entry
    @cancellation = cancellation
    @requests = []
  end

  def request(**request)
    @requests << request
    case @entry.fetch("caseId")
    when "quote-timeout"
      raise ERPC::TimeoutError, 0.001
    when "quote-aborted"
      @cancellation.cancel!
      raise ERPC::TransportError, "caller cancelled"
    end

    body = @entry.fetch("providerBody")
    body = "x" * (1024 * 1024 + 1) if body == "__SYNTHETIC_BODY_EXCEEDS_1MIB__"
    ERPC::HttpResponse.new(status: @entry.fetch("providerStatus") || 200, body: body)
  end
end

class BridgeMutationAdapter
  attr_reader :requests

  def initialize(body, &mutation)
    @body = body
    @mutation = mutation
    @requests = []
  end

  def request(**request)
    @requests << request
    @mutation&.call(request)
    ERPC::HttpResponse.new(status: 200, body: @body)
  end
end

class BridgeTest < Minitest::Test
  ROOT = File.expand_path("../../..", __dir__)
  FIXTURE_PATH = File.join(ROOT, "registry", "fixtures", "mayan-swift-v2-cases.json")
  FIXTURE = JSON.parse(File.read(FIXTURE_PATH)).freeze

  def test_replays_literal_quote_build_status_and_safety_fixture
    assert_equal 1, FIXTURE.fetch("schemaVersion")
    assert_equal "mayan-swift-v2-fixtures", FIXTURE.fetch("fixtureKind")
    assert_equal ERPC::BRIDGE_CAPABILITIES_AS_OF_DATE, FIXTURE.fetch("capabilityAsOfDate")
    assert_equal ERPC::BRIDGE_CAPABILITIES_CONTENT_DIGEST, FIXTURE.fetch("capabilityDigest")

    quotes = {}
    FIXTURE.fetch("cases").each do |entry|
      outcome, trace = run_case(entry, quotes)
      assert_equal entry.fetch("expected"), outcome, entry.fetch("caseId")
      assert_equal entry.fetch("httpTrace"), trace, entry.fetch("caseId")
    end
  end

  def test_constructs_without_io_and_close_is_idempotent
    calls = 0
    adapter = Object.new
    adapter.define_singleton_method(:request) do |**|
      calls += 1
      raise "unexpected provider request"
    end
    client = ERPC::MayanSwiftV2BridgeClient.new(http_adapter: adapter)
    client.close
    client.close
    assert_equal 0, calls
  end

  def test_configuration_and_errors_do_not_expose_provider_key
    config = ERPC::MayanSwiftV2BridgeConfig.new(
      builder_api_key: "bridge-secret",
      http_adapter: BridgeFixtureAdapter.new(FIXTURE.fetch("cases").first, BridgeCancellationFlag.new)
    )
    refute_includes config.inspect, "bridge-secret"
    error = ERPC::BridgeError.new(ERPC::BridgeErrorCode::PROVIDER_HTTP, 429)
    refute_includes error.message, "bridge-secret"
  end

  def test_public_methods_snapshot_strings_without_freezing_callers
    quote_case = FIXTURE.fetch("cases").find { |entry| entry.fetch("caseId") == "quote-eth-sol-synthetic" }
    quote_body = quote_case.fetch("providerBody")
    original_amount = "100000000".dup
    quote_request = quote_case.fetch("request").merge("amountIn" => original_amount)
    quote_adapter = BridgeMutationAdapter.new(quote_body) { original_amount.replace("999999999") }
    quote_client = ERPC::MayanSwiftV2BridgeClient.new(http_adapter: quote_adapter)
    quote_client.instance_variable_set(:@clock, -> { quote_case.fetch("nowSeconds") })
    begin
      quote = quote_client.quote_exact_input(quote_request).first
      assert_equal "100000000", quote.fetch("amountIn")
      assert_equal "999999999", original_amount
      refute original_amount.frozen?
      assert_includes quote_adapter.requests.fetch(0).fetch(:body), '"amountIn64":"100000000"'
    ensure
      quote_client.close
    end

    changed_body = quote_body.sub('"effectiveAmountIn64":"100000000"', '"effectiveAmountIn64":"999999999"')
    changed_amount = "100000000".dup
    changed_request = quote_case.fetch("request").merge("amountIn" => changed_amount)
    changed_adapter = BridgeMutationAdapter.new(changed_body) { changed_amount.replace("888888888") }
    changed_client = ERPC::MayanSwiftV2BridgeClient.new(http_adapter: changed_adapter)
    changed_client.instance_variable_set(:@clock, -> { quote_case.fetch("nowSeconds") })
    begin
      error = assert_raises(ERPC::BridgeError) { changed_client.quote_exact_input(changed_request) }
      assert_equal ERPC::BridgeErrorCode::PROVIDER_INVALID_RESPONSE, error.code
      assert_equal "888888888", changed_amount
      refute changed_amount.frozen?
    ensure
      changed_client.close
    end

    build_case = FIXTURE.fetch("cases").find { |entry| entry.fetch("caseId") == "build-eth-sol-synthetic" }
    swapper = "0x2222222222222222222222222222222222222222".dup
    destination = "So11111111111111111111111111111111111111112".dup
    build_request = build_case.fetch("request").merge(
      "swapperAddress" => swapper,
      "destinationAddress" => destination,
      "quote" => quote
    )
    build_adapter = BridgeMutationAdapter.new(build_case.fetch("providerBody")) do
      swapper.replace("0x3333333333333333333333333333333333333333")
      destination.replace("So11111111111111111111111111111111111111112")
    end
    build_client = ERPC::MayanSwiftV2BridgeClient.new(
      allow_unauthenticated_build: true,
      http_adapter: build_adapter
    )
    build_client.instance_variable_set(:@clock, -> { build_case.fetch("nowSeconds") })
    begin
      build = build_client.build_unsigned(build_request)
      assert_equal "0x2222222222222222222222222222222222222222", build.fetch("transaction").fetch("from")
      assert_includes build_adapter.requests.fetch(0).fetch(:body), '"swapperAddress":"0x2222222222222222222222222222222222222222"'
      assert_equal "0x3333333333333333333333333333333333333333", swapper
      refute swapper.frozen?
      refute destination.frozen?
    ensure
      build_client.close
    end

    status_case = FIXTURE.fetch("cases").find { |entry| entry.fetch("caseId") == "status-eth-inprogress-synthetic" }
    source_hash = status_case.fetch("request").fetch("sourceTransactionHash").dup
    status_request = status_case.fetch("request").merge("sourceTransactionHash" => source_hash)
    status_adapter = BridgeMutationAdapter.new(status_case.fetch("providerBody")) { source_hash.replace("0x#{'b' * 64}") }
    status_client = ERPC::MayanSwiftV2BridgeClient.new(http_adapter: status_adapter)
    status_client.instance_variable_set(:@clock, -> { status_case.fetch("nowSeconds") })
    begin
      status = status_client.get_status(status_request)
      assert_equal status_case.fetch("request").fetch("sourceTransactionHash"), status.fetch("sourceTransactionHash")
      assert_includes status_adapter.requests.fetch(0).fetch(:url), status_case.fetch("request").fetch("sourceTransactionHash")
      assert_equal "0x#{'b' * 64}", source_hash
      refute source_hash.frozen?
    ensure
      status_client.close
    end
  end

  def test_public_bridge_errors_drop_native_causes
    request = FIXTURE.fetch("cases").first.fetch("request")
    transport_sentinel = "bridge-transport-cause-sentinel"
    transport_adapter = Object.new
    transport_adapter.define_singleton_method(:request) do |**|
      raise RuntimeError, transport_sentinel
    end
    transport_client = ERPC::MayanSwiftV2BridgeClient.new(http_adapter: transport_adapter)
    transport_error = assert_raises(ERPC::BridgeError) { transport_client.quote_exact_input(request) }
    assert_safe_bridge_error(transport_error, ERPC::BridgeErrorCode::PROVIDER_TRANSPORT, transport_sentinel)

    timeout_sentinel = "bridge-timeout-cause-sentinel"
    timeout_adapter = Object.new
    timeout_adapter.define_singleton_method(:request) do |**|
      native = ERPC::TimeoutError.new(0.001)
      raise native, cause: RuntimeError.new(timeout_sentinel)
    end
    timeout_client = ERPC::MayanSwiftV2BridgeClient.new(http_adapter: timeout_adapter)
    timeout_error = assert_raises(ERPC::BridgeError) { timeout_client.quote_exact_input(request) }
    assert_safe_bridge_error(timeout_error, ERPC::BridgeErrorCode::TIMEOUT, timeout_sentinel)

    url_sentinel = "bridge-url-cause-sentinel"
    url_error = assert_raises(ERPC::BridgeError) do
      ERPC::MayanSwiftV2BridgeClient.new(builder_endpoint: "https://[#{url_sentinel}")
    end
    assert_safe_bridge_error(url_error, ERPC::BridgeErrorCode::INVALID_ARGUMENT, url_sentinel)
  ensure
    transport_client&.close
    timeout_client&.close
  end

  def test_writes_actual_native_capture_only_when_requested
    output_path = ENV["ERPC_SDK_BRIDGE_PARITY_OUTPUT"]
    return if output_path.nil? || output_path.empty?

    quotes = {}
    behavior = { "quote" => [], "build" => [], "status" => [] }
    FIXTURE.fetch("cases").each do |entry|
      outcome, trace = run_case(entry, quotes)
      assert_equal entry.fetch("expected"), outcome, entry.fetch("caseId")
      assert_equal entry.fetch("httpTrace"), trace, entry.fetch("caseId")
      behavior.fetch(entry.fetch("method")) << {
        "caseId" => entry.fetch("caseId"),
        "outcome" => outcome,
        "httpTrace" => trace
      }
    end
    behavior.each_value { |entries| entries.sort_by! { |entry| entry.fetch("caseId") } }
    package_kind = ENV["ERPC_SDK_BRIDGE_PARITY_PACKAGE"] == "dist" ? "built-gem" : "source"
    snapshot = {
      "snapshotVersion" => 1,
      "snapshotKind" => "bridge-native-runtime",
      "language" => "ruby",
      "runtime" => "ruby-#{package_kind}-#{RUBY_VERSION}",
      "capabilityAsOfDate" => ERPC::BRIDGE_CAPABILITIES_AS_OF_DATE,
      "capabilityDigest" => ERPC::BRIDGE_CAPABILITIES_CONTENT_DIGEST,
      "behavior" => behavior
    }
    FileUtils.mkdir_p(File.dirname(output_path))
    File.write(output_path, JSON.pretty_generate(snapshot) + "\n")
    assert_operator File.size(output_path), :>, 0
  end

  private

  def run_case(entry, quotes)
    cancellation = BridgeCancellationFlag.new
    adapter = BridgeFixtureAdapter.new(entry, cancellation)
    config = (entry.fetch("config", nil) || {}).dup
    client = ERPC::MayanSwiftV2BridgeClient.new(config, http_adapter: adapter)
    client.instance_variable_set(:@clock, -> { entry.fetch("nowSeconds") })

    value = case entry.fetch("method")
            when "quote"
              options = entry.fetch("caseId") == "quote-aborted" ? cancellation : nil
              client.quote_exact_input(entry.fetch("request"), options).tap do |quotes_result|
                quotes[entry.fetch("caseId")] = quotes_result.first unless quotes_result.empty?
              end
            when "build"
              request = entry.fetch("request").merge("quote" => quotes.fetch(entry.fetch("quoteCaseId")))
              client.build_unsigned(request)
            when "status"
              client.get_status(entry.fetch("request"))
            end
    [{ "kind" => "success", "value" => value }, trace_for(adapter)]
  rescue ERPC::BridgeError => error
    outcome = { "kind" => "sdk-error", "code" => error.code, "message" => error.message }
    outcome["status"] = error.status unless error.status.nil?
    [outcome, trace_for(adapter)]
  rescue StandardError
    [{ "kind" => "transport-error", "sourcePreserved" => true }, trace_for(adapter)]
  ensure
    client&.close
  end

  def trace_for(adapter)
    adapter.requests.map do |request|
      headers = request.fetch(:headers).transform_keys(&:downcase)
      assert(!headers.key?("authorization"))
      assert(!headers.key?("cookie"))
      %w[host content-length user-agent].each { |name| headers.delete(name) }
      {
        "method" => request.fetch(:method).to_s.upcase,
        "url" => request.fetch(:url),
        "headers" => headers,
        "body" => request.fetch(:body, nil)
      }
    end
  end

  def assert_safe_bridge_error(error, code, sentinel)
    assert_equal code, error.code
    assert_nil error.cause
    refute_includes error.message, sentinel
    refute_includes error.inspect, sentinel
    refute_includes error.full_message, sentinel
  end
end
