# frozen_string_literal: true

require "base64"
require "digest/sha1"
require "json"
require "openssl"
require "securerandom"
require "socket"
require "thread"
require "timeout"
require "uri"

module ERPC
  class WebSocketConnection
    MAX_MESSAGE_SIZE = 16 * 1024 * 1024
    private_constant :MAX_MESSAGE_SIZE

    def initialize(url, timeout)
      @uri = URI.parse(url)
      @timeout = timeout
      @write_mutex = Mutex.new
      connect
    end

    def write_text(text)
      write_frame(0x1, text.b)
    end

    def read_message
      payload = +"".b
      started = false
      loop do
        final, opcode, chunk = read_frame
        case opcode
        when 0x0
          raise TransportError, "ERPC returned an invalid WebSocket frame" unless started
          payload << chunk
        when 0x1, 0x2
          raise TransportError, "ERPC returned an invalid WebSocket frame" if started
          started = true
          payload << chunk
        when 0x8
          raise TransportError, "ERPC WebSocket connection closed"
        when 0x9
          write_frame(0xA, chunk)
          next
        when 0xA
          next
        else
          raise TransportError, "ERPC returned an invalid WebSocket frame"
        end
        raise TransportError, "ERPC WebSocket message is too large" if payload.bytesize > MAX_MESSAGE_SIZE
        return payload.force_encoding(Encoding::UTF_8) if final
      end
    end

    def close
      write_frame(0x8, "".b)
    rescue StandardError
      nil
    ensure
      @socket&.close
    end

    private

    def connect
      unless %w[ws wss].include?(@uri.scheme) && @uri.host
        raise ConfigError, "WebSocket endpoint must be an absolute WS(S) URL"
      end

      tcp = Timeout.timeout(@timeout) { TCPSocket.new(@uri.host, @uri.port) }
      @socket = if @uri.scheme == "wss"
                  context = OpenSSL::SSL::SSLContext.new
                  context.set_params
                  ssl = OpenSSL::SSL::SSLSocket.new(tcp, context)
                  ssl.hostname = @uri.host if ssl.respond_to?(:hostname=)
                  ssl.sync_close = true
                  Timeout.timeout(@timeout) { ssl.connect }
                  ssl
                else
                  tcp
                end
      handshake
    rescue ::Timeout::Error
      tcp&.close
      raise TimeoutError, @timeout
    rescue ConfigError, TimeoutError
      tcp&.close
      raise
    rescue IOError, EOFError, SocketError, SystemCallError, OpenSSL::SSL::SSLError
      tcp&.close
      raise TransportError, "Unable to reach ERPC WebSocket"
    end

    def handshake
      key = Base64.strict_encode64(SecureRandom.random_bytes(16))
      host = @uri.host
      default_port = (@uri.scheme == "wss" ? 443 : 80)
      host = "#{host}:#{@uri.port}" unless @uri.port == default_port
      request = [
        "GET #{@uri.request_uri} HTTP/1.1",
        "Host: #{host}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: #{key}",
        "Sec-WebSocket-Version: 13",
        "\r\n"
      ].join("\r\n")
      Timeout.timeout(@timeout) { @socket.write(request) }
      headers = read_until("\r\n\r\n", 64 * 1024)
      status, *lines = headers.split("\r\n")
      raise TransportError, "ERPC rejected the WebSocket upgrade" unless status&.match?(%r{\AHTTP/1\.[01] 101\b})

      response_headers = lines.filter_map do |line|
        name, separator, value = line.partition(":")
        [name.downcase, value.strip] unless separator.empty?
      end.to_h
      expected = Base64.strict_encode64(Digest::SHA1.digest("#{key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
      unless response_headers["upgrade"]&.downcase == "websocket" &&
             response_headers["connection"]&.downcase&.split(/\s*,\s*/)&.include?("upgrade") &&
             secure_compare(response_headers["sec-websocket-accept"].to_s, expected)
        raise TransportError, "ERPC returned an invalid WebSocket upgrade"
      end
    rescue ::Timeout::Error
      raise TimeoutError, @timeout
    end

    def read_until(delimiter, limit)
      value = +"".b
      until value.end_with?(delimiter)
        value << read_exact(1)
        raise TransportError, "ERPC returned oversized WebSocket headers" if value.bytesize > limit
      end
      value
    end

    def read_frame
      header = read_exact(2).bytes
      unless (header[0] & 0x70).zero?
        raise TransportError, "ERPC returned an invalid WebSocket frame"
      end
      final = (header[0] & 0x80) != 0
      opcode = header[0] & 0x0F
      masked = (header[1] & 0x80) != 0
      raise TransportError, "ERPC returned an invalid WebSocket frame" if masked

      length = header[1] & 0x7F
      length = read_exact(2).unpack1("n") if length == 126
      length = read_exact(8).unpack1("Q>") if length == 127
      if opcode >= 0x8 && (!final || length > 125)
        raise TransportError, "ERPC returned an invalid WebSocket control frame"
      end
      raise TransportError, "ERPC WebSocket message is too large" if length > MAX_MESSAGE_SIZE

      payload = read_exact(length)
      [final, opcode, payload]
    end

    def write_frame(opcode, payload)
      mask = SecureRandom.random_bytes(4)
      header = [0x80 | opcode]
      length = payload.bytesize
      if length < 126
        header << (0x80 | length)
        prefix = header.pack("C*")
      elsif length <= 65_535
        header << (0x80 | 126)
        prefix = header.pack("C*") + [length].pack("n")
      else
        header << (0x80 | 127)
        prefix = header.pack("C*") + [length].pack("Q>")
      end
      masked = payload.bytes.each_with_index.map { |byte, index| byte ^ mask.getbyte(index % 4) }.pack("C*")
      @write_mutex.synchronize do
        Timeout.timeout(@timeout) { @socket.write(prefix + mask + masked) }
      end
    rescue ::Timeout::Error
      raise TimeoutError, @timeout
    rescue IOError, EOFError, SocketError, SystemCallError, OpenSSL::SSL::SSLError
      raise TransportError, "Unable to reach ERPC WebSocket"
    end

    def read_exact(length)
      value = +"".b
      while value.bytesize < length
        ready = IO.select([@socket], nil, nil, @timeout)
        raise TimeoutError, @timeout unless ready

        chunk = @socket.readpartial(length - value.bytesize)
        raise EOFError if chunk.empty?

        value << chunk
      end
      value
    rescue EOFError, IOError, SocketError, SystemCallError, OpenSSL::SSL::SSLError
      raise TransportError, "ERPC WebSocket connection closed"
    end

    def secure_compare(left, right)
      return false unless left.bytesize == right.bytesize

      left.bytes.zip(right.bytes).reduce(0) { |difference, (a, b)| difference | (a ^ b) }.zero?
    end
  end

  class WebSocketJsonRpcTransport
    def initialize(connection_url, credential, timeout, connection_factory: nil)
      @connection_url = connection_url
      @credential = credential
      @timeout = timeout
      @connection_factory = connection_factory || ->(url, seconds) { WebSocketConnection.new(url, seconds) }
      @mutex = Mutex.new
      @connection = nil
      @reader = nil
      @pending = {}
      @listeners = {}
      @next_id = 0
      @next_listener_id = 0
      @closed = false
    end

    def request(method, params = nil)
      connection = ensure_connection
      request_id = @mutex.synchronize { @next_id += 1 }
      queue = Queue.new
      @mutex.synchronize { @pending[request_id] = queue }
      body = { "jsonrpc" => "2.0", "id" => request_id, "method" => method }
      body["params"] = params unless params.nil?
      connection.write_text(JSON.generate(body))
      response = Timeout.timeout(@timeout) { queue.pop }
      raise response if response.is_a?(Exception)

      unwrap(response, request_id)
    rescue ::Timeout::Error
      raise TimeoutError, @timeout
    ensure
      @mutex.synchronize { @pending.delete(request_id) } if request_id
    end

    def on_notification(listener = nil, &block)
      selected = listener || block
      raise ArgumentError, "listener is required" unless selected

      listener_id = @mutex.synchronize do
        @next_listener_id += 1
        @listeners[@next_listener_id] = selected
        @next_listener_id
      end
      -> { @mutex.synchronize { @listeners.delete(listener_id) } }
    end

    def close
      connection = @mutex.synchronize do
        return if @closed

        @closed = true
        current, @connection = @connection, nil
        current
      end
      connection&.close
      @reader&.join(1)
      fail_pending(TransportError.new("WebSocket transport is closed"))
      @mutex.synchronize { @listeners.clear }
      nil
    end

    private

    def ensure_connection
      @mutex.synchronize do
        raise TransportError, "WebSocket transport is closed" if @closed
        return @connection if @connection

        @connection = @connection_factory.call(@connection_url, @timeout)
        connection = @connection
        @reader = Thread.new { read_loop(connection) }
        @reader.report_on_exception = false
        connection
      end
    end

    def read_loop(connection)
      loop do
        value = JSON.parse(connection.read_message)
        next unless value.is_a?(Hash)

        id = value["id"]
        if id.is_a?(Integer) || id.is_a?(String)
          queue = @mutex.synchronize { @pending[id] }
          queue << value if queue
        elsif value["method"].is_a?(String) && value.key?("params")
          listeners = @mutex.synchronize { @listeners.values.dup }
          listeners.each do |listener|
            listener.call(value)
          rescue StandardError
            next
          end
        end
      rescue JSON::ParserError
        next
      end
    rescue StandardError => error
      @mutex.synchronize { @connection = nil if @connection.equal?(connection) }
      fail_pending(TransportError.new(Redaction.text(error.message, @credential)))
    end

    def fail_pending(error)
      queues = @mutex.synchronize { @pending.values.dup }
      queues.each { |queue| queue << error }
    end

    def unwrap(response, expected_id)
      unless response.is_a?(Hash) && response["id"] == expected_id
        raise InvalidResponseError, "ERPC returned an invalid WebSocket response"
      end
      if response.key?("error")
        error = response["error"]
        unless error.is_a?(Hash) && error["code"].is_a?(Integer) && error["message"].is_a?(String)
          raise InvalidResponseError, "ERPC returned an invalid RPC error"
        end
        data = error.key?("data") ? Redaction.value(error["data"], @credential) : nil
        raise JsonRpcError.new(error["code"], Redaction.text(error["message"], @credential), data)
      end
      raise InvalidResponseError, "ERPC returned an invalid WebSocket response" unless response.key?("result")

      response["result"]
    end
  end

  class RpcSubscription
    include Enumerable

    attr_reader :id

    def initialize(id, queue, unsubscribe)
      @id = id
      @queue = queue
      @unsubscribe = unsubscribe
      @closed = false
    end

    def each
      return enum_for(:each) unless block_given?

      loop { yield self.next }
    rescue StopIteration
      self
    end

    def next(timeout: nil)
      raise StopIteration if @closed && @queue.empty?

      return @queue.pop if timeout.nil?

      Timeout.timeout(timeout) { @queue.pop }
    rescue ::Timeout::Error
      raise TimeoutError, timeout
    end

    def unsubscribe
      return true if @closed

      result = @unsubscribe.call
      @closed = true if result
      result
    end
  end

  class SubscriptionsBase
    def initialize(transport)
      @transport = transport
    end

    def on_notification(listener = nil, &block)
      @transport.on_notification(listener, &block)
    end

    def raw(method, params = nil)
      @transport.request(method, params)
    end

    def close
      @transport.close
    end

    private

    def subscribe_to(subscribe_method, params, unsubscribe_method, listener)
      queue = Queue.new
      subscription_id = nil
      remove = @transport.on_notification do |notification|
        raw_params = notification["params"]
        next unless raw_params.is_a?(Hash) && raw_params["subscription"] == subscription_id && raw_params.key?("result")

        result = raw_params["result"]
        queue << result
        listener&.call(result)
      end
      subscription_id = @transport.request(subscribe_method, params)
      unless subscription_id.is_a?(Integer) || subscription_id.is_a?(String)
        remove.call
        raise InvalidResponseError, "ERPC returned an invalid subscription id"
      end
      unsubscribe = lambda do
        result = @transport.request(unsubscribe_method, [subscription_id])
        raise InvalidResponseError, "ERPC returned an invalid unsubscribe result" unless [true, false].include?(result)

        remove.call if result
        result
      end
      RpcSubscription.new(subscription_id, queue, unsubscribe)
    rescue StandardError
      remove&.call
      raise
    end
  end

  class EthereumSubscriptions < SubscriptionsBase
    def subscribe(subscription, *options, listener: nil, &block)
      result = subscribe_to("eth_subscribe", [subscription, *options], "eth_unsubscribe", listener || block)
      unless result.id.is_a?(String)
        result.unsubscribe
        raise InvalidResponseError, "ERPC returned an invalid subscription id"
      end
      result
    end
  end

  class SolanaSubscriptions < SubscriptionsBase
    def account_subscribe(address, options = nil, listener: nil, &block)
      params = [address]
      params << options unless options.nil?
      numeric_subscribe("accountSubscribe", params, "accountUnsubscribe", listener || block)
    end

    def transaction_subscribe(filter, options = nil, listener: nil, &block)
      params = [filter]
      params << options unless options.nil?
      numeric_subscribe("transactionSubscribe", params, "transactionUnsubscribe", listener || block)
    end

    def raw_subscribe(subscribe_method, params, unsubscribe_method, listener: nil, &block)
      subscribe_to(subscribe_method, params, unsubscribe_method, listener || block)
    end

    private

    def numeric_subscribe(subscribe_method, params, unsubscribe_method, listener)
      result = subscribe_to(subscribe_method, params, unsubscribe_method, listener)
      unless result.id.is_a?(Integer)
        result.unsubscribe
        raise InvalidResponseError, "ERPC returned an invalid subscription id"
      end
      result
    end
  end
end
