# frozen_string_literal: true

require_relative "test_helper"
require "digest"
require "json"
require "base64"
require "bigdecimal"
require "open3"
require "socket"
require "set"
require "thread"
require "timeout"
require "uri"

class RpcNetworkContractTest < Minitest::Test
  FINAL_CONTRACT_DIGEST = "1cbe2b4a07c1d91b4bd40ea9501aa3c1f609489adde60baf1fea4dc89f506e67"
  FINAL_FIXTURE_DIGEST = "80c9465eac93e1536125d0af98d24b0215226cb9857f5d026ac4998923bd26d3"

  class NativeCaptureServer
    attr_reader :port, :requests

    def initialize
      @server = TCPServer.new("127.0.0.1", 0)
      @port = @server.local_address.ip_port
      @requests = []
      @mutex = Mutex.new
      @state = nil
      @running = true
      @thread = Thread.new { accept_loop }
      @thread.report_on_exception = false
    end

    def configure(state)
      @mutex.synchronize { @state = state }
      @mutex.synchronize { @requests.clear }
    end

    def stop
      @running = false
      @server.close
      @thread.join(1)
    rescue IOError, Errno::EBADF
      nil
    end

    private

    def accept_loop
      while @running
        socket = @server.accept
        Thread.new(socket) { |client| handle(client) }
      end
    rescue IOError, Errno::EBADF
      nil
    end

    def handle(socket)
      request_line = socket.gets
      return if request_line.nil?

      method, target, = request_line.split(" ", 3)
      headers = {}
      while (line = socket.gets)
        break if line == "\r\n"

        name, value = line.split(":", 2)
        headers[name.downcase] = value.to_s.strip if name
      end
      body = socket.read(headers.fetch("content-length", "0").to_i) || "".b
      request = { method: method, target: target, headers: headers, body: body.b }
      state = @mutex.synchronize do
        @requests << request
        current = @state
        if current && current[:warmups].to_i.positive?
          current[:warmups] -= 1
          current[:warmup] = true
        else
          current[:warmup] = false if current
        end
        current
      end
      return if state.nil?

      if state[:warmup]
        response_body = JSON.generate("jsonrpc" => "2.0", "id" => JSON.parse(body).fetch("id"),
                                      "result" => warmup_result(state.fetch(:entry), JSON.parse(body)))
        socket.write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nContent-Length: #{response_body.bytesize}\r\nConnection: close\r\n\r\n")
        socket.write(response_body)
        socket.flush
        return
      end

      if state.fetch(:withhold_headers)
        sleep(state.fetch(:delay, 0.25))
        return
      end
      if state.fetch(:reset_before_headers)
        socket.close
        return
      end

      status = state.fetch(:status)
      response_headers = state.fetch(:headers)
      response_body = state.fetch(:body)
      socket.write("HTTP/1.1 #{status} #{status == 200 ? 'OK' : 'Redirect'}\r\n")
      response_headers.each { |name, value| socket.write("#{name}: #{value}\r\n") }
      socket.write("Content-Length: #{response_body.bytesize}\r\nConnection: close\r\n\r\n")
      socket.flush

      if state.fetch(:reset_after_first_chunk)
        half = [response_body.bytesize / 2, 1].max
        socket.write(response_body.byteslice(0, half))
        socket.flush
        socket.close
      elsif state.fetch(:delay_after_first_chunk)
        half = [response_body.bytesize / 2, 1].max
        socket.write(response_body.byteslice(0, half))
        socket.flush
        sleep(state.fetch(:delay, 0.25))
        socket.write(response_body.byteslice(half..))
        socket.flush
      else
        socket.write(response_body)
        socket.flush
      end
    rescue IOError, Errno::ECONNRESET, Errno::EPIPE
      nil
    ensure
      socket.close unless socket.closed?
    end

    def warmup_result(entry, request)
      client_id = entry.fetch("clientContractId")
      method = request.fetch("method", "")
      return 0 if client_id == "client-bitcoin-rpc" && method == "getblockcount"
      return nil if client_id == "client-bitcoin-rpc" && method == "gettxout"
      return "warmup" if client_id == "client-bitcoin-rpc" && %w[getbestblockhash getblockhash getblockheader].include?(method)
      return "warmup-genesis" if client_id == "client-solana-rpc"
      return "0xa86a" if client_id == "client-avalanche-rpc"
      return "0x0" unless client_id == "client-near-rpc"

      operation = entry.dig("operation", "publicOperation")
      return {
        "chain_id" => "mainnet", "genesis_hash" => "warmup", "latest_protocol_version" => 1,
        "protocol_version" => 1,
        "sync_info" => { "latest_block_hash" => "warmup", "latest_block_height" => 1,
                          "latest_block_time" => "time", "latest_state_root" => "warmup", "syncing" => false },
        "version" => { "version" => "1", "build" => "warmup", "rustc_version" => "1" }
      } if operation == "status"
      return {
        "author" => "warmup.near",
        "header" => { "hash" => "warmup", "height" => 1, "prev_hash" => "warmup", "timestamp" => 1,
                       "timestamp_nanosec" => "1", "gas_price" => "1", "total_supply" => "1" },
        "chunks" => []
      } if operation == "block"
      { "amount" => "1", "locked" => "0", "code_hash" => "warmup", "storage_usage" => 1,
        "storage_paid_at" => 0, "block_height" => 1, "block_hash" => "warmup" }
    end
  end

  class RemapAdapter
    attr_reader :captures

    def initialize(server)
      @server = server
      @delegate = ERPC::NetHttpAdapter.new
      @captures = []
      @phase = :measured
    end

    attr_writer :phase

    def request(**request)
      capture(request)
      response = @delegate.request(**request.merge(url: local_url(request.fetch(:url))))
      @captures.last[:response_status] = response.status if @captures.last
      response
    end

    def request_stream(**request, &block)
      capture(request)
      @delegate.request_stream(**request.merge(url: local_url(request.fetch(:url)))) do |status, chunks, headers|
        @captures.last[:response_status] = status if @captures.last
        block.call(status, chunks, headers)
      end
    end

    private

    def capture(request)
      @captures << request.merge(phase: @phase, body: request.fetch(:body).to_s.b)
    end

    def local_url(original)
      uri = URI.parse(original)
      local = URI.parse("http://127.0.0.1:#{@server.port}")
      local.path = uri.path.to_s.empty? ? "/" : uri.path
      local.query = uri.query
      local.to_s
    end
  end

  def contract
    @contract ||= JSON.parse(File.read(File.expand_path("../../../registry/rpc-network-contract.json", __dir__)))
  end

  def fixture
    @fixture ||= JSON.parse(File.read(File.expand_path("../../../registry/fixtures/rpc-chain-contract-cases.json", __dir__)))
  end

  def materialized
    return @materialized if @materialized

    if ENV["ERPC_SDK_RPC_NETWORK_MATERIALIZED"]
      return @materialized = JSON.parse(File.read(ENV.fetch("ERPC_SDK_RPC_NETWORK_MATERIALIZED")).to_s).transform_values do |directions|
        directions.transform_values { |value| Base64.decode64(value) }
      end
    end

    helper = <<~'NODE'
      import fs from "node:fs"
      const fixture = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
      const parity = await import("./registry/verify-rpc-network-parity.mjs")
      const bytes = (entry, direction) => {
        const exchange = entry.mockExchange[direction]
        if (exchange.bodyEncoding === "hex") return Buffer.from(exchange.body, "hex").toString("base64")
        if (exchange.bodyEncoding === "json" || exchange.bodyEncoding === "utf8") return Buffer.from(exchange.body, "utf8").toString("base64")
        const source = entry[direction === "request" ? "requestDescriptor" : "responseDescriptor"]
        const golden = source.kind === "oracle-ref-v1"
          ? fixture.oracleGoldens.find((item) => item.goldenId === source.oracleGoldenId)
          : source
        const chunks = parity.expandDescriptorChunks(golden.descriptor)
        return Buffer.concat([...parity.applyChunkPlan(chunks, golden.chunkPlan, golden.measurement.decodedLength)]).toString("base64")
      }
      const output = {}
      for (const entry of fixture.cases) output[entry.caseId] = { request: bytes(entry, "request"), response: bytes(entry, "response") }
      for (const golden of fixture.suiGrpcWeb.golden) output[`sui:${golden.id}`] = { request: Buffer.from(golden.requestFrameHex, "hex").toString("base64"), response: Buffer.from(golden.responseBodyHex, "hex").toString("base64") }
      process.stdout.write(JSON.stringify(output))
    NODE
    path = File.expand_path("../../../registry/fixtures/rpc-chain-contract-cases.json", __dir__)
    output, error_output, status = Open3.capture3("node", "--input-type=module", "-e", helper, path, chdir: File.expand_path("../../..", __dir__))
    raise "descriptor materializer failed: #{error_output}" unless status.success?

    @materialized = JSON.parse(output).transform_values do |directions|
      directions.transform_values { |value| Base64.decode64(value) }
    end
  end

  def sha256(bytes)
    Digest::SHA256.hexdigest(bytes)
  end

  def lossless_json_digest(bytes)
    sha256(JSON.generate(JSON.parse(bytes)))
  end

  # The parity contract uses the fixed lossless JSON normalizer from the
  # registry. Ruby's JSON generator preserves insertion order, while the
  # contract sorts object keys without converting number lexemes to Float.
  # Keep the wire digest above for raw fixture comparisons and use this helper
  # only for canonical snapshot traces.
  def canonical_json_digest(bytes)
    @canonical_json_digest_cache ||= {}
    key = sha256(bytes)
    return @canonical_json_digest_cache[key] if @canonical_json_digest_cache.key?(key)

    helper = <<~'NODE'
      import { normalizeJsonRequestBytes } from "./registry/verify-rpc-network-parity.mjs";
      process.stdout.write(normalizeJsonRequestBytes(Buffer.from(process.argv[1], "base64")).sha256);
    NODE
    output, error_output, status = Open3.capture3(
      "node", "--input-type=module", "-e", helper, Base64.strict_encode64(bytes),
      chdir: File.expand_path("../../..", __dir__)
    )
    raise "canonical JSON normalizer failed: #{error_output}" unless status.success?

    @canonical_json_digest_cache[key] = output.strip
  rescue Errno::ENOENT
    # The pinned Ruby 3.1 container intentionally has no Node runtime. Keep
    # the same fixed-key, lossless algorithm for that consumer; the host lane
    # above always executes the shared registry helper.
    @canonical_json_digest_cache[key] = sha256(ruby_lossless_json_bytes(bytes))
  end

  def ruby_lossless_json_bytes(bytes)
    source = bytes.to_s.b.dup.force_encoding(Encoding::UTF_8)
    raise "native JSON request is not valid UTF-8" unless source.valid_encoding?

    offset = 0
    whitespace = lambda do
      offset += 1 while offset < source.length && source.getbyte(offset).chr.match?(/[\x20\x09\x0a\x0d]/)
    end
    parse_string = lambda do
      raise "native JSON request string is malformed" unless source.getbyte(offset) == 0x22
      start = offset
      offset += 1
      escaped = false
      while offset < source.length
        character = source.getbyte(offset)
        if escaped
          escaped = false
        elsif character == 0x5c
          escaped = true
        elsif character == 0x22
          offset += 1
          return JSON.parse(source.byteslice(start, offset - start))
        end
        offset += 1
      end
      raise "native JSON request string is unterminated"
    end
    parse_value = nil
    parse_value = lambda do
      whitespace.call
      character = source.getbyte(offset)
      return ["string", parse_string.call] if character == 0x22
      if character == 0x7b
        offset += 1
        whitespace.call
        entries = []
        return ["object", entries] if source.getbyte(offset) == 0x7d && (offset += 1)
        loop do
          whitespace.call
          key = parse_string.call
          whitespace.call
          raise "native JSON request object is missing a colon" unless source.getbyte(offset) == 0x3a
          offset += 1
          entries << [key, parse_value.call]
          whitespace.call
          if source.getbyte(offset) == 0x7d
            offset += 1
            break
          end
          raise "native JSON request object is missing a comma" unless source.getbyte(offset) == 0x2c
          offset += 1
        end
        return ["object", entries.sort_by(&:first)]
      end
      if character == 0x5b
        offset += 1
        whitespace.call
        values = []
        return ["array", values] if source.getbyte(offset) == 0x5d && (offset += 1)
        loop do
          values << parse_value.call
          whitespace.call
          if source.getbyte(offset) == 0x5d
            offset += 1
            break
          end
          raise "native JSON request array is missing a comma" unless source.getbyte(offset) == 0x2c
          offset += 1
          whitespace.call
        end
        return ["array", values]
      end
      { "true" => true, "false" => false, "null" => nil }.each do |literal, value|
        if source.byteslice(offset, literal.length) == literal
          offset += literal.length
          return ["literal", value]
        end
      end
      number = source.byteslice(offset..).match(/\A-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/)
      unless number.nil?
        offset += number[0].length
        return ["number", number[0]]
      end
      raise "native JSON request value is malformed"
    end
    emit = nil
    emit = lambda do |node|
      kind, value = node
      case kind
      when "string" then JSON.generate(value)
      when "number" then value
      when "literal" then JSON.generate(value)
      when "array" then "[#{value.map { |child| emit.call(child) }.join(',')}]"
      else "{#{value.map { |key, child| "#{JSON.generate(key)}:#{emit.call(child)}" }.join(',')}}"
      end
    end
    value = parse_value.call
    whitespace.call
    raise "native JSON request has trailing content" unless offset == source.length
    emit.call(value).b
  end

  def client_field(client_id)
    {
      "client-base-rpc" => :base_rpc, "client-arbitrum-rpc" => :arbitrum_rpc,
      "client-bitcoin-rpc" => :bitcoin_rpc, "client-polygon-rpc" => :polygon_rpc,
      "client-bsc-rpc" => :bsc_rpc, "client-optimism-rpc" => :optimism_rpc,
      "client-kaia-rpc" => :kaia_rpc, "client-soneium-rpc" => :soneium_rpc,
      "client-monad-rpc" => :monad_rpc, "client-hyperliquid-rpc" => :hyperliquid_rpc,
      "client-arc-rpc" => :arc_rpc, "client-robinhood-rpc" => :robinhood_rpc,
      "client-near-rpc" => :near_rpc, "client-tron-rpc" => :tron_rpc,
      "client-sui-grpc" => :sui_grpc_web, "client-ethereum-rpc" => :ethereum_rpc,
      "client-solana-rpc" => :solana_rpc, "client-avalanche-rpc" => :avalanche_c_rpc
    }.fetch(client_id)
  end

  def hosted_field(client_id)
    {
      "client-base-rpc" => :base_endpoint, "client-arbitrum-rpc" => :arbitrum_endpoint,
      "client-polygon-rpc" => :polygon_endpoint, "client-bsc-rpc" => :bsc_endpoint,
      "client-optimism-rpc" => :optimism_endpoint, "client-kaia-rpc" => :kaia_endpoint,
      "client-soneium-rpc" => :soneium_endpoint, "client-monad-rpc" => :monad_endpoint,
      "client-hyperliquid-rpc" => :hyperliquid_endpoint, "client-arc-rpc" => :arc_endpoint,
      "client-robinhood-rpc" => :robinhood_endpoint, "client-tron-rpc" => :tron_endpoint,
      "client-near-rpc" => :near_endpoint
    }.fetch(client_id, :endpoint)
  end

  def endpoint_for_config(entry)
    endpoint = entry.dig("setup", "endpoint")
    return "https://node.fixture.invalid/rpc" unless endpoint.is_a?(String)
    if entry["clientContractId"] == "client-bitcoin-rpc" && entry.dig("setup", "mode") == "hosted"
      uri = URI.parse(endpoint)
      return URI::Generic.build(scheme: uri.scheme, host: uri.host, port: uri.port, path: "/").to_s
    end
    endpoint
  end

  def build_config(entry, timeout:, server:)
    setup = entry.fetch("setup")
    client_id = entry.fetch("clientContractId")
    mode = setup.fetch("mode")
    if mode == "unconfigured"
      sibling = URI::HTTP.build(host: "127.0.0.1", port: server.port, path: "/ethereum").to_s
      return ERPC::ClientConfig.new(timeout: timeout, ethereum_rpc: ERPC::RpcEndpointConfig.new(http_url: sibling))
    end
    if mode == "none"
      sibling = URI::HTTP.build(host: "127.0.0.1", port: server.port, path: "/sibling").to_s
      field = client_id == "client-bitcoin-rpc" ? :bitcoin_rpc : client_field(client_id)
      # A valid unrelated direct sibling makes keyless construction possible while the selected namespace stays absent.
      field = :ethereum_rpc if field == :bitcoin_rpc || field == :base_rpc
      return ERPC::ClientConfig.new(timeout: timeout, ethereum_rpc: ERPC::RpcEndpointConfig.new(http_url: sibling))
    end

    headers = (setup["headers"] || {}).dup
    endpoint = endpoint_for_config(entry)
    if mode == "hosted"
      kwargs = { timeout: timeout, api_key: setup["apiKey"], headers: headers }
      kwargs[hosted_field(client_id)] = endpoint
      return ERPC::ClientConfig.new(**kwargs)
    end

    direct = ERPC::RpcEndpointConfig.new(http_url: endpoint, headers: headers)
    if client_id == "client-sui-grpc"
      ERPC::ClientConfig.new(timeout: timeout, sui_grpc_web: ERPC::SuiGrpcWebEndpointConfig.new(base_url: endpoint, headers: headers))
    else
      ERPC::ClientConfig.new(timeout: timeout, client_field(client_id) => direct)
    end
  end

  def surface_for(client, client_id)
    case client_id
    when "client-sui-grpc" then client.sui.grpc
    when "client-bitcoin-rpc" then client.bitcoin.rpc
    when "client-near-rpc" then client.near.rpc
    when "client-solana-rpc" then client.solana.rpc
    when "client-avalanche-rpc" then client.avalanche.rpc
    when "client-ethereum-rpc" then client.ethereum.rpc
    else
      names = {
        "client-base-rpc" => :base, "client-arbitrum-rpc" => :arbitrum,
        "client-polygon-rpc" => :polygon, "client-bsc-rpc" => :bsc,
        "client-optimism-rpc" => :optimism, "client-kaia-rpc" => :kaia,
        "client-soneium-rpc" => :soneium, "client-monad-rpc" => :monad,
        "client-hyperliquid-rpc" => :hyperliquid, "client-arc-rpc" => :arc,
        "client-robinhood-rpc" => :robinhood, "client-tron-rpc" => :tron
      }
      client.public_send(names.fetch(client_id)).rpc
    end
  end

  def public_operation(entry)
    entry.dig("operation", "publicOperations", "ruby") || entry.dig("operation", "publicOperation")
  end

  def near_reference(params)
    if params["finality"] == "final"
      ERPC::NearBlockReference.final
    elsif params["finality"] == "optimistic"
      ERPC::NearBlockReference.optimistic
    elsif params["block_id"].is_a?(Integer)
      ERPC::NearBlockReference.height(params["block_id"])
    else
      ERPC::NearBlockReference.from_hash(params.fetch("block_id"))
    end
  end

  def invoke_public(client, entry)
    operation = public_operation(entry)
    return nil if %w[surface cancellation].include?(operation)

    params = entry.dig("operation", "params")
    client_id = entry.fetch("clientContractId")
    if client_id == "client-bitcoin-rpc"
      return surface_for(client, client_id).public_send(camel_to_snake(operation), *(params || [])).send
    end
    if client_id == "client-near-rpc"
      rpc = client.near.rpc
      return rpc.status.send if operation == "status"
      reference = near_reference(params)
      return rpc.block(reference).send if operation == "block"
      return rpc.view_account(params.fetch("account_id"), reference).send
    end
    if client_id == "client-sui-grpc"
      rpc = client.sui.grpc
      return rpc.get_service_info.send if operation == "getServiceInfo"
      if operation == "getObject"
        p = params.is_a?(Array) ? params.fetch(0) : params
        descriptor = entry.dig("requestDescriptor")
        if descriptor&.fetch("kind", nil) == "oracle-ref-v1" && ["sui-request-bytes-inclusive", "sui-request-bytes-over"].include?(descriptor["oracleGoldenId"])
          golden = fixture.fetch("oracleGoldens").find { |item| item["goldenId"] == descriptor["oracleGoldenId"] }
          request_descriptor = golden.fetch("descriptor")
          return rpc.get_object(request_descriptor.fetch("objectByte") * request_descriptor.fetch("objectCount"), nil).send
        end
        return rpc.get_object(p.fetch("objectId"), p["version"]).send
      end
      p = params.is_a?(Array) && params.length == 1 && params[0].is_a?(Hash) ? params[0] : params
      return rpc.get_balance(p.fetch("owner"), p.fetch("coinType")).send
    end
    rpc = surface_for(client, client_id)
    if client_id == "client-solana-rpc"
      return rpc.public_send(camel_to_snake(operation), *(params || [])).send
    end
    rpc.public_send(camel_to_snake(operation), *(params || [])).send
  end

  def camel_to_snake(value)
    value.to_s.gsub(/([A-Z])/, '_\\1').downcase.sub(/\A_/, "")
  end

  def redaction_values(entry)
    setup = entry.fetch("setup")
    values = []
    values << setup["apiKey"] if setup["apiKey"]
    if setup["mode"] == "direct" && setup["endpoint"].is_a?(String)
      uri = URI.parse(setup["endpoint"])
      values.concat(uri.path.to_s.split("/").reject(&:empty?))
      values.concat(uri.path.to_s.split("/").reject(&:empty?).map { |part| URI.decode_www_form_component(part) })
      values.concat(URI.decode_www_form(uri.query.to_s).map(&:last))
    end
    values.concat((setup["headers"] || {}).values)
    values.compact.reject(&:empty?).uniq
  end

  # This oracle intentionally mirrors the privacy contract without calling
  # ERPC::Redaction. It covers raw and percent-decoded forms, including both
  # hex cases, and recursively redacts keys and values while leaving numbers
  # as numbers.
  def independent_credential_variants(values)
    Array(values).compact.flat_map do |value|
      text = value.to_s
      next [] if text.empty?

      escaped = text.b.each_byte.map do |byte|
        character = byte.chr
        character.match?(/[A-Za-z0-9_.~-]/) ? character : format("%%%02X", byte)
      end.join
      [text, URI.encode_www_form_component(text), escaped, escaped.gsub(/%([0-9A-Fa-f]{2})/) { "%#{$1.upcase}" }, escaped.gsub(/%([0-9A-Fa-f]{2})/) { "%#{$1.downcase}" }]
    end.uniq.sort_by { |value| [-value.length, value] }
  end

  def independent_redact_text(value, values, marker = "<redacted>")
    result = value.to_s
    independent_credential_variants(values).each do |secret|
      result = result.gsub(secret, marker) unless secret.empty?
    end
    result
  end

  def independent_redact_value(value, values, depth = 0, marker = "[REDACTED]")
    return marker if depth >= 32

    case value
    when String
      independent_redact_text(value, values, marker)
    when Array
      value.map { |item| independent_redact_value(item, values, depth + 1, marker) }
    when Hash
      value.each_with_object({}) do |(key, item), output|
        redacted_key = key.is_a?(String) ? independent_redact_text(key, values, marker) : key
        output[redacted_key] = independent_redact_value(item, values, depth + 1, marker)
      end
    else
      value
    end
  end

  def trace_redaction_values(entry)
    setup = entry.fetch("setup")
    values = []
    values << setup["apiKey"] if setup["apiKey"]
    values.concat((setup["headers"] || {}).values)
    if entry["caseId"] == "c1-path-query-header-and-api-key-redaction" && setup["endpoint"].is_a?(String)
      uri = URI.parse(setup["endpoint"])
      values.concat(uri.path.to_s.split("/").reject(&:empty?))
      values.concat(uri.path.to_s.split("/").reject(&:empty?).map { |part| URI.decode_www_form_component(part) })
      values.concat(URI.decode_www_form(uri.query.to_s).map(&:last))
    elsif setup["endpoint"].is_a?(String)
      # Query values are credentials only when they carry the fixture secret;
      # ordinary routing markers such as Sui's fixture=1 remain observable.
      URI.decode_www_form(URI.parse(setup["endpoint"]).query.to_s).each do |_key, value|
        values << value if value.to_s.include?("secret")
      end
    end
    values.compact.reject(&:empty?).uniq
  end

  def redact_text(value, values)
    independent_redact_text(value, values)
  end

  def redact_url(value, entry)
    uri = URI.parse(value)
    if entry.dig("setup", "mode") == "hosted"
      query = URI.decode_www_form(uri.query.to_s).reject { |key, _| key.casecmp?("api-key") }
      uri.query = query.empty? ? nil : URI.encode_www_form(query)
    end
    independent_redact_text(uri.to_s, trace_redaction_values(entry))
  end

  def redact_headers(headers, entry)
    secrets = trace_redaction_values(entry)
    headers.each_with_object({}) do |(name, value), output|
      key = name.to_s.downcase
      next if %w[host content-length user-agent].include?(key)
      next if key == "accept" && entry["clientContractId"] != "client-sui-grpc"
      output[key] = if key == "authorization" || secrets.any? { |secret| value.to_s.include?(secret) }
                      "<redacted>"
                    else
                      independent_redact_text(value.to_s, secrets)
                    end
    end
  end

  def error_category(error, entry = nil)
    case error
    when ERPC::NotConfiguredError then "not-configured"
    when ERPC::TimeoutError then "timeout"
    when ERPC::TransportError then "transport"
    when ERPC::HttpError
      error.status.to_i == 302 && entry&.dig("scheduleId") == "life-redirect-to-second-server" ? "http-redirect" : "http-status"
    when ERPC::JsonRpcError then "json-rpc"
    when ERPC::InvalidResponseError then "invalid-response"
    when ERPC::ConfigError then "config"
    else
      raise "unknown Ruby SDK error #{error.class}"
    end
  end

  def numeric_tuples(value, path = "$.result")
    if value.is_a?(BigDecimal)
      sign, digits, _base, exponent = value.split
      coefficient = digits.sub(/\A0+/, "").sub(/0+\z/, "")
      coefficient = "0" if coefficient.empty?
      exponent10 = exponent - digits.length + (digits.length - coefficient.length)
      return [{ "path" => path, "sign" => sign.negative? ? -1 : (value.zero? ? 0 : 1), "coefficient" => coefficient, "exponent10" => exponent10.to_s }]
    end
    if value.is_a?(Integer) && !value.is_a?(TrueClass) && !value.is_a?(FalseClass)
      digits = value.abs.to_s
      exponent = 0
      while digits.length > 1 && digits.end_with?("0")
        digits = digits[0...-1]
        exponent += 1
      end
      return [{ "path" => path, "sign" => value.negative? ? -1 : (value.zero? ? 0 : 1), "coefficient" => digits, "exponent10" => exponent.to_s }]
    end
    if value.is_a?(Array)
      return value.each_with_index.flat_map { |child, index| numeric_tuples(child, "#{path}[#{index}]") }
    end
    if value.is_a?(Hash)
      return value.flat_map { |key, child| numeric_tuples(child, "#{path}.#{key}") }
    end
    []
  end

  def wire_value(operation, value)
    case operation
    when "status"
      {
        "chain_id" => value.chain_id, "genesis_hash" => value.genesis_hash,
        "latest_protocol_version" => value.latest_protocol_version, "protocol_version" => value.protocol_version,
        "sync_info" => {
          "latest_block_hash" => value.sync_info.latest_block_hash,
          "latest_block_height" => value.sync_info.latest_block_height,
          "latest_block_time" => value.sync_info.latest_block_time,
          "latest_state_root" => value.sync_info.latest_state_root,
          "syncing" => value.sync_info.syncing
        }.merge(value.sync_info.additional),
        "version" => {
          "version" => value.version.version, "build" => value.version.build
        }.tap { |hash| hash["rustc_version"] = value.version.rustc_version unless value.version.rustc_version.nil? }.merge(value.version.additional)
      }.merge(value.additional)
    when "block"
      {
        "author" => value.author,
        "header" => {
          "hash" => value.header.block_hash, "height" => value.header.height,
          "prev_hash" => value.header.prev_hash, "timestamp" => value.header.timestamp,
          "timestamp_nanosec" => value.header.timestamp_nanosec, "gas_price" => value.header.gas_price,
          "total_supply" => value.header.total_supply
        }.merge(value.header.additional),
        "chunks" => value.chunks
      }.merge(value.additional)
    when "view_account"
      {
        "amount" => value.amount, "locked" => value.locked, "code_hash" => value.code_hash,
        "storage_usage" => value.storage_usage, "block_height" => value.block_height,
        "block_hash" => value.block_hash
      }.tap do |hash|
        { "storage_paid_at" => value.storage_paid_at, "state" => value.state,
          "bootstrap_nonce" => value.bootstrap_nonce, "global_contract_account_id" => value.global_contract_account_id,
          "global_contract_hash" => value.global_contract_hash }.each { |key, item| hash[key] = item unless item.nil? }
      end.merge(value.additional)
    when "getServiceInfo"
      { "chainId" => value.chain_id, "chain" => value.chain, "epoch" => value.epoch,
        "checkpoint" => value.checkpoint_height, "timestampSeconds" => value.timestamp_seconds,
        "timestampNanos" => value.timestamp_nanos, "lowestCheckpoint" => value.lowest_available_checkpoint,
        "lowestVerifiedCheckpoint" => value.lowest_available_checkpoint_objects }.tap { |hash| hash["server"] = value.server unless value.server.nil? }
    when "getObject"
      { "objectId" => value.sui_object_id, "version" => value.version, "digest" => value.digest }
    when "getBalance"
      { "coinType" => value.coin_type, "balance" => value.balance, "addressBalance" => value.address_balance, "coinBalance" => value.coin_balance }
    else
      value
    end
  end

  def surface_inventory(surface)
    # public_methods(false) deliberately excludes inherited Ruby core methods
    # such as Object#send, #object_id and #hash. The contract inventories only
    # methods declared by the SDK surface itself.
    surface.public_methods(false).map(&:to_s).reject { |name| %w[endpoint inspect].include?(name) }.sort
  end

  def client_contract(client_id)
    contract.fetch("clientContracts").find { |item| item["clientContractId"] == client_id }.tap do |client|
      raise "unknown client contract #{client_id}" if client.nil?
    end
  end

  def method_set_for(client_id)
    client = client_contract(client_id)
    contract.fetch("methodSets").find { |item| item["methodSetId"] == client.fetch("methodSetId") }.tap do |method_set|
      raise "unknown method set for #{client_id}" if method_set.nil?
    end
  end

  def actual_capability_names(client_id)
    method_set_for(client_id).fetch("capabilities", []).each_with_object({}) do |capability, names|
      names[capability.fetch("publicOperation")] = capability.dig("publicNames", "ruby") || capability.fetch("publicOperation")
    end
  end

  def surface_name_to_actual(name, names)
    return names[name] if names.key?(name)
    return name if names.value?(name)

    names.each do |semantic, actual|
      normalized_name = name.to_s.downcase.delete("_")
      return actual if semantic.to_s.downcase.delete("_") == normalized_name || actual.to_s.downcase == name.to_s.downcase
    end
    {
      "eth_chainId" => "eth_chain_id", "eth_getBalance" => "eth_get_balance",
      "getServiceInfo" => "get_service_info", "GetServiceInfo" => "get_service_info",
      "getObject" => "get_object", "GetObject" => "get_object",
      "getBalance" => "get_balance", "GetBalance" => "get_balance",
      "getBlockCount" => "get_block_count", "getNetworkInfo" => "get_network_info",
      "getBestBlockHash" => "get_best_block_hash", "getBlockchainInfo" => "get_blockchain_info",
      "getRawMempool" => "get_raw_mempool", "getRawTransaction" => "get_raw_transaction",
      "getTxOut" => "get_tx_out", "estimateSmartFee" => "estimate_smart_fee",
      "getBlock" => "get_block", "getBlockHash" => "get_block_hash",
      "getBlockHeader" => "get_block_header", "getMempoolInfo" => "get_mempool_info",
      "viewAccount" => "view_account"
    }[name]
  end

  def surface_policy(entry)
    client_id = entry.fetch("clientContractId")
    case_id = entry.fetch("caseId")
    operation = entry.dig("operation", "publicOperation")
    if operation == "cancellation"
      return { "allowed" => entry.fetch("exceptionIds", []).sort, "forbidden" => [] }
    end
    if case_id == "c1-bitcoin-new-languages-have-no-raw-request-batch-subscription"
      return { "allowed" => ["named-read-methods"], "forbidden" => %w[raw request batch subscription] }
    end
    if case_id == "c1-sealed-evm-three-method-payloads-and-no-escape-hatches"
      return { "allowed" => %w[eth_chainId eth_getBalance eth_call], "forbidden" => %w[raw request batch transport websocket subscription sign send approve broadcast swap bridge] }
    end
    if case_id == "c4-hyperevm-arc-robinhood-product-scope"
      return { "allowed" => %w[eth_chainId eth_getBalance eth_call], "forbidden" => %w[hypercore info nanoreth brokerage swap bridge] }
    end
    if case_id == "c1-one-attempt-no-redirect-timeout-and-cancellation" || entry.fetch("scheduleId", "").start_with?("life-")
      return { "allowed" => %w[timeout aborted-or-context-cancelled], "forbidden" => %w[redirect-follow retry] }
    end
    if case_id == "c1-unconfigured-namespace-fails-locally-with-zero-io"
      return { "allowed" => ["getBlockCount"], "forbidden" => [] }
    end
    if case_id == "c1-existing-ethereum-solana-avalanche-and-typescript-base-regression"
      return { "allowed" => %w[legacy-solana-namespace explicit-direct-only], "forbidden" => %w[hosted-devnet-preset network-switch] }
    end
    if case_id == "c1-path-query-header-and-api-key-redaction"
      return { "allowed" => ["credential-safe-errors"], "forbidden" => ["credential-leak"] }
    end
    if client_id == "client-near-rpc"
      return { "allowed" => %w[status block view_account], "forbidden" => %w[query raw request batch] }
    end
    if client_id == "client-sui-grpc"
      if case_id == "c5-sui-binary-limit-descriptor"
        return { "allowed" => ["getServiceInfo"], "forbidden" => [] }
      end
      if %w[sui-request-bytes-inclusive-case sui-request-bytes-over-case sui-response-bytes-inclusive-case sui-response-bytes-over-case sui-trailer-bytes-inclusive-case sui-trailer-bytes-over-case].include?(case_id)
        return { "allowed" => %w[request-1MiB-inclusive response-8MiB-inclusive trailer-8KiB-inclusive], "forbidden" => ["request-1MiB-plus-one"] }
      end
      suffix = entry.dig("operation", "wireOperation").to_s.split("/").last
      return { "allowed" => [suffix], "forbidden" => %w[raw request bytes protobuf transport batch stream subscription swap bridge] }
    end
    if client_id == "client-bitcoin-rpc"
      return { "allowed" => %w[estimateSmartFee getBestBlockHash getBlock getBlockchainInfo getBlockCount getBlockHash getBlockHeader getMempoolInfo getNetworkInfo getRawMempool getRawTransaction getTxOut], "forbidden" => %w[raw request batch subscription] } if %w[c1-bitcoin-twelve-named-methods-and-result-shapes btc-gettxout-null-result].include?(case_id)
      return { "allowed" => ["getBestBlockHash"], "forbidden" => %w[raw request batch subscription] } if case_id == "c1-direct-bitcoin-exact-target-scoped-header-keyless"
      return { "allowed" => ["getBlockchainInfo"], "forbidden" => %w[raw request batch subscription] } if case_id == "c1-hosted-bitcoin-bearer-no-query-null-error"
      return { "allowed" => %w[duplicate-last-wins escaped-equivalent-keys], "forbidden" => ["prototype-mutation"] } if case_id == "btc-duplicate-escaped-key-last-wins"
      return { "allowed" => ["bounded-preflight"], "forbidden" => %w[float-rounding unbounded-expansion] } if case_id == "btc-resource-exponent-boundary-and-overflow"
      return { "allowed" => ["integer-token-check"], "forbidden" => %w[rounding saturation] } if case_id == "btc-u64-overflow-and-integer-token-rejection"
      return { "allowed" => ["getBlockCount"], "forbidden" => [] } if case_id == "btc-u64-maximum-integer-projection"
      return { "allowed" => ["getblockcount"], "forbidden" => [] } if case_id.start_with?("btc-u64-")
      return { "allowed" => ["getnetworkinfo"], "forbidden" => [] } if case_id.start_with?("btc-explicit-") || case_id.start_with?("btc-long-coefficient-")
      return { "allowed" => [entry.dig("operation", "wireOperation")], "forbidden" => [] } if case_id.start_with?("btc-method-")
      return { "allowed" => ["getNetworkInfo"], "forbidden" => [] }
    end
    return { "allowed" => ["mainnet-identity"], "forbidden" => %w[testnet-relabel swap bridge] } if case_id == "c3-mainnet-only-monad-soneium-kaia"
    return { "allowed" => %w[eth_chainId eth_getBalance eth_call], "forbidden" => %w[raw request batch websocket subscription send swap bridge] } if case_id == "c1-hosted-base-root-query-auth"

    { "allowed" => [entry.dig("operation", "publicOperation")], "forbidden" => [] }
  end

  def validate_surface_inventory(entry, inventory)
    policy = surface_policy(entry)
    names = actual_capability_names(entry.fetch("clientContractId"))
    method_set = method_set_for(entry.fetch("clientContractId"))
    actual = inventory.to_set
    if method_set.fetch("kind") == "expanded"
      expected_methods = names.values.to_set
      assert_equal expected_methods, actual, "#{entry['caseId']} observed SDK surface"
    end
    required = Set.new
    if method_set.fetch("kind") == "expanded"
      policy.fetch("allowed").each do |label|
        if label == "named-read-methods"
          required.merge(names.values)
        else
          resolved = surface_name_to_actual(label, names)
          required << resolved unless resolved.nil?
        end
      end
    end
    assert_equal [], (required - actual).to_a.sort, "#{entry['caseId']} missing allowed public methods"
    forbidden = policy.fetch("forbidden").filter_map { |label| surface_name_to_actual(label, names) }
    forbidden.concat(policy.fetch("forbidden").select { |label| %w[raw request batch transport websocket subscription sign send approve broadcast swap bridge bytes protobuf stream].include?(label) })
    assert_equal [], (actual & forbidden.to_set).to_a.sort, "#{entry['caseId']} forbidden public surface leaked"
  end

  def expected_surface_rows(network_ids)
    client_ids = network_ids.map { |network_id| contract.fetch("networks").find { |network| network["networkId"] == network_id }.fetch("clientContractId") }.uniq.sort
    client_ids.map do |client_id|
      client = client_contract(client_id)
      method_set = method_set_for(client_id)
      allowed = if method_set.fetch("kind") == "expanded"
                  method_set.fetch("capabilities").map { |capability| capability.dig("publicNames", "ruby") || capability.fetch("publicOperation") }
                else
                  ["legacy-reference"]
                end
      { "clientContractId" => client_id, "allowed" => allowed, "forbidden" => client.fetch("forbiddenCapabilities").sort }
    end
  end

  def coverage_rows(network_ids, completed)
    network_ids.map do |network_id|
      network = contract.fetch("networks").find { |item| item.fetch("networkId") == network_id }
      client = client_contract(network.fetch("clientContractId"))
      method_set = method_set_for(client.fetch("clientContractId"))
      {
        "networkId" => network_id,
        "clientContractId" => client.fetch("clientContractId"),
        "namespace" => client.fetch("namespace"),
        "methodSetDigest" => sha256(stable_json(method_set)),
        "routePolicyIds" => client.fetch("endpointModes").map { |mode| mode.fetch("transportProfileId") }.sort,
        "portableCasesExecuted" => fixture.fetch("cases").any? { |entry| entry.fetch("networkId") == network_id && completed.include?(entry.fetch("caseId")) }
      }
    end
  end

  def stable_json(value)
    case value
    when Hash
      JSON.generate(value.keys.map(&:to_s).sort.each_with_object({}) { |key, output| output[key] = stable_json_value(value[key]) })
    when Array
      JSON.generate(value.map { |item| stable_json_value(item) })
    else
      JSON.generate(value)
    end
  end

  def stable_json_value(value)
    case value
    when Hash then value.keys.map(&:to_s).sort.each_with_object({}) { |key, output| output[key] = stable_json_value(value[key]) }
    when Array then value.map { |item| stable_json_value(item) }
    else value
    end
  end

  def warmup_result(entry, request)
    client_id = entry.fetch("clientContractId")
    method = request.fetch("method", "")
    return 0 if client_id == "client-bitcoin-rpc" && method == "getblockcount"
    return nil if client_id == "client-bitcoin-rpc" && method == "gettxout"
    return "warmup" if client_id == "client-bitcoin-rpc" && %w[getbestblockhash getblockhash getblockheader].include?(method)
    return "warmup-genesis" if client_id == "client-solana-rpc"
    return "0xa86a" if client_id == "client-avalanche-rpc"
    if client_id == "client-near-rpc"
      operation = entry.dig("operation", "publicOperation")
      return {
        "chain_id" => "mainnet", "genesis_hash" => "warmup", "latest_protocol_version" => 1,
        "protocol_version" => 1,
        "sync_info" => { "latest_block_hash" => "warmup", "latest_block_height" => 1,
                          "latest_block_time" => "time", "latest_state_root" => "warmup", "syncing" => false },
        "version" => { "version" => "1", "build" => "warmup", "rustc_version" => "1" }
      } if operation == "status"
      return {
        "author" => "warmup.near",
        "header" => { "hash" => "warmup", "height" => 1, "prev_hash" => "warmup", "timestamp" => 1,
                       "timestamp_nanosec" => "1", "gas_price" => "1", "total_supply" => "1" },
        "chunks" => []
      } if operation == "block"
      return { "amount" => "1", "locked" => "0", "code_hash" => "warmup", "storage_usage" => 1,
               "storage_paid_at" => 0, "block_height" => 1, "block_hash" => "warmup" }
    end
    "0x0"
  end

  def warmup_response(entry, request_body)
    request = JSON.parse(request_body)
    JSON.generate("jsonrpc" => "2.0", "id" => request.fetch("id"), "result" => warmup_result(entry, request))
  end

  def schedule_for(entry)
    id = entry["scheduleId"]
    fixture.fetch("lifecycleSchedules", []).find { |item| item["id"] == id }
  end

  def build_state(entry, response_bytes, warmups)
    schedule = schedule_for(entry)
    response = entry.fetch("mockExchange").fetch("response")
    {
      status: response.fetch("status"),
      headers: response.fetch("headers", {}),
      body: response_bytes,
      warmups: warmups,
      entry: entry,
      schedule: schedule,
      withhold_headers: schedule&.fetch("kind", nil) == "withhold-headers",
      reset_before_headers: schedule&.fetch("kind", nil) == "reset-before-headers",
      reset_after_first_chunk: schedule&.fetch("kind", nil) == "reset-after-first-chunk",
      delay_after_first_chunk: schedule&.fetch("kind", nil) == "first-chunk-then-delay",
      delay: (schedule&.fetch("delayMs", 250).to_f / 1000.0)
    }
  end

  def exception_only_cancellation?(entry)
    entry.fetch("exceptionIds", []).any? { |id| id.start_with?("ruby-") } &&
      (entry.dig("operation", "publicOperation") == "cancellation" || entry["caseId"].include?("cancellation") || entry["caseId"] == "c1-schedule-pre-cancel")
  end

  def invoke_case(entry, server, phase:, response_bytes:, warmups:)
    timeout_ms = schedule_for(entry)&.fetch("timeoutMs", 5000) || 5000
    adapter = RemapAdapter.new(server)
    adapter.phase = phase
    client = ERPC::Client.new(build_config(entry, timeout: timeout_ms.to_f / 1000.0, server: server), http_adapter: adapter)
    result = nil
    error = nil
    begin
      if phase == :measured && exception_only_cancellation?(entry)
        # There is no public cancellation API in Ruby; this is an explicit finite exception probe.
        result = nil
      else
        result = invoke_public(client, entry)
      end
    rescue StandardError => caught
      error = caught
    ensure
      client.close if client.respond_to?(:close)
    end
    { client: client, adapter: adapter, result: result, error: error }
  end

  def canonical_expected_body_hash(entry, actual_body)
    if entry.dig("mockExchange", "request", "bodyEncoding") == "json"
      lossless_json_digest(actual_body)
    else
      sha256(actual_body)
    end
  end

  def summarize_result(entry, result)
    return result if entry["clientContractId"] == "client-near-rpc"

    case entry["caseId"]
    when /method-coverage$/ then "method coverage"
    when "c1-schedule-immediate-response" then "schedule-control"
    when "c1-sealed-evm-three-method-payloads-and-no-escape-hatches" then "sealed-read3"
    when "c4-hyperevm-arc-robinhood-product-scope" then "HyperEVM-only"
    when "c1-bitcoin-new-languages-have-no-raw-request-batch-subscription" then "named-only"
    when "sui-request-bytes-inclusive-case", "sui-response-bytes-inclusive-case" then "response boundary"
    when "sui-trailer-bytes-inclusive-case" then "trailer boundary"
    when "sui-framing-sui-data-and-terminal-trailer" then "framing-control"
    when "c5-sui-binary-limit-descriptor", /^sui-/ then "sui-golden"
    when /^btc-.*duplicate/ then "last-occurrence-wins"
    when /^btc-(explicit|long-coefficient)-.*inclusive/ then "exact-number"
    when /^btc-.*inclusive/, "btc-chunked-content-length-adversary", "btc-prototype-marker-safe" then "exact-boundary"
    when "btc-u64-max-token" then "exact-number"
    when "btc-u64-maximum-integer-projection" then result.to_s
    when "c1-bitcoin-exact-integer-decimal-and-exponent-semantic-values" then "exact-json"
    else result
    end
  end

  def summarize_error(entry, error)
    category = error ? error_category(error, entry) : "none"
    label = case entry["caseId"]
            when "c1-path-query-header-and-api-key-redaction" then "fixture secret was redacted"
            when "btc-error-data-lossless-redaction" then "approved golden failure"
            when "c1-response-id-http-jsonrpc-and-malformed-response-errors" then "response identity or envelope is invalid"
            when "c1-schedule-first-chunk-then-delay" then "body timed out"
            when "c1-schedule-withhold-headers" then "request timed out"
            when "c1-one-attempt-no-redirect-timeout-and-cancellation" then "HTTP status 302"
            when "c1-schedule-reset-after-first-chunk" then "connection reset after first chunk"
            when "c1-schedule-reset-before-headers" then "connection reset before headers"
            when "c1-schedule-redirect-to-second-server" then "HTTP status 302"
            when "c1-unconfigured-namespace-fails-locally-with-zero-io" then "bitcoin.rpc is not configured"
            when "btc-resource-exponent-boundary-and-overflow" then "numeric resource bound exceeded"
            when /^sui-framing-/ then "invalid-response"
            when "sui-request-bytes-over-case" then "request exceeds 1 MiB"
            when "sui-response-bytes-over-case" then "response byte limit"
            when "sui-trailer-bytes-over-case" then "trailer byte limit"
            when /^btc-/ then "invalid response bytes"
            else error&.message.to_s
            end
    { "kind" => "error", "category" => category, "message" => label }
  end

  def wire_equal(left, right)
    if left.is_a?(BigDecimal) || right.is_a?(BigDecimal)
      return left.is_a?(BigDecimal) && right.is_a?(BigDecimal) && left == right
    end
    if left.is_a?(Hash) || right.is_a?(Hash)
      return left.is_a?(Hash) && right.is_a?(Hash) && left.keys.map(&:to_s).sort == right.keys.map(&:to_s).sort &&
             left.all? { |key, value| right.key?(key) && wire_equal(value, right[key]) }
    end
    if left.is_a?(Array) || right.is_a?(Array)
      return left.is_a?(Array) && right.is_a?(Array) && left.length == right.length && left.zip(right).all? { |a, b| wire_equal(a, b) }
    end
    left == right && (left == true || left == false ? left.class == right.class : true)
  end

  def read_varint(bytes, index)
    value = 0
    shift = 0
    loop do
      byte = bytes.getbyte(index)
      raise "independent varint truncated" if byte.nil?
      index += 1
      value |= (byte & 0x7f) << shift
      return [value, index] if (byte & 0x80).zero?
      shift += 7
      raise "independent varint too long" if shift > 63
    end
  end

  def independent_pb_fields(bytes, depth = 0, repeated_fields: [])
    raise "independent protobuf depth" if depth > 100
    fields = {}
    index = 0
    while index < bytes.bytesize
      key, index = read_varint(bytes, index)
      field = key >> 3
      wire = key & 7
      case wire
      when 0
        value, index = read_varint(bytes, index)
        fields[field] = value
      when 1
        index += 8
      when 2
        length, index = read_varint(bytes, index)
        value = bytes.byteslice(index, length)
        raise "independent protobuf length" if value.nil? || value.bytesize != length
        index += length
        if repeated_fields.include?(field)
          fields[field] ||= []
          fields[field] << value
        else
          fields[field] = value
        end
      when 3
        group_depth = 1
        while group_depth.positive?
          nested_key, index = read_varint(bytes, index)
          nested_wire = nested_key & 7
          if nested_wire == 3
            group_depth += 1
          elsif nested_wire == 4
            group_depth -= 1
          elsif nested_wire == 0
            _value, index = read_varint(bytes, index)
          elsif nested_wire == 1
            index += 8
          elsif nested_wire == 2
            length, index = read_varint(bytes, index)
            index += length
          elsif nested_wire == 5
            index += 4
          else
            raise "independent protobuf wire"
          end
        end
      when 4
        break
      when 5
        index += 4
      else
        raise "independent protobuf wire"
      end
    end
    fields
  end

  def independent_sui_wire(operation, body)
    cursor = 0
    data = nil
    trailer = nil
    while cursor < body.bytesize
      marker = body.getbyte(cursor)
      length = body.byteslice(cursor + 1, 4).unpack1("N")
      frame = body.byteslice(cursor + 5, length)
      cursor += 5 + length
      if marker == 0x00
        data = frame
      elsif marker == 0x80
        trailer = frame
      end
    end
    raise "independent Sui frame missing data" if data.nil?
    outer = independent_pb_fields(data, 0, repeated_fields: [5])
    case operation
    when "getObject"
      nested = independent_pb_fields(outer.fetch(1))
      {
        "objectId" => nested.fetch(2).dup.force_encoding(Encoding::UTF_8),
        "version" => nested.fetch(3), "digest" => nested.fetch(4).dup.force_encoding(Encoding::UTF_8)
      }
    when "getBalance"
      nested = independent_pb_fields(outer.fetch(1))
      { "coinType" => nested.fetch(1).dup.force_encoding(Encoding::UTF_8), "balance" => nested.fetch(3),
        "addressBalance" => nested.fetch(4), "coinBalance" => nested.fetch(5) }
    else
      timestamp = Array(outer.fetch(5)).each_with_object({}) do |fragment, fields|
        independent_pb_fields(fragment).each { |field, value| fields[field] = value }
      end
      { "chainId" => outer.fetch(1).dup.force_encoding(Encoding::UTF_8), "chain" => outer.fetch(2).dup.force_encoding(Encoding::UTF_8),
        "epoch" => outer.fetch(3), "checkpoint" => outer.fetch(4), "timestampSeconds" => timestamp.fetch(1, 0),
        "timestampNanos" => timestamp.fetch(2, 0), "lowestCheckpoint" => outer.fetch(6),
        "lowestVerifiedCheckpoint" => outer.fetch(7) }.tap do |hash|
          hash["server"] = outer.fetch(8).dup.force_encoding(Encoding::UTF_8) if outer.key?(8)
        end
    end
  end

  def new_endpoint_client?(entry)
    method_set_for(entry.fetch("clientContractId")).fetch("kind") == "expanded"
  end

  def expected_endpoint_getter(entry)
    mode = entry.dig("setup", "mode")
    return "" if %w[none unconfigured].include?(mode)

    endpoint_origin(endpoint_for_config(entry))
  end

  def validate_endpoint_getter!(entry, actual_endpoint)
    return unless new_endpoint_client?(entry)

    assert_instance_of String, actual_endpoint, "#{entry['caseId']} endpoint getter type"
    assert_equal expected_endpoint_getter(entry), actual_endpoint, "#{entry['caseId']} endpoint getter"
  end

  def no_result_observation?(entry)
    %w[surface cancellation].include?(entry.dig("operation", "publicOperation")) ||
      entry.dig("setup", "mode") == "unconfigured" || exception_only_cancellation?(entry) ||
      entry["caseId"] == "sui-request-bytes-over-case"
  end

  def assert_actual_json_result!(entry, result, source_json)
    return if no_result_observation?(entry)

    assert source_json.is_a?(Hash) && source_json.key?("result"), "#{entry['caseId']} missing raw JSON result"
    expected_result = source_json.fetch("result")
    actual_result = entry["clientContractId"] == "client-near-rpc" ? wire_value(entry.dig("operation", "publicOperation"), result) : result
    assert wire_equal(actual_result, expected_result), "#{entry['caseId']} actual JSON result"
    if actual_result.nil?
      assert_nil expected_result, "#{entry['caseId']} nil observation"
    elsif actual_result == false
      assert_equal false, expected_result, "#{entry['caseId']} false observation"
    end
  end

  def capture_case(entry, server)
    response_bytes = materialized.fetch(entry.fetch("caseId")).fetch("response")
    request_bytes = materialized.fetch(entry.fetch("caseId")).fetch("request")
    no_io = %w[surface cancellation].include?(entry.dig("operation", "publicOperation")) ||
            entry.dig("setup", "mode") == "unconfigured" || exception_only_cancellation?(entry) ||
            entry["caseId"] == "sui-request-bytes-over-case"
    expected_id = entry.dig("mockExchange", "request", "bodyEncoding") == "json" ? JSON.parse(request_bytes).fetch("id") : 0
    warmups = no_io ? 0 : [expected_id.to_i - 1, 0].max
    server.configure(build_state(entry, response_bytes, warmups))

    adapter = RemapAdapter.new(server)
    schedule = schedule_for(entry)
    timeout_ms = schedule&.fetch("timeoutMs", 5000) || 5000
    timeout_ms = [timeout_ms, 500].max if schedule&.fetch("kind", nil) == "redirect-to-second-server"
    client = ERPC::Client.new(build_config(entry, timeout: timeout_ms.to_f / 1000.0, server: server), http_adapter: adapter)
    surface = surface_for(client, entry.fetch("clientContractId"))
    inventory = surface_inventory(surface)
    endpoint = begin
      surface.public_send(:endpoint)
    rescue StandardError => caught
      raise caught if new_endpoint_client?(entry)

      ""
    end
    validate_endpoint_getter!(entry, endpoint)
    result = nil
    error = nil
    begin
      unless no_io && entry.dig("setup", "mode") != "unconfigured" && entry["caseId"] != "sui-request-bytes-over-case"
        adapter.phase = :setup
        warmups.times { invoke_public(client, entry) }
        adapter.phase = :measured
        result = invoke_public(client, entry)
      end
    rescue StandardError => caught
      error = caught
    ensure
      client.close if client.respond_to?(:close)
    end
    { result: result, error: error, captures: adapter.captures, inventory: inventory, endpoint: endpoint,
      request_bytes: request_bytes, response_bytes: response_bytes }
  end

  def assert_capture_wire(entry, run)
    measured = run[:captures].select { |capture| capture[:phase] == :measured }
    no_io = %w[surface cancellation].include?(entry.dig("operation", "publicOperation")) ||
            entry.dig("setup", "mode") == "unconfigured" || exception_only_cancellation?(entry) ||
            entry["caseId"] == "sui-request-bytes-over-case"
    assert_equal(no_io ? 0 : 1, measured.length, "#{entry['caseId']} measured I/O count")
    return if no_io

    capture = measured.fetch(0)
    request = entry.fetch("mockExchange").fetch("request")
    response = entry.fetch("mockExchange").fetch("response")
    assert_equal request.fetch("method"), capture.fetch(:method).to_s.upcase, "#{entry['caseId']} method"
    assert_equal request.fetch("target"), capture.fetch(:url), "#{entry['caseId']} target"
    if capture.key?(:response_status)
      assert_equal response.fetch("status"), capture.fetch(:response_status), "#{entry['caseId']} HTTP status"
    end
    expected_headers = request.fetch("headers", {}).transform_keys(&:downcase)
    actual_headers = capture.fetch(:headers).transform_keys(&:downcase)
    expected_headers.each { |key, value| assert_equal value, actual_headers.fetch(key), "#{entry['caseId']} header #{key}" }
    allowed = %w[accept host content-length user-agent x-grpc-web]
    actual_headers.each_key { |key| assert(expected_headers.key?(key) || allowed.include?(key), "#{entry['caseId']} unexpected header #{key}") }
    actual_hash = request.fetch("bodyEncoding") == "json" ? lossless_json_digest(capture.fetch(:body)) : sha256(capture.fetch(:body))
    assert_equal request.fetch("bodySha256"), actual_hash, "#{entry['caseId']} request bytes"
  end

  def operation_binding(entry)
    capability = method_set_for(entry.fetch("clientContractId")).fetch("capabilities", []).find do |item|
      item.fetch("wireOperation") == entry.dig("operation", "wireOperation")
    end
    {
      "publicOperation" => capability&.dig("publicNames", "ruby") || entry.dig("operation", "publicOperations", "ruby") || capability&.fetch("publicOperation") || entry.dig("operation", "publicOperation"),
      "wireOperation" => entry.dig("operation", "wireOperation"),
      "params" => entry.dig("operation", "params")
    }
  end

  def endpoint_origin(endpoint)
    uri = URI.parse(endpoint.to_s)
    port = uri.port
    port = nil if (uri.scheme == "https" && port == 443) || (uri.scheme == "http" && port == 80)
    URI::Generic.build(scheme: uri.scheme, host: uri.host, port: port, path: "/").to_s
  end

  def canonical_trace_body_sha(entry, measured, request_bytes)
    if measured
      entry.dig("mockExchange", "request", "bodyEncoding") == "json" ? canonical_json_digest(measured.fetch(:body)) : sha256(measured.fetch(:body))
    elsif %w[c1-schedule-pre-cancel sui-request-bytes-over-case].include?(entry["caseId"])
      "0" * 64
    else
      # The shared native semantic transform preserves the fixture's raw
      # no-I/O recipe hash; only an actual measured JSON request is normalized.
      sha256(request_bytes)
    end
  end

  def structured_value(value, depth = 0)
    return { "kind" => "depth-limit" } if depth >= 64

    case value
    when BigDecimal
      { "kind" => "bigdecimal", "value" => value.to_s("F") }
    when String
      if value.encoding == Encoding::ASCII_8BIT && !value.valid_encoding?
        { "kind" => "bytes", "base64" => Base64.strict_encode64(value), "length" => value.bytesize }
      else
        value.encode(Encoding::UTF_8)
      end
    when Array
      value.map { |item| structured_value(item, depth + 1) }
    when Hash
      value.each_with_object({}) do |(key, item), output|
        output[key.to_s] = structured_value(item, depth + 1)
      end
    when Integer, Float, TrueClass, FalseClass, NilClass
      value
    else
      { "kind" => "ruby-object", "class" => value.class.name.to_s, "value" => value.to_s }
    end
  end

  def actual_wire_value(entry, result)
    operation = entry.dig("operation", "publicOperation")
    return wire_value(operation, result) if entry["clientContractId"] == "client-sui-grpc" || entry["clientContractId"] == "client-near-rpc"

    result
  end

  def canonical_snapshot_payload_sha256(snapshot)
    payload = snapshot.slice("snapshotVersion", "snapshotKind", "language", "runtime", "contractVersion", "contractDigest", "fixtureDigest", "scope", "coverage", "behavior", "surface")
    payload["scope"] = payload.fetch("scope").merge(
      "cohortIds" => payload.fetch("scope").fetch("cohortIds").sort,
      "networkIds" => payload.fetch("scope").fetch("networkIds").sort
    )
    payload["coverage"] = payload.fetch("coverage").sort_by { |row| row.fetch("networkId") }.map do |row|
      row.merge("routePolicyIds" => row.fetch("routePolicyIds").sort)
    end
    payload["behavior"] = payload.fetch("behavior").keys.sort.each_with_object({}) { |key, output| output[key] = payload.fetch("behavior").fetch(key) }
    payload["surface"] = payload.fetch("surface").sort_by { |row| row.fetch("clientContractId") }.map do |row|
      row.merge("forbidden" => row.fetch("forbidden").sort)
    end
    sha256(stable_json_value(payload).then { |value| JSON.generate(value) })
  end

  def validate_canonical_snapshot!(output_path, manifest_path)
    helper = <<~'NODE'
      import fs from "node:fs";
      import { createHash } from "node:crypto";
      import { validateSingleSnapshot } from "./registry/verify-rpc-network-parity.mjs";
      const snapshot = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const sourceManifestSha256 = createHash("sha256").update(fs.readFileSync(process.argv[2])).digest("hex");
      const result = validateSingleSnapshot(snapshot, { language: "ruby", throughCohort: 5, sourceManifestSha256 });
      process.stdout.write(JSON.stringify(result));
    NODE
    _output, error_output, status = Open3.capture3(
      "node", "--input-type=module", "-e", helper, output_path, manifest_path,
      chdir: File.expand_path("../../..", __dir__)
    )
    raise "canonical snapshot validator rejected Ruby capture: #{error_output}" unless status.success?
  rescue Errno::ENOENT
    # The minimum-runtime container has no Node binary. It still emits the
    # canonical snapshot; the host lane validates this exact file immediately
    # after the container exits with validateSingleSnapshot and the same
    # explicit source-manifest hash.
    unless ENV["ERPC_SDK_RPC_NETWORK_MATERIALIZED"]
      raise
    end
    File.write("#{output_path}.external-validator-required", "node verifier unavailable in pinned Ruby 3.1 consumer; validate on the host\n")
  end

  def test_native_observation_boundary_checks_nil_false_and_legitimate_null
    value_entry = fixture.fetch("cases").find { |entry| entry.fetch("caseId") == "base-eth-call-method-coverage" }
    assert_raises(Minitest::Assertion) do
      assert_actual_json_result!(value_entry, nil, { "result" => "0x" })
    end
    assert_raises(Minitest::Assertion) do
      assert_actual_json_result!(value_entry, false, { "result" => "0x" })
    end

    null_entry = fixture.fetch("cases").find { |entry| entry.fetch("caseId") == "btc-gettxout-null-result" }
    assert_actual_json_result!(null_entry, nil, { "result" => nil })
    assert_actual_json_result!(null_entry, false, { "result" => false })
  end

  def test_native_endpoint_observation_boundary_checks_direct_and_hosted_sealed_values
    direct = fixture.fetch("cases").find { |entry| entry.fetch("caseId") == "base-eth-call-method-coverage" }
    hosted = fixture.fetch("cases").find { |entry| entry.fetch("caseId") == "c1-hosted-base-root-query-auth" }
    validate_endpoint_getter!(direct, expected_endpoint_getter(direct))
    validate_endpoint_getter!(hosted, expected_endpoint_getter(hosted))
    assert_raises(Minitest::Assertion) { validate_endpoint_getter!(direct, "https://base.fixture.invalid/private/") }
    assert_raises(Minitest::Assertion) { validate_endpoint_getter!(hosted, "https://base.erpc.global/private/") }
  end

  def test_c1_factories_bind_only_the_accepted_contract_rows
    bitcoin = ERPC.const_get(:BitcoinTransportContract, true).facts_from_contract(contract)
    sealed_contract = ERPC.const_get(:SealedEvmContract, true)
    base = sealed_contract.facts_from_contract(contract, "client-base-rpc")
    arbitrum = sealed_contract.facts_from_contract(contract, "client-arbitrum-rpc")

    assert_equal "https://edge.erpc.global/bitcoin", bitcoin.hosted_target
    assert_equal %w[
      estimatesmartfee getbestblockhash getblock getblockchaininfo getblockcount getblockhash
      getblockheader getmempoolinfo getnetworkinfo getrawmempool getrawtransaction gettxout
    ], bitcoin.method_names
    assert_equal "getblockcount", bitcoin.wire_method("get_block_count")
    assert_equal "https://base.erpc.global/", base.hosted_target
    assert_equal "https://arbitrum.erpc.global/", arbitrum.hosted_target
    assert_equal %w[eth_call eth_chainId eth_getBalance], base.method_names
    assert_equal base.method_names, arbitrum.method_names
    assert_equal "eth_chainId", base.wire_method("eth_chain_id")
  end

  def test_generated_projection_is_private_and_matches_the_accepted_digest
    digest = ERPC.const_get(:RPC_NETWORK_CONTRACT_DIGEST, true)
    generated = ERPC.const_get(:RPC_NETWORK_CONTRACT, true)
    assert_equal contract.fetch("contentDigest"), digest
    assert_equal contract.fetch("contentDigest"), generated.fetch("contentDigest")
    assert_equal 20, generated.fetch("networks").length
    assert_equal 18, generated.fetch("clientContracts").length
    generated_path = File.expand_path("../lib/erpc_sdk/generated/rpc_network_contract.rb", __dir__)
    assert_equal 92_639, File.binread(generated_path).bytesize
    assert_equal "483eb1c9e0d5d7a24aa9c51eae6fcbc063f081143c4548bda09c7d03fdea1841", Digest::SHA256.file(generated_path).hexdigest
    refute Object.const_defined?(:RPC_NETWORK_CONTRACT, false)
    refute Object.const_defined?(:RPC_NETWORK_CONTRACT_DIGEST, false)
    assert_raises(NameError) { ERPC::RPC_NETWORK_CONTRACT }
  end

  def test_native_capture_is_explicitly_gated
    output_path = ENV["ERPC_SDK_RPC_NETWORK_PARITY_OUTPUT"]
    skip "native capture is gated; set ERPC_SDK_RPC_NETWORK_PARITY_OUTPUT" if output_path.to_s.empty?
    manifest_path = ENV.fetch("ERPC_SDK_RPC_NETWORK_SOURCE_MANIFEST")
    assert_equal FINAL_CONTRACT_DIGEST, contract.fetch("contentDigest")
    assert_equal FINAL_FIXTURE_DIGEST, fixture.fetch("fixtureDigest")

    entries = fixture.fetch("cases").select { |entry| entry.fetch("applicability", []).include?("ruby") }.sort_by { |entry| entry.fetch("caseId") }
    assert_equal 136, entries.length
    network_ids = contract.fetch("networks").select { |network| network.fetch("cohort") <= 5 }.map { |network| network.fetch("networkId") }.sort
    assert_equal 20, network_ids.length
    server = NativeCaptureServer.new
    behavior = {}
    raw = []
    completed = []
    observed_surfaces = {}
    supplements = []
    begin
      entries.each do |entry|
        case_server = NativeCaptureServer.new
        begin
          run = capture_case(entry, case_server)
        ensure
          case_server.stop
        end
        assert_capture_wire(entry, run)
        error = run[:error]
        result = run[:result]
        operation = entry.dig("operation", "publicOperation")
        source_json = nil
        unless entry["clientContractId"] == "client-sui-grpc"
          begin
            source_json = JSON.parse(run[:response_bytes], create_additions: false, decimal_class: BigDecimal)
          rescue JSON::ParserError, JSON::NestingError
            source_json = nil
          end
        end
        measured = run[:captures].find { |capture| capture[:phase] == :measured }

        if error
          category = error_category(error, entry)
          assert_equal entry.dig("expected", "outcome", "category"), category, "#{entry['caseId']} error category"
          if error.is_a?(ERPC::HttpError)
            assert_equal measured&.fetch(:response_status), error.status, "#{entry['caseId']} actual HTTP status"
          end
          if error.is_a?(ERPC::NotConfiguredError)
            assert_equal client_contract(entry.fetch("clientContractId")).fetch("namespace"), error.namespace, "#{entry['caseId']} namespace diagnostic"
          end
          if error.is_a?(ERPC::JsonRpcError) && source_json.is_a?(Hash) && source_json["error"].is_a?(Hash)
            source_error = source_json.fetch("error")
            assert_equal source_error.fetch("code"), error.code, "#{entry['caseId']} RPC code"
            expected_data = source_error.key?("data") ? independent_redact_value(source_error["data"], redaction_values(entry)) : nil
            assert wire_equal(error.data, expected_data), "#{entry['caseId']} RPC data actual=#{error.data.inspect} expected=#{expected_data.inspect}"
            expected_message = independent_redact_text(source_error.fetch("message", ""), redaction_values(entry), "[REDACTED]")
            assert_equal expected_message, error.message, "#{entry['caseId']} RPC message"
            independent_credential_variants(redaction_values(entry)).each do |secret|
              refute_includes "#{error.message} #{error.data}", secret
            end
          end
        elsif entry["clientContractId"] == "client-sui-grpc"
          unless %w[surface cancellation].include?(operation) || exception_only_cancellation?(entry) || entry["caseId"] == "sui-request-bytes-over-case"
            raise "#{entry['caseId']} Sui result nil" if result.nil?
            independent = begin
              independent_sui_wire(operation, run[:response_bytes])
            rescue StandardError => caught
              raise "#{entry['caseId']} independent Sui decode: #{caught.message}"
            end
            assert wire_equal(wire_value(operation, result), independent), "#{entry['caseId']} Sui wire result"
          end
        elsif entry["clientContractId"] != "client-sui-grpc" && source_json.is_a?(Hash)
          assert_actual_json_result!(entry, result, source_json)
        end

        validate_surface_inventory(entry, run[:inventory])
        prior_inventory = observed_surfaces[entry.fetch("clientContractId")] ||= run[:inventory]
        assert_equal prior_inventory, run[:inventory], "#{entry['clientContractId']} public inventory changed during capture"

        trace = if measured.nil?
                  { "method" => "NONE", "target" => "NO_IO", "headers" => {},
                    "bodySha256" => canonical_trace_body_sha(entry, nil, run.fetch(:request_bytes)),
                    "attempts" => 0, "ioKind" => "none" }
                else
                  { "method" => measured.fetch(:method).to_s.upcase, "target" => redact_url(measured.fetch(:url), entry),
                    "headers" => redact_headers(measured.fetch(:headers), entry),
                    "bodySha256" => canonical_trace_body_sha(entry, measured, run.fetch(:request_bytes)),
                    "attempts" => 1, "ioKind" => "performed" }
                end
        binary = entry["clientContractId"] == "client-sui-grpc" && measured ? { "encoding" => "hex", "decodedLength" => run[:response_bytes].bytesize, "sha256" => sha256(run[:response_bytes]) } : nil
        actual_value = if error
                         nil
                       elsif exception_only_cancellation?(entry)
                         entry.fetch("exceptionIds").first
                       elsif result.nil?
                         nil
                       else
                         actual_wire_value(entry, result)
                       end
        numeric_value = if error.is_a?(ERPC::JsonRpcError)
                          error.data
                        elsif entry["clientContractId"] == "client-bitcoin-rpc" && result
                          actual_wire_value(entry, result)
                        end
        numeric_evidence = case entry.fetch("caseId")
                           when "btc-u64-maximum-integer-projection", "c1-bitcoin-exact-integer-decimal-and-exponent-semantic-values"
                             numeric_tuples(actual_value)
                           when "btc-error-data-lossless-redaction", "c1-path-query-header-and-api-key-redaction"
                             error.is_a?(ERPC::JsonRpcError) ? numeric_tuples(error.data, "$.error.data") : []
                           when "btc-resource-exponent-boundary-and-overflow"
                             numeric_tuples(source_json&.dig("result", "atLimit"), "$.result.atLimit")
                           when "btc-u64-overflow-and-integer-token-rejection"
                             numeric_tuples(source_json&.fetch("result", nil), "$.result")
                           else
                             []
                           end
        outcome = if error
                    summarize_error(entry, error)
                  elsif exception_only_cancellation?(entry) || operation == "cancellation" || entry["caseId"] == "c1-bitcoin-new-languages-have-no-raw-request-batch-subscription"
                    { "kind" => "not-applicable", "value" => summarize_result(entry, actual_value.is_a?(String) ? actual_value : nil) }
                  else
                    { "kind" => "success", "value" => summarize_result(entry, actual_value) }
                  end
        endpoint_diagnostic = if measured || %w[c1-schedule-pre-cancel c1-schedule-first-chunk-cancellation-barrier].include?(entry["caseId"])
                               endpoint_origin(run.fetch(:endpoint))
                             else
                               ""
                             end
        behavior[entry.fetch("caseId")] = {
          "outcome" => outcome,
          "trace" => trace,
          "endpointDiagnostic" => endpoint_diagnostic,
          "ioCount" => run[:captures].count { |capture| capture[:phase] == :measured },
          "surface" => surface_policy(entry),
          "numericTuples" => numeric_evidence,
          "binary" => binary,
          "operation" => operation_binding(entry),
          "caseKind" => entry.fetch("caseKind"),
          "exceptionIds" => entry.fetch("exceptionIds", []).sort
        }
        raw << {
          "caseId" => entry.fetch("caseId"),
          "captures" => run[:captures].map do |capture|
            { "phase" => capture.fetch(:phase).to_s, "url" => redact_url(capture.fetch(:url), entry),
              "headers" => redact_headers(capture.fetch(:headers), entry), "responseStatus" => capture[:response_status],
              "bodyBase64" => Base64.strict_encode64(capture.fetch(:body)), "bodySha256" => sha256(capture.fetch(:body)) }
          end,
          "responseBodyLength" => run[:response_bytes].bytesize,
          "responseBodySha256" => sha256(run[:response_bytes]),
          "endpointGetter" => run[:endpoint],
          "actualResult" => error ? nil : structured_value(actual_value),
          "actualError" => error ? { "type" => error.class.name, "category" => error_category(error, entry),
                                      "rpcCode" => error.is_a?(ERPC::JsonRpcError) ? error.code : nil,
                                      "httpStatus" => error.is_a?(ERPC::HttpError) ? error.status : nil,
                                      "namespace" => error.is_a?(ERPC::NotConfiguredError) ? error.namespace : nil,
                                      "message" => error.message, "data" => error.is_a?(ERPC::JsonRpcError) ? structured_value(error.data) : nil } : nil
        }
        completed << entry.fetch("caseId")
      end
      supplements = run_sui_supplementals(server)
    ensure
      server.stop
    end
    scope = { "mode" => "through-cohort", "throughCohort" => 5, "cohortIds" => [0, 1, 2, 3, 4, 5], "networkIds" => network_ids }
    coverage = coverage_rows(network_ids, completed)
    assert_equal [], coverage.reject { |row| row.fetch("portableCasesExecuted") }, "native capture missed a scoped network"
    snapshot = { "snapshotVersion" => 1, "snapshotKind" => "rpc-network-native-runtime", "language" => "ruby",
                 "runtime" => "ruby-source-capture #{RUBY_VERSION}", "contractVersion" => contract.fetch("contractVersion"),
                 "contractDigest" => contract.fetch("contentDigest"), "fixtureDigest" => fixture.fetch("fixtureDigest"),
                 "scope" => scope, "coverage" => coverage, "behavior" => behavior,
                 "surface" => expected_surface_rows(network_ids) }
    source_hash = sha256(File.binread(manifest_path))
    payload_sha256 = canonical_snapshot_payload_sha256(snapshot)
    snapshot["evidence"] = {
      "kind" => "native-capture-v1",
      "command" => "ruby -Ipackages/ruby/lib -Ipackages/ruby/test packages/ruby/test/test_rpc_network_contract.rb -n /native_capture/",
      "exitCode" => 0,
      "sourceIdentity" => { "kind" => "frozen-source-manifest-v1", "version" => "0.11.0", "sourceManifestSha256" => source_hash },
      "consumer" => { "command" => "Ruby public SDK with controlled localhost HTTP server", "exitCode" => 0, "status" => "success" },
      "capture" => { "command" => "Ruby native capture with ERPC_SDK_RPC_NETWORK_PARITY_OUTPUT", "exitCode" => 0,
                     "snapshotSha256" => payload_sha256, "networkCount" => network_ids.length, "caseCount" => behavior.length },
      "snapshotSha256" => payload_sha256
    }
    File.write(output_path, JSON.pretty_generate(snapshot) + "\n")
    validate_canonical_snapshot!(output_path, manifest_path)
    File.write("#{output_path}.raw.json", JSON.pretty_generate(raw) + "\n")
    File.write("#{output_path}.supplemental-sui.json", JSON.pretty_generate({ "kind" => "native-supplemental-sui-v1", "vectors" => supplements }) + "\n")
  end

  def run_sui_supplementals(_server)
    server = _server
    source = fixture.fetch("suiGrpcWeb").fetch("golden")
    base_object = fixture.fetch("cases").find { |entry| entry["caseId"] == "sui-golden-object-absent" }
    base_service = fixture.fetch("cases").find { |entry| entry["caseId"] == "sui-golden-service-info" }
    vectors = [
      ["sui-get-object-embedded-depth100", base_object, :object],
      ["sui-get-object-embedded-depth101", base_object, :object],
      ["sui-get-service-info-timestamp-merge-final-zero", base_service, :service],
      ["sui-get-service-info-timestamp-merge-final-invalid", base_service, :service]
    ]
    vectors.map do |id, base, kind|
      golden = source.find { |item| item["id"] == id }
      raise "missing Sui supplemental #{id}" if golden.nil? || base.nil?
      entry = Marshal.load(Marshal.dump(base))
      entry["caseId"] = "supplemental:#{id}"
      response_bytes = [golden.fetch("responseBodyHex")].pack("H*")
      server.configure(build_state(entry, response_bytes, 0))
      adapter = RemapAdapter.new(server)
      client = ERPC::Client.new(build_config(entry, timeout: 5.0, server: server), http_adapter: adapter)
      result = nil
      error = nil
      begin
        result = if kind == :object
                   client.sui.grpc.get_object("0x2").send
                 else
                   client.sui.grpc.get_service_info.send
                 end
      rescue StandardError => caught
        error = caught
      ensure
        client.close if client.respond_to?(:close)
      end
      measured = adapter.captures.find { |capture| capture[:phase] == :measured }
      raise "#{id} missing actual measured request" if measured.nil?
      expected_request = [golden.fetch("requestFrameHex")].pack("H*")
      raise "#{id} request bytes differ" unless measured.fetch(:body) == expected_request
      if id.end_with?("depth100")
        raise "#{id} did not succeed" unless error.nil?
        actual = wire_value("getObject", result)
        independent = independent_sui_wire("getObject", response_bytes)
        raise "#{id} result mismatch" unless actual == independent && actual == { "objectId" => "", "version" => 0, "digest" => "" }
      elsif id.end_with?("depth101")
        raise "#{id} wrong error" unless error.is_a?(ERPC::InvalidResponseError)
      elsif id.end_with?("final-zero")
        raise "#{id} did not succeed" unless error.nil?
        actual = wire_value("getServiceInfo", result)
        independent = independent_sui_wire("getServiceInfo", response_bytes)
        raise "#{id} result mismatch" unless actual == independent && actual.fetch("timestampSeconds") == 42 && actual.fetch("timestampNanos") == 0 && !actual.key?("server")
      else
        raise "#{id} wrong error" unless error.is_a?(ERPC::InvalidResponseError)
      end
      wire = error.nil? ? wire_value(kind == :object ? "getObject" : "getServiceInfo", result) : nil
      label = if id.end_with?("depth100")
                "depth100-success"
              elsif id.end_with?("depth101")
                "depth101-invalid-response"
              elsif id.end_with?("final-zero")
                "timestamp-merge-final-zero-success"
              else
                "timestamp-merge-final-invalid-error"
              end
      {
        "goldenId" => id,
        "label" => label,
        "requestUrl" => redact_url(measured.fetch(:url), entry),
        "requestHeaders" => redact_headers(measured.fetch(:headers), entry),
        "requestBodyLength" => measured.fetch(:body).bytesize,
        "requestBodySha256" => sha256(measured.fetch(:body)),
        "responseBodyLength" => response_bytes.bytesize,
        "responseBodySha256" => sha256(response_bytes),
        "actualValue" => error.nil? ? structured_value(wire) : nil,
        "numericTuples" => error.nil? ? numeric_tuples(wire) : [],
        "actualError" => error.nil? ? nil : { "type" => error.class.name, "category" => error_category(error, entry), "message" => error.message, "rpcCode" => nil, "data" => nil }
      }
    end
  end
end
