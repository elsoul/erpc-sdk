# frozen_string_literal: true

require_relative "test_helper"
require "fileutils"

class SwapExecutionTest < Minitest::Test
  ROOT = File.expand_path("../../..", __dir__)
  FIXTURE_PATH = File.join(ROOT, "registry", "fixtures", "swap-execution-cases.json")
  FIXTURE = JSON.parse(File.read(FIXTURE_PATH)).freeze

  def test_replays_every_shared_preparation_and_simulation_case
    assert_equal 1, FIXTURE.fetch("schemaVersion")
    assert_equal "swap-execution-fixtures", FIXTURE.fetch("fixtureKind")
    assert_equal ERPC::SWAP_EXECUTION_CAPABILITIES_AS_OF_DATE, FIXTURE.fetch("capabilityAsOfDate")
    assert_equal ERPC::SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST, FIXTURE.fetch("capabilityDigest")

    FIXTURE.fetch("cases").each do |entry|
      outcome, trace = run_fixture_case(entry)
      assert_equal expected_outcome(entry), outcome, entry.fetch("caseId")
      assert_equal entry.fetch("rpcTrace"), trace, entry.fetch("caseId")
    end
  end

  def test_preserves_calldata_and_stops_before_router_simulation_on_insufficient_allowance
    preparation_case = find_case("prepare-ethereum-weth-usdc-forward")
    allowance_case = find_case("allowance-below-required")

    preparation, = run_fixture_case(preparation_case)
    expected = expected_outcome(preparation_case)
    assert_equal expected.fetch("value").fetch("transaction"), preparation.fetch("value").fetch("transaction")

    allowance, trace = run_fixture_case(allowance_case)
    assert_equal expected_outcome(allowance_case), allowance
    assert_equal 17, trace.length
    refute(trace.any? do |entry|
      entry.fetch("params").to_s.include?(ERPC::SWAP_EXECUTION_FUNCTION_SELECTOR)
    end)
  end

  def test_execution_error_codes_and_messages_are_stable
    error = ERPC::SwapExecutionError.new(ERPC::SwapExecutionErrorCode::INVALID_ARGUMENT)
    assert_equal "SWAP_EXECUTION_INVALID_ARGUMENT", error.code
    assert_equal "Swap execution request is invalid", error.message

    error = ERPC::SwapExecutionError.new(ERPC::SwapExecutionErrorCode::UNSUPPORTED_EXECUTION)
    assert_equal "SWAP_UNSUPPORTED_EXECUTION", error.code
    assert_equal "Swap execution is unsupported for the selected records", error.message
  end

  def test_native_capture_is_written_only_when_requested
    output_path = ENV["ERPC_SDK_SWAP_EXECUTION_PARITY_OUTPUT"]
    return if output_path.nil? || output_path.empty?

    behavior = { "prepare" => [], "simulate" => [] }
    FIXTURE.fetch("cases").each do |entry|
      outcome, trace = run_fixture_case(entry)
      behavior.fetch(entry.fetch("method")) << {
        "caseId" => entry.fetch("caseId"),
        "outcome" => outcome,
        "rpcTrace" => trace
      }
    end
    behavior.each_value { |entries| entries.sort_by! { |entry| entry.fetch("caseId") } }

    package_kind = ENV["ERPC_SDK_SWAP_EXECUTION_PARITY_PACKAGE"] == "dist" ? "built-gem" : "source"
    snapshot = {
      "snapshotVersion" => 1,
      "snapshotKind" => "swap-execution-native-runtime",
      "language" => "ruby",
      "runtime" => "ruby-#{package_kind}-#{RUBY_VERSION}",
      "capabilityAsOfDate" => ERPC::SWAP_EXECUTION_CAPABILITIES_AS_OF_DATE,
      "capabilityDigest" => ERPC::SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST,
      "behavior" => behavior
    }
    FileUtils.mkdir_p(File.dirname(output_path))
    File.write(output_path, JSON.pretty_generate(snapshot) + "\n")
    assert_operator File.size(output_path), :>, 0
  end

  private

  def find_case(case_id)
    FIXTURE.fetch("cases").find { |entry| entry.fetch("caseId") == case_id }.tap do |entry|
      raise "missing execution fixture #{case_id}" unless entry
    end
  end

  def expected_outcome(entry)
    expected = JSON.parse(JSON.generate(entry.fetch("outcome")))
    return expected unless expected.fetch("kind") == "success" && expected.fetch("value").is_a?(Hash)

    value = expected.fetch("value")
    preparation = value.fetch("preparation", value)
    preparation["executionCapabilityDigest"] = ERPC::SWAP_EXECUTION_CAPABILITIES_CONTENT_DIGEST
    quote = preparation["quote"]
    if quote.is_a?(Hash)
      quote["tokenCatalogDigest"] = ERPC::TokenCatalog::TOKEN_CATALOG_CONTENT_DIGEST
      quote["dexCatalogDigest"] = ERPC::DexCatalog::DEX_CATALOG_CONTENT_DIGEST
    end
    expected
  end

  def run_fixture_case(entry)
    trace = []
    request = JSON.parse(JSON.generate(entry.fetch("request")))
    adapter = fixture_adapter(entry, request, trace)
    client = ERPC::Client.new(
      ERPC::ClientConfig.new(api_key: "capture-secret", endpoint: "https://example.test"),
      http_adapter: adapter
    )
    client.swap.instance_variable_set(:@clock, -> { entry.fetch("nowSeconds") })

    outcome = begin
      value = if entry.fetch("mutation", nil) == "cancelBeforeFirstRpc"
                client.swap.simulate_exact_input_swap(request, cancelled: true)
              elsif entry.fetch("method") == "prepare"
                client.swap.prepare_exact_input_swap(request)
              else
                client.swap.simulate_exact_input_swap(request)
              end
      { "kind" => "success", "value" => value }
    rescue ERPC::SwapExecutionError, ERPC::SwapQuoteError => error
      { "kind" => "sdk-error", "code" => error.code }
    rescue StandardError
      { "kind" => "transport-error", "sourcePreserved" => true }
    end
    [outcome, trace]
  ensure
    client&.close
  end

  def fixture_adapter(entry, request, trace)
    response_index = 0
    FakeHttpAdapter.new do |http_request|
      body = JSON.parse(http_request.fetch(:body))
      trace << { "method" => body.fetch("method"), "params" => body.fetch("params", []) }
      mutation = entry.fetch("mutation", nil)
      raise "upstream provider detail" if mutation == "preflightProviderError"

      if mutation == "changeRequestAfterAwait" && trace.length == 1
        request.merge!(
          "sender" => "0xcccccccccccccccccccccccccccccccccccccc",
          "recipient" => "0xdddddddddddddddddddddddddddddddddddddd",
          "slippageBps" => 9_999,
          "deadline" => "1789498801",
          "amountIn" => "1"
        )
      end

      first_param = body.fetch("params", []).first
      final_simulation = body.fetch("method") == "eth_call" &&
        first_param.is_a?(Hash) &&
        first_param.fetch("data", "").start_with?(ERPC::SWAP_EXECUTION_FUNCTION_SELECTOR)
      if final_simulation && %w[routerRevert routerProviderError routerRevertCode3 routerNonRevertCode3].include?(mutation)
        code, message = case mutation
                        when "routerRevert"
                          [-32_000, "execution reverted"]
                        when "routerProviderError"
                          [-32_000, "provider unavailable"]
                        when "routerRevertCode3"
                          [3, "execution reverted: ERC20: transfer amount exceeds balance"]
                        else
                          [3, "invalid router request"]
                        end
        next ERPC::HttpResponse.new(
          status: 200,
          body: JSON.generate(
            "jsonrpc" => "2.0",
            "id" => body.fetch("id"),
            "error" => { "code" => code, "message" => message }
          )
        )
      end

      result = entry.fetch("rpcResponses").fetch(response_index)
      response_index += 1
      result = mutate_execution_response(mutation, trace.length - 1, result)
      ERPC::HttpResponse.new(
        status: 200,
        body: JSON.generate("jsonrpc" => "2.0", "id" => body.fetch("id"), "result" => result)
      )
    end
  end

  def mutate_execution_response(mutation, index, result)
    case mutation
    when "emptyRouterCode"
      index == 11 ? "0x" : result
    when "wrongFactory"
      index == 12 ? execution_address_word("0x1111111111111111111111111111111111111111") : result
    when "wrongWrapped"
      index == 13 ? execution_address_word("0x2222222222222222222222222222222222222222") : result
    when "malformedRouterQuote"
      index == 14 ? "0x20" : result
    when "wrongRouterQuote"
      index == 14 && result.is_a?(String) && result.length > 2 ? result[0...-1] + "b" : result
    when "quoteStale"
      index == 9 ? stale_header : result
    when "staleAfterRouter"
      index == 15 ? stale_header : result
    else
      result
    end
  end

  def execution_address_word(address)
    "0x#{'0' * 24}#{address.delete_prefix('0x')}"
  end

  def stale_header
    {
      "number" => "0x18c7f20",
      "hash" => "0x#{'aa' * 32}",
      "timestamp" => "0x6aa99537"
    }
  end
end
