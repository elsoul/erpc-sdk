# frozen_string_literal: true

require "bigdecimal"

require_relative "near_transport"

module ERPC
  module NearFinality
    FINAL = "final".freeze
    OPTIMISTIC = "optimistic".freeze
    VALUES = [FINAL, OPTIMISTIC].freeze
  end

  class NearBlockReference
    attr_reader :kind, :value

    def self.final
      new(:finality, NearFinality::FINAL)
    end

    def self.optimistic
      new(:finality, NearFinality::OPTIMISTIC)
    end

    def self.height(value)
      new(:block_id, validate_height(value))
    end

    def self.from_hash(value)
      raise ConfigError, "NEAR block hash must be a non-empty string", cause: nil unless value.is_a?(String) && !value.empty? && !value.match?(/[\x00-\x1f\x7f]/)
      new(:block_id, value.freeze)
    end

    def self.validate_height(value)
      raise ConfigError, "NEAR block height must be an unsigned integer", cause: nil unless value.is_a?(Integer) && !value.is_a?(TrueClass) && value >= 0 && value <= 18_446_744_073_709_551_615
      value
    end
    private_class_method :validate_height

    def initialize(kind, value)
      @kind = kind.to_sym
      @value = case @kind
               when :finality
                 raise ConfigError, "NEAR finality must be final or optimistic", cause: nil unless [NearFinality::FINAL, NearFinality::OPTIMISTIC].include?(value)
                 value.dup.freeze
               when :block_id
                 if value.is_a?(Integer) && !value.is_a?(TrueClass) && !value.is_a?(FalseClass)
                   self.class.send(:validate_height, value)
                 elsif value.is_a?(String) && !value.empty? && !value.match?(/[\x00-\x1f\x7f]/)
                   value.dup.freeze
                 else
                   raise ConfigError, "NEAR block_id must be an opaque hash or u64 height", cause: nil
                 end
               else
                 raise ConfigError, "NEAR block reference kind is unsupported", cause: nil
               end
      freeze
    end

    def to_h
      { kind == :finality ? "finality" : "block_id" => value }
    end

    def self.selector(reference)
      raise ConfigError, "NEAR block reference is invalid", cause: nil unless reference.instance_of?(self)
      kind = reference.instance_variable_get(:@kind)
      value = reference.instance_variable_get(:@value)
      checked = new(kind, value)
      { checked.kind == :finality ? "finality" : "block_id" => checked.value }
    end
  end

  class NearPendingRequest
    def initialize(&block)
      @block = block
    end

    def send
      @block.call
    end
  end

  module NearTypedValue
    module_function
    U64_MAX = 18_446_744_073_709_551_615

    def hash(value)
      raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil unless value.is_a?(Hash)
      value
    end

    def string(value)
      raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil unless value.is_a?(String)
      value
    end

    def integer(value)
      raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil unless value.is_a?(Integer) && !value.is_a?(TrueClass) && !value.is_a?(FalseClass) && value.between?(0, U64_MAX)
      value
    end

    def boolean(value)
      raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil unless value == true || value == false
      value
    end

    def optional_string(value)
      value.nil? ? nil : string(value)
    end

    def optional_integer(value)
      value.nil? ? nil : integer(value)
    end

    def additional(value, known)
      value.each_with_object({}) { |(key, item), result| result[key] = item unless known.include?(key) }.freeze
    end
  end

  class NearSyncInfo
    attr_reader :latest_block_hash, :latest_block_height, :latest_block_time, :latest_state_root, :syncing, :additional

    def self.from(value)
      hash = NearTypedValue.hash(value)
      known = %w[latest_block_hash latest_block_height latest_block_time latest_state_root syncing]
      new(
        NearTypedValue.string(hash.fetch("latest_block_hash")),
        NearTypedValue.integer(hash.fetch("latest_block_height")),
        NearTypedValue.string(hash.fetch("latest_block_time")),
        NearTypedValue.string(hash.fetch("latest_state_root")),
        NearTypedValue.boolean(hash.fetch("syncing")),
        NearTypedValue.additional(hash, known)
      )
    rescue KeyError
      raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil
    end

    def initialize(latest_block_hash, latest_block_height, latest_block_time, latest_state_root, syncing, additional)
      @latest_block_hash = latest_block_hash; @latest_block_height = latest_block_height; @latest_block_time = latest_block_time
      @latest_state_root = latest_state_root; @syncing = syncing; @additional = additional; freeze
    end
  end

  class NearNodeVersion
    attr_reader :version, :build, :rustc_version, :additional

    def self.from(value)
      hash = NearTypedValue.hash(value); known = %w[version build rustc_version]
      new(NearTypedValue.string(hash.fetch("version")), NearTypedValue.string(hash.fetch("build")), NearTypedValue.optional_string(hash["rustc_version"]), NearTypedValue.additional(hash, known))
    rescue KeyError
      raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil
    end

    def initialize(version, build, rustc_version, additional)
      @version = version; @build = build; @rustc_version = rustc_version; @additional = additional; freeze
    end
  end

  class NearStatus
    attr_reader :chain_id, :genesis_hash, :latest_protocol_version, :protocol_version, :sync_info, :version, :additional

    def self.from(value)
      hash = NearTypedValue.hash(value); known = %w[chain_id genesis_hash latest_protocol_version protocol_version sync_info version]
      new(NearTypedValue.string(hash.fetch("chain_id")), NearTypedValue.string(hash.fetch("genesis_hash")), NearTypedValue.integer(hash.fetch("latest_protocol_version")), NearTypedValue.integer(hash.fetch("protocol_version")), NearSyncInfo.from(hash.fetch("sync_info")), NearNodeVersion.from(hash.fetch("version")), NearTypedValue.additional(hash, known))
    rescue KeyError
      raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil
    end

    def initialize(chain_id, genesis_hash, latest_protocol_version, protocol_version, sync_info, version, additional)
      @chain_id = chain_id; @genesis_hash = genesis_hash; @latest_protocol_version = latest_protocol_version; @protocol_version = protocol_version
      @sync_info = sync_info; @version = version; @additional = additional; freeze
    end
  end

  class NearBlockHeader
    attr_reader :block_hash, :height, :prev_hash, :timestamp, :timestamp_nanosec, :gas_price, :total_supply, :additional

    def self.from(value)
      hash = NearTypedValue.hash(value); known = %w[hash height prev_hash timestamp timestamp_nanosec gas_price total_supply]
      new(NearTypedValue.string(hash.fetch("hash")), NearTypedValue.integer(hash.fetch("height")), NearTypedValue.string(hash.fetch("prev_hash")), NearTypedValue.integer(hash.fetch("timestamp")), NearTypedValue.string(hash.fetch("timestamp_nanosec")), NearTypedValue.string(hash.fetch("gas_price")), NearTypedValue.string(hash.fetch("total_supply")), NearTypedValue.additional(hash, known))
    rescue KeyError
      raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil
    end

    def initialize(*values)
      @block_hash, @height, @prev_hash, @timestamp, @timestamp_nanosec, @gas_price, @total_supply, @additional = values
      freeze
    end
  end

  class NearBlockView
    attr_reader :author, :header, :chunks, :additional

    def self.from(value)
      hash = NearTypedValue.hash(value); known = %w[author header chunks]
      chunks = hash.fetch("chunks")
      raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil unless chunks.is_a?(Array)
      new(NearTypedValue.string(hash.fetch("author")), NearBlockHeader.from(hash.fetch("header")), chunks.freeze, NearTypedValue.additional(hash, known))
    rescue KeyError
      raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil
    end

    def initialize(author, header, chunks, additional)
      @author = author; @header = header; @chunks = chunks; @additional = additional; freeze
    end
  end

  class NearAccountView
    attr_reader :amount, :locked, :code_hash, :storage_usage, :storage_paid_at, :block_height, :block_hash, :state, :bootstrap_nonce, :global_contract_account_id, :global_contract_hash, :additional

    def self.from(value)
      hash = NearTypedValue.hash(value); known = %w[amount locked code_hash storage_usage storage_paid_at block_height block_hash state bootstrap_nonce global_contract_account_id global_contract_hash]
      new(NearTypedValue.string(hash.fetch("amount")), NearTypedValue.string(hash.fetch("locked")), NearTypedValue.string(hash.fetch("code_hash")), NearTypedValue.integer(hash.fetch("storage_usage")), NearTypedValue.optional_integer(hash["storage_paid_at"]), NearTypedValue.integer(hash.fetch("block_height")), NearTypedValue.string(hash.fetch("block_hash")), NearTypedValue.optional_string(hash["state"]), NearTypedValue.optional_integer(hash["bootstrap_nonce"]), NearTypedValue.optional_string(hash["global_contract_account_id"]), NearTypedValue.optional_string(hash["global_contract_hash"]), NearTypedValue.additional(hash, known))
    rescue KeyError
      raise InvalidResponseError.new("ERPC returned an invalid NEAR response"), cause: nil
    end

    def initialize(*values)
      names = %i[amount locked code_hash storage_usage storage_paid_at block_height block_hash state bootstrap_nonce global_contract_account_id global_contract_hash additional]
      names.each_with_index { |name, index| instance_variable_set("@#{name}", values[index]) }
      freeze
    end
  end

  class NearRpc
    attr_reader :endpoint

    def initialize(transport)
      @transport = transport; @endpoint = transport.endpoint
    end

    def inspect
      "#<#{self.class} endpoint=#{endpoint.inspect}>"
    end

    def status
      NearPendingRequest.new { NearStatus.from(@transport.request("status", [])) }
    end

    def block(reference)
      selector = validate_reference(reference)
      NearPendingRequest.new { NearBlockView.from(@transport.request("block", selector)) }
    end

    def view_account(account_id, reference)
      selector = validate_reference(reference)
      raise ConfigError, "NEAR account_id must be a non-empty string", cause: nil unless account_id.is_a?(String) && !account_id.empty?
      params = { "request_type" => "view_account", "account_id" => account_id }.merge(selector)
      NearPendingRequest.new { NearAccountView.from(@transport.request("query", params)) }
    end

    private

    def validate_reference(reference)
      NearBlockReference.selector(reference)
    end
  end

  class NearClient
    attr_reader :rpc

    def initialize(transport)
      @rpc = NearRpc.new(transport); freeze
    end
  end

  module Near
    module_function

    def create_client(transport)
      NearClient.new(transport)
    end
  end

  private_constant :NearTypedValue, :NearPendingRequest
end
