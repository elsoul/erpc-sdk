# frozen_string_literal: true

require "json"
require "time"

module ERPC
  module Validation
    module_function

    def mapping(value)
      raise InvalidResponseError unless value.is_a?(Hash) && value.keys.all? { |key| key.is_a?(String) }

      value
    end

    def string(value)
      raise InvalidResponseError unless value.is_a?(String)

      value
    end

    def number(value, integer: false, nonnegative: false)
      valid = value.is_a?(Numeric) && value.finite?
      valid &&= value.is_a?(Integer) if integer
      valid &&= value >= 0 if nonnegative
      raise InvalidResponseError unless valid

      value
    end

    def datetime(value)
      text = string(value)
      Time.iso8601(text)
      text
    rescue ArgumentError
      raise InvalidResponseError
    end
  end

  class AccountClient
    def initialize(transport)
      @transport = transport
    end

    def get_token_balance
      data = Validation.mapping(@transport.get("/v3/erpc/token-balance"))
      unless %w[business developer free pro].include?(data["plan"])
        raise InvalidResponseError, "ERPC returned an invalid token balance"
      end
      Validation.number(data["max_tokens"], integer: true)
      Validation.number(data["remaining_tokens"], integer: true)
      Validation.string(data["next_refill_at"]) unless data["next_refill_at"].nil?
      data
    rescue InvalidResponseError
      raise InvalidResponseError, "ERPC returned an invalid token balance"
    end
  end

  class UsageClient
    YEAR_MONTH = /\A\d{4}-(0[1-9]|1[0-2])\z/
    private_constant :YEAR_MONTH

    def initialize(transport)
      @transport = transport
    end

    def get_monthly_api_key_usage(year_month = nil)
      if !year_month.nil? && !YEAR_MONTH.match?(year_month)
        raise ConfigError, "year_month must use YYYY-MM format"
      end

      envelope = Validation.mapping(@transport.get("/v3/user/api-keys/usage", "yearMonth" => year_month))
      raise InvalidResponseError unless envelope["success"] == true

      usage = Validation.mapping(envelope["message"])
      validate_usage(usage)
      usage
    rescue InvalidResponseError
      raise InvalidResponseError, "ERPC returned an invalid monthly API key usage response"
    end

    private

    def validate_usage(usage)
      raise InvalidResponseError unless YEAR_MONTH.match?(Validation.string(usage["yearMonth"]))

      %w[keyCount totalCount totalCredits].each { |field| Validation.number(usage[field]) }
      raise InvalidResponseError unless [true, false].include?(usage["hasStrandedUsage"])
      Validation.string(usage["updatedAt"]) unless usage["updatedAt"].nil?
      validate_chains(usage["chains"])
      raise InvalidResponseError unless usage["apiKeys"].is_a?(Array)

      usage["apiKeys"].each do |raw|
        item = Validation.mapping(raw)
        Validation.string(item["apiKeyLast4"])
        %w[apiKeyLength count credits].each { |field| Validation.number(item[field]) }
        Validation.number(item["keyId"]) unless item["keyId"].nil?
        Validation.string(item["updatedAt"]) unless item["updatedAt"].nil?
        validate_chains(item["chains"])
      end
    end

    def validate_chains(value)
      raise InvalidResponseError unless value.is_a?(Array)

      value.each do |raw_chain|
        chain = Validation.mapping(raw_chain)
        Validation.string(chain["chain"])
        %w[count credits].each { |field| Validation.number(chain[field]) }
        Validation.string(chain["updatedAt"]) unless chain["updatedAt"].nil?
        raise InvalidResponseError unless chain["methods"].is_a?(Array)

        chain["methods"].each do |raw_method|
          method = Validation.mapping(raw_method)
          Validation.string(method["method"])
          %w[count creditCost credits].each { |field| Validation.number(method[field]) }
          Validation.string(method["updatedAt"]) unless method["updatedAt"].nil?
        end
      end
    end
  end

  class PriceClient
    def initialize(transport)
      @transport = transport
    end

    def get_price_feeds(asset_type: nil, query: nil)
      value = @transport.get("/v2/price_feeds", "query" => query, "asset_type" => asset_type)
      raise InvalidResponseError, "ERPC returned invalid price feed metadata" unless value.is_a?(Array)

      value.each do |raw|
        metadata = Validation.mapping(raw)
        Validation.string(metadata["id"])
        attributes = metadata["attributes"]
        next if attributes.nil?
        unless attributes.is_a?(Hash) && attributes.all? { |key, item| key.is_a?(String) && item.is_a?(String) }
          raise InvalidResponseError, "ERPC returned invalid price feed metadata"
        end
      end
      value
    rescue InvalidResponseError
      raise InvalidResponseError, "ERPC returned invalid price feed metadata"
    end

    def get_latest_price_updates(ids:, encoding: nil, parsed: nil, ignore_invalid_price_ids: nil)
      value = @transport.get(
        "/v2/updates/price/latest",
        update_query(ids, encoding, parsed, ignore_invalid_price_ids)
      )
      price_update(value)
    end

    def get_price_updates_at_timestamp(publish_time, ids:, encoding: nil, parsed: nil,
                                       ignore_invalid_price_ids: nil)
      value = @transport.get(
        "/v2/updates/price/#{URLs.escape_path(publish_time)}",
        update_query(ids, encoding, parsed, ignore_invalid_price_ids)
      )
      price_update(value)
    end

    def get_latest_publisher_stake_caps(encoding: nil, parsed: nil)
      Validation.mapping(
        @transport.get(
          "/v2/updates/publisher_stake_caps/latest",
          "encoding" => encoding,
          "parsed" => parsed
        )
      )
    end

    def stream_price_updates(ids:, encoding: nil, parsed: nil, ignore_invalid_price_ids: nil,
                             allow_unordered: nil, benchmarks_only: nil)
      query = update_query(ids, encoding, parsed, ignore_invalid_price_ids).merge(
        "allow_unordered" => allow_unordered,
        "benchmarks_only" => benchmarks_only
      )
      chunks = @transport.stream("/v2/updates/price/stream", query)
      Enumerator.new do |yielder|
        buffer = +""
        chunks.each do |chunk|
          buffer << chunk
          while (boundary = buffer.match(/\r?\n\r?\n/))
            block = buffer.slice!(0, boundary.end(0))
            event = parse_sse_block(block.sub(/\r?\n\r?\n\z/, ""))
            yielder << event if event
          end
        end
        event = parse_sse_block(buffer)
        yielder << event if event
      end
    end

    private

    def update_query(ids, encoding, parsed, ignore_invalid_price_ids)
      {
        "ids[]" => ids,
        "encoding" => encoding,
        "parsed" => parsed,
        "ignore_invalid_price_ids" => ignore_invalid_price_ids
      }
    end

    def price_update(value)
      update = Validation.mapping(value)
      binary = Validation.mapping(update["binary"])
      data = binary["data"]
      valid = data.is_a?(Array) && data.all? { |item| item.is_a?(String) }
      valid &&= binary["encoding"].is_a?(String)
      valid &&= update["parsed"].is_a?(Array) if update.key?("parsed")
      raise InvalidResponseError, "ERPC returned an invalid price update" unless valid

      update
    rescue InvalidResponseError
      raise InvalidResponseError, "ERPC returned an invalid price update"
    end

    def parse_sse_block(block)
      data = []
      result = {}
      block.each_line(chomp: true) do |line|
        next if line.empty? || line.start_with?(":")

        field, separator, raw = line.partition(":")
        value = separator.empty? ? "" : raw.sub(/\A /, "")
        data << value if field == "data"
        result[field] = value if %w[event id].include?(field)
      end
      return nil if data.empty?

      result["data"] = price_update(JSON.parse(data.join("\n")))
      result
    rescue JSON::ParserError, InvalidResponseError
      raise InvalidResponseError, "ERPC returned malformed stream data"
    end
  end

  class CloudCatalogClient
    RESOURCE_KINDS = %w[bare-metal solana-grpc solana-shredstream vps].freeze
    RESOURCE_MODES = %w[dedicated direct shared].freeze

    def initialize(transport)
      @transport = transport
    end

    def list
      envelope = Validation.mapping(@transport.get("/v4/cloud/catalog"))
      message = Validation.mapping(envelope["message"])
      offerings = message["offerings"]
      raise InvalidResponseError unless envelope["success"] == true && offerings.is_a?(Array)

      offerings.each do |raw|
        item = Validation.mapping(raw)
        %w[id name description].each { |field| Validation.string(item[field]) }
        raise InvalidResponseError unless RESOURCE_KINDS.include?(item["kind"])
        raise InvalidResponseError if item["mode"] && !RESOURCE_MODES.include?(item["mode"])
        %w[regions capabilities].each do |field|
          array = item[field]
          raise InvalidResponseError unless array.is_a?(Array) && array.all? { |entry| entry.is_a?(String) }
        end
      end
      offerings
    rescue InvalidResponseError
      raise InvalidResponseError, "ERPC returned an invalid Cloud catalog"
    end
  end

  class CloudCreditClient
    ALERT_LEVELS = %w[critical normal suspended warning].freeze

    def initialize(transport)
      @transport = transport
    end

    def get
      envelope = Validation.mapping(@transport.get("/v4/cloud/credit"))
      raise InvalidResponseError unless envelope["success"] == true

      credit = Validation.mapping(envelope["message"])
      raise InvalidResponseError unless ALERT_LEVELS.include?(credit["alertLevel"])
      Validation.number(credit["balanceCents"], integer: true)
      Validation.number(credit["burnRateCentsPerHour"], integer: true, nonnegative: true)
      Validation.number(credit["timeToZeroHours"], nonnegative: true) unless credit["timeToZeroHours"].nil?
      Validation.datetime(credit["quoteTimestamp"])
      Validation.datetime(credit["quoteExpiresAt"])
      credit
    rescue InvalidResponseError
      raise InvalidResponseError, "ERPC returned an invalid Cloud credit snapshot"
    end
  end

  class CloudResourcesClient
    RESOURCE_KINDS = CloudCatalogClient::RESOURCE_KINDS
    RESOURCE_MODES = CloudCatalogClient::RESOURCE_MODES
    BILLING_STATUSES = %w[active grace-period inactive suspended].freeze

    def initialize(transport)
      @transport = transport
    end

    def list
      envelope = Validation.mapping(@transport.get("/v4/cloud/resources"))
      message = Validation.mapping(envelope["message"])
      resources = message["resources"]
      raise InvalidResponseError unless envelope["success"] == true && resources.is_a?(Array)

      resources.each { |resource| validate_resource(resource) }
      resources
    rescue InvalidResponseError
      raise InvalidResponseError, "ERPC returned an invalid Cloud resource list"
    end

    def get(resource_id)
      value = @transport.get("/v4/cloud/resources/#{URLs.escape_path(normalize_id(resource_id))}")
      envelope = Validation.mapping(value)
      message = Validation.mapping(envelope["message"])
      raise InvalidResponseError unless envelope["success"] == true

      validate_resource(message["resource"])
    rescue InvalidResponseError
      raise InvalidResponseError, "ERPC returned an invalid Cloud resource"
    end

    def get_status(resource_id)
      path = "/v4/cloud/resources/#{URLs.escape_path(normalize_id(resource_id))}/status"
      envelope = Validation.mapping(@transport.get(path))
      raise InvalidResponseError unless envelope["success"] == true

      status = Validation.mapping(envelope["message"])
      Validation.string(status["id"])
      Validation.string(status["status"])
      validate_billing(status["billing"]) if status.key?("billing")
      status
    rescue InvalidResponseError
      raise InvalidResponseError, "ERPC returned an invalid Cloud resource status"
    end

    private

    def normalize_id(value)
      result = value.to_s.strip
      raise ConfigError, "resource_id must not be empty" if result.empty?

      result
    end

    def validate_resource(value)
      resource = Validation.mapping(value)
      Validation.string(resource["id"])
      Validation.string(resource["status"])
      raise InvalidResponseError unless RESOURCE_KINDS.include?(resource["kind"])
      raise InvalidResponseError if resource["mode"] && !RESOURCE_MODES.include?(resource["mode"])
      %w[name region createdAt].each do |field|
        Validation.string(resource[field]) unless resource[field].nil?
      end
      resource
    end

    def validate_billing(value)
      billing = Validation.mapping(value)
      raise InvalidResponseError unless BILLING_STATUSES.include?(billing["status"])
      Validation.number(billing["hourlyCredits"], nonnegative: true) if billing.key?("hourlyCredits")
      %w[nextChargeAt graceEndsAt].each do |field|
        Validation.datetime(billing[field]) if billing.key?(field)
      end
    end
  end
end
