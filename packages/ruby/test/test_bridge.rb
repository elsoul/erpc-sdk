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
end
