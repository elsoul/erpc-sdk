# frozen_string_literal: true

require_relative "test_helper"

class RestTest < Minitest::Test
  def test_keyless_price_sse_fails_locally_without_http_io
    calls = 0
    adapter = FakeHttpAdapter.new do
      calls += 1
      raise "keyless SSE should not use HTTP"
    end
    erpc = ERPC::Client.new(
      ERPC::ClientConfig.new(
        ethereum_rpc: ERPC::RpcEndpointConfig.new(http_url: "https://customer.example/rpc")
      ),
      http_adapter: adapter
    )

    assert_raises(ERPC::NotConfiguredError) do
      erpc.price.stream_price_updates(ids: ["feed"]).to_a
    end
    assert_equal 0, calls
    assert_empty adapter.requests
  ensure
    erpc&.close
  end

  def test_price_rest_uses_bearer_and_repeated_ids
    adapter = FakeHttpAdapter.new do |request|
      assert_equal "Bearer secret", request[:headers]["authorization"]
      uri = URI.parse(request[:url])
      assert_equal "/v2/updates/price/latest", uri.path
      assert_equal ["feed-a", "feed-b"], URI.decode_www_form(uri.query).filter_map { |key, value| value if key == "ids[]" }
      assert_includes URI.decode_www_form(uri.query), ["parsed", "true"]
      ERPC::HttpResponse.new(
        status: 200,
        body: JSON.generate("binary" => { "data" => ["value"], "encoding" => "base64" })
      )
    end
    erpc = ERPC::Client.new(
      ERPC::ClientConfig.new(api_key: "secret", endpoint: "https://example.test"),
      http_adapter: adapter
    )

    result = erpc.price.get_latest_price_updates(ids: %w[feed-a feed-b], parsed: true)
    assert_equal "base64", result.dig("binary", "encoding")
  ensure
    erpc&.close
  end

  def test_price_sse_parses_event_fields_and_data
    update = { "binary" => { "data" => [], "encoding" => "hex" } }
    adapter = FakeHttpAdapter.new { raise "ordinary request should not be used" }
    adapter.stream_chunks = ["id: 7\nevent: price_update\ndata: #{JSON.generate(update)}\n", "\n"]
    erpc = ERPC::Client.new(ERPC::ClientConfig.new(api_key: "secret"), http_adapter: adapter)

    assert_equal(
      [{ "id" => "7", "event" => "price_update", "data" => update }],
      erpc.price.stream_price_updates(ids: ["feed"]).to_a
    )
  ensure
    erpc&.close
  end

  def test_usage_validates_year_month_before_transport
    adapter = FakeHttpAdapter.new { raise "network should not be reached" }
    erpc = ERPC::Client.new(ERPC::ClientConfig.new(api_key: "secret"), http_adapter: adapter)

    assert_raises(ERPC::ConfigError) { erpc.usage.get_monthly_api_key_usage("2026-13") }
    assert_empty adapter.requests
  ensure
    erpc&.close
  end

  def test_usage_unwraps_and_validates_envelope
    usage = {
      "apiKeys" => [],
      "chains" => [],
      "hasStrandedUsage" => false,
      "keyCount" => 0,
      "totalCount" => 0,
      "totalCredits" => 0,
      "updatedAt" => nil,
      "yearMonth" => "2026-08"
    }
    adapter = FakeHttpAdapter.new do |request|
      assert_includes URI.decode_www_form(URI.parse(request[:url]).query), ["yearMonth", "2026-08"]
      ERPC::HttpResponse.new(status: 200, body: JSON.generate("success" => true, "message" => usage))
    end
    erpc = ERPC::Client.new(ERPC::ClientConfig.new(api_key: "secret"), http_adapter: adapter)

    assert_equal usage, erpc.usage.get_monthly_api_key_usage("2026-08")
  ensure
    erpc&.close
  end

  def test_cloud_rejects_non_local_http_and_redacts_token
    assert_raises(ERPC::ConfigError) do
      ERPC::CloudClientConfig.new(access_token: "token", endpoint: "http://example.test")
    end
    config = ERPC::CloudClientConfig.new(access_token: " top-secret ", endpoint: "http://localhost:9000/")
    refute_includes config.inspect, "top-secret"
    assert_equal "http://localhost:9000/", config.endpoint
  end

  def test_cloud_catalog_and_resource_paths_are_scoped_reads
    paths = []
    adapter = FakeHttpAdapter.new do |request|
      uri = URI.parse(request[:url])
      paths << uri.path
      assert_equal "Bearer access", request[:headers]["authorization"]
      if uri.path.end_with?("/catalog")
        body = {
          "success" => true,
          "message" => {
            "offerings" => [{
              "id" => "vps-small",
              "kind" => "vps",
              "name" => "Small",
              "description" => "Small compute",
              "regions" => ["eu"],
              "capabilities" => ["compute"]
            }]
          }
        }
      else
        body = {
          "success" => true,
          "message" => { "resource" => { "id" => "a/b", "kind" => "vps", "status" => "ready" } }
        }
      end
      ERPC::HttpResponse.new(status: 200, body: JSON.generate(body))
    end
    cloud = ERPC::CloudClient.new(
      ERPC::CloudClientConfig.new(access_token: "access", endpoint: "https://example.test/base"),
      http_adapter: adapter
    )

    assert_equal "vps-small", cloud.catalog.list.first["id"]
    assert_equal "ready", cloud.resources.get("a/b")["status"]
    assert_equal ["/base/v4/cloud/catalog", "/base/v4/cloud/resources/a%2Fb"], paths
  end

  def test_invalid_account_response_is_rejected
    adapter = FakeHttpAdapter.new do
      ERPC::HttpResponse.new(status: 200, body: JSON.generate("plan" => "unknown"))
    end
    erpc = ERPC::Client.new(ERPC::ClientConfig.new(api_key: "secret"), http_adapter: adapter)

    assert_raises(ERPC::InvalidResponseError) { erpc.account.get_token_balance }
  ensure
    erpc&.close
  end
end
