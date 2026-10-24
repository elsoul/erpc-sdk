# frozen_string_literal: true

require_relative "test_helper"
require "json"

class SuiTest < Minitest::Test
  def proto
    ERPC.const_get(:SuiProto, true)
  end

  def transport_class
    ERPC.const_get(:SuiGrpcWebTransport, true)
  end

  def facts
    @facts ||= ERPC.const_get(:SuiContract, true).facts_from_contract(
      JSON.parse(File.read(File.expand_path("../../../registry/rpc-network-contract.json", __dir__)))
    )
  end

  def frame(payload, trailer: "grpc-status: 0\r\n")
    "\x00".b + [payload.bytesize].pack("N") + payload + "\x80".b + [trailer.bytesize].pack("N") + trailer
  end

  def test_golden_request_frames_preserve_optional_zero
    assert_equal "0000000000", proto.service_info_request.unpack1("H*")
    assert_equal "00000000070a033078321000", proto.object_request("0x2", 0).unpack1("H*")
    assert_equal "00000000050a03307832", proto.object_request("0x2").unpack1("H*")
    assert_equal "000000000d0a056f776e65721204636f696e", proto.balance_request("owner", "coin").unpack1("H*")
  end

  def test_bounded_proto_decodes_service_object_and_balance
    timestamp = proto.encode_u64(1, 1) + proto.encode_u64(2, 123)
    service = proto.encode_string(1, "chain") + proto.encode_string(2, "mainnet") +
              proto.encode_u64(3, 18_446_744_073_709_551_615) + proto.encode_u64(4, 42) +
              proto.encode_key(5, 2) + proto.encode_varint(timestamp.bytesize) + timestamp +
              proto.encode_u64(6, 0) + proto.encode_u64(7, 0) + proto.encode_string(8, "sui-test")
    info = proto.parse_service_info(proto.decode_frames(frame(service)))
    assert_equal "mainnet", info.chain
    assert_equal 18_446_744_073_709_551_615, info.epoch
    assert_equal 123, info.timestamp_nanos
    assert_equal "sui-test", info.server

    object = proto.encode_string(2, "0x2") + proto.encode_u64(3, 0) + proto.encode_string(4, "digest")
    object_result = proto.parse_object_response(proto.decode_frames(frame(proto.encode_key(1, 2) + proto.encode_varint(object.bytesize) + object)))
    assert_equal 0, object_result.version
    assert_equal "0x2", object_result.sui_object_id
    assert_kind_of Integer, object_result.object_id

    balance = proto.encode_string(1, "coin") + proto.encode_u64(3, 5) + proto.encode_u64(4, 2) + proto.encode_u64(5, 3)
    balance_result = proto.parse_balance_response(proto.decode_frames(frame(proto.encode_key(1, 2) + proto.encode_varint(balance.bytesize) + balance)))
    assert_equal 5, balance_result.balance
  end

  def test_sui_transport_is_streamed_direct_and_sealed
    requests = []
    codec = proto
    adapter = Object.new
    adapter.define_singleton_method(:request_stream) do |**request, &block|
      requests << request
      payload = codec.encode_string(1, "chain") + codec.encode_string(2, "mainnet") +
                codec.encode_u64(3, 1) + codec.encode_u64(4, 2) +
                codec.encode_key(5, 2) + codec.encode_varint(0) +
                codec.encode_u64(6, 0) + codec.encode_u64(7, 0)
      trailer = "grpc-status: 0\r\n"
      block.call(200, ["\x00".b, [payload.bytesize].pack("N"), payload, "\x80".b, [trailer.bytesize].pack("N"), trailer], { "content-type" => ["application/grpc-web+proto"] })
    end
    endpoint = ERPC::SuiGrpcWebEndpointConfig.new(
      base_url: "https://customer.example/sui?token=a%2Fb&region=eu",
      headers: { "authorization" => "Bearer direct-secret", "x-sui" => "sui-only" }
    )
    rpc = ERPC::SuiClient.new(
      transport_class.new(facts: facts, direct_endpoint: endpoint, adapter: adapter)
    ).grpc
    result = rpc.get_service_info.send
    assert_equal "mainnet", result.chain
    assert_equal "https://customer.example/", rpc.endpoint
    assert_equal "https://customer.example/sui/sui.rpc.v2.LedgerService/GetServiceInfo?token=a%2Fb&region=eu", requests.first.fetch(:url)
    assert_equal "application/grpc-web+proto", requests.first.fetch(:headers).fetch("content-type")
    assert_equal "Bearer direct-secret", requests.first.fetch(:headers).fetch("authorization")
    assert_equal %w[endpoint get_balance get_object get_service_info inspect].sort, rpc.public_methods(false).map(&:to_s).sort
    refute_includes rpc.inspect, "customer.example/sui"
    refute_includes rpc.inspect, "direct-secret"
    refute rpc.respond_to?(:raw)
  end

  def test_frame_and_trailer_failures_are_safe
    assert_raises(ERPC::InvalidResponseError) { proto.decode_frames("\x01\x00\x00\x00\x00".b) }
    assert_raises(ERPC::InvalidResponseError) { proto.decode_frames(frame("x", trailer: "grpc-status: 1\r\n")) }
    assert_raises(ERPC::InvalidResponseError) { proto.decode_frames(frame("x", trailer: "Grpc-status: 0\r\n")) }
  end

  def test_public_sui_paths_are_deeply_immutable
    assert ERPC::SUI_GRPC_WEB_METHODS.frozen?
    assert ERPC::SUI_GRPC_WEB_METHODS.all?(&:frozen?)
    assert_raises(FrozenError) { ERPC::SUI_GRPC_WEB_METHODS.first.replace("/unexpected") }
  end

  def test_codec_and_raw_transport_are_private_implementation_details
    assert_raises(NameError) { ERPC::SuiProto }
    assert_raises(NameError) { ERPC::SuiGrpcWebTransport }
    assert_respond_to ERPC.const_get(:SuiProto, true), :decode_frames
    assert_respond_to ERPC.const_get(:SuiGrpcWebTransport, true).new(
      facts: facts,
      direct_endpoint: ERPC::SuiGrpcWebEndpointConfig.new(base_url: "https://customer.example/sui"),
      adapter: Object.new.tap { |adapter| adapter.define_singleton_method(:request_stream) { |**| } }
    ), :request
  end

  def test_invalid_input_bytes_raise_config_error_before_any_stream_call
    calls = []
    adapter = Object.new
    adapter.define_singleton_method(:request_stream) { |**request| calls << request }
    rpc = ERPC::SuiClient.new(
      transport_class.new(facts: facts, direct_endpoint: ERPC::SuiGrpcWebEndpointConfig.new(base_url: "https://customer.example/sui"), adapter: adapter)
    ).grpc
    malformed = "\xc3\x28".dup.force_encoding(Encoding::UTF_8)
    invalid_values = ["\xff".b, malformed]

    invalid_values.each do |value|
      [
        -> { rpc.get_object(value).send },
        -> { rpc.get_balance(value, "0x2::coin::COIN").send },
        -> { rpc.get_balance("0x2", value).send }
      ].each do |operation|
        error = assert_raises(ERPC::ConfigError, &operation)
        assert_nil error.cause
        refute_match(/UndefinedConversion|invalid byte|\\xff|\\xc3/u, error.message)
      end
    end
    assert_empty calls
  end

  def test_valid_supplementary_unicode_is_encoded_without_replacement
    calls = []
    codec = proto
    adapter = Object.new
    adapter.define_singleton_method(:request_stream) do |**request, &block|
      calls << request
      if request.fetch(:url).end_with?("/GetObject")
        object = codec.encode_string(2, "😀") + codec.encode_u64(3, 0) + codec.encode_string(4, "digest")
        payload = codec.encode_key(1, 2) + codec.encode_varint(object.bytesize) + object
      else
        balance = codec.encode_string(1, "😀") + codec.encode_u64(3, 1) + codec.encode_u64(4, 0) + codec.encode_u64(5, 1)
        payload = codec.encode_key(1, 2) + codec.encode_varint(balance.bytesize) + balance
      end
      trailer = "grpc-status: 0\r\n"
      block.call(200, ["\x00".b, [payload.bytesize].pack("N"), payload, "\x80".b, [trailer.bytesize].pack("N"), trailer], { "content-type" => ["application/grpc-web+proto"] })
    end
    rpc = ERPC::SuiClient.new(
      transport_class.new(facts: facts, direct_endpoint: ERPC::SuiGrpcWebEndpointConfig.new(base_url: "https://customer.example/sui"), adapter: adapter)
    ).grpc

    binary_unicode = "😀".encode(Encoding::UTF_8).b
    rpc.get_object(binary_unicode).send
    rpc.get_balance(binary_unicode, binary_unicode).send
    encoded = "😀".encode(Encoding::UTF_8).b
    assert calls.all? { |request| request.fetch(:body).include?(encoded) }
  end

  def test_repeated_embedded_messages_validate_each_fragment_before_merge
    object_fragment_one = proto.encode_string(2, "0x2") + proto.encode_u64(3, 0)
    object_fragment_two = proto.encode_string(4, "digest")
    valid_object = proto.encode_key(1, 2) + proto.encode_varint(object_fragment_one.bytesize) + object_fragment_one +
                   proto.encode_key(1, 2) + proto.encode_varint(object_fragment_two.bytesize) + object_fragment_two
    responses = [valid_object, ["0a01120a050018002200"].pack("H*"), ["0a091201ff120018002200"].pack("H*")]

    responses.each_with_index do |object_payload, index|
      adapter = Object.new
      adapter.define_singleton_method(:request_stream) do |**_request, &block|
        trailer = "grpc-status: 0\r\n"
        body = "\x00".b + [object_payload.bytesize].pack("N") + object_payload +
               "\x80".b + [trailer.bytesize].pack("N") + trailer
        block.call(200, [body], { "content-type" => ["application/grpc-web+proto"] })
      end
      rpc = ERPC::SuiClient.new(
        transport_class.new(facts: facts, direct_endpoint: ERPC::SuiGrpcWebEndpointConfig.new(base_url: "https://customer.example/sui"), adapter: adapter)
      ).grpc

      if index.zero?
        result = rpc.get_object("x").send
        assert_equal "0x2", result.sui_object_id
        assert_equal 0, result.version
        assert_equal "digest", result.digest
      else
        assert_raises(ERPC::InvalidResponseError) { rpc.get_object("x").send }
      end
    end
  end

  def test_timestamp_fragments_merge_before_final_semantic_validation
    timestamp_seconds = proto.encode_u64(1, 7)
    timestamp_nanos = proto.encode_u64(2, 4)
    service = proto.encode_string(1, "chain") + proto.encode_string(2, "mainnet") +
              proto.encode_u64(3, 1) + proto.encode_u64(4, 2)
    service << proto.encode_key(5, 2) + proto.encode_varint(timestamp_seconds.bytesize) + timestamp_seconds
    service << proto.encode_key(5, 2) + proto.encode_varint(timestamp_nanos.bytesize) + timestamp_nanos
    service << proto.encode_u64(6, 0) + proto.encode_u64(7, 0)

    result = proto.parse_service_info(proto.decode_frames(frame(service)))
    assert_equal 7, result.timestamp_seconds
    assert_equal 4, result.timestamp_nanos
  end

  def test_trailer_controls_and_native_stream_errors_map_safely
    codec = proto
    ["grpc-status: 0\n\r\n", "grpc-status: 0\r\r\n"].each do |trailer|
      adapter = Object.new
      adapter.define_singleton_method(:request_stream) do |**_request, &block|
        object = codec.encode_string(2, "0x2") + codec.encode_u64(3, 0) + codec.encode_string(4, "digest")
        payload = codec.encode_key(1, 2) + codec.encode_varint(object.bytesize) + object
        body = "\x00".b + [payload.bytesize].pack("N") + payload + "\x80".b + [trailer.bytesize].pack("N") + trailer
        block.call(200, [body], { "content-type" => ["application/grpc-web+proto"] })
      end
      rpc = ERPC::SuiClient.new(
        transport_class.new(facts: facts, direct_endpoint: ERPC::SuiGrpcWebEndpointConfig.new(base_url: "https://customer.example/sui"), adapter: adapter)
      ).grpc
      assert_raises(ERPC::InvalidResponseError) { rpc.get_object("x").send }
    end

    adapter = Object.new
    adapter.define_singleton_method(:request_stream) do |**_request, &block|
      chunks = Enumerator.new { |_yielder| raise IOError, "native body failure" }
      block.call(200, chunks, { "content-type" => ["application/grpc-web+proto"] })
    end
    rpc = ERPC::SuiClient.new(
      transport_class.new(facts: facts, direct_endpoint: ERPC::SuiGrpcWebEndpointConfig.new(base_url: "https://customer.example/sui"), adapter: adapter)
    ).grpc
    error = assert_raises(ERPC::TransportError) { rpc.get_object("x").send }
    assert_nil error.cause
  end

  def test_sui_group_depth_and_wire_validation_are_bounded
    object = proto.encode_string(2, "0x2") + proto.encode_u64(3, 0) + proto.encode_string(4, "digest")
    nested_groups = lambda do |count|
      ("\x4b".b * count) + ("\x4c".b * count)
    end
    valid = proto.decode_frames(frame(proto.encode_key(1, 2) + proto.encode_varint((object + nested_groups.call(99)).bytesize) + object + nested_groups.call(99)))
    proto.parse_object_response(valid)
    [100].each do |count|
      payload = object + nested_groups.call(count)
      assert_raises(ERPC::InvalidResponseError) do
        proto.parse_object_response(proto.decode_frames(frame(proto.encode_key(1, 2) + proto.encode_varint(payload.bytesize) + payload)))
      end
    end

    wrong_varint = "\x08\x00".b + proto.encode_u64(3, 0) + proto.encode_string(4, "digest")
    wrong_fixed = "\x09".b + ("\x00".b * 8) + proto.encode_u64(3, 0) + proto.encode_string(4, "digest")
    [wrong_varint, wrong_fixed].each do |bad_object|
      payload = proto.encode_key(1, 2) + proto.encode_varint(bad_object.bytesize) + bad_object
      assert_raises(ERPC::InvalidResponseError) { proto.parse_object_response(proto.decode_frames(frame(payload))) }
    end

    illegal_key = proto.encode_varint((536_870_912 << 3) | 0) + "\x00".b
    payload = proto.encode_key(1, 2) + proto.encode_varint(object.bytesize + illegal_key.bytesize) + object + illegal_key
    assert_raises(ERPC::InvalidResponseError) { proto.parse_object_response(proto.decode_frames(frame(payload))) }
  end
end
