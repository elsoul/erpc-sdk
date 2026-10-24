# frozen_string_literal: true

require_relative "test_helper"

class BitcoinCodecTest < Minitest::Test
  def codec
    ERPC.const_get(:BitcoinCodec, true)
  end

  def limits
    ERPC.const_get(:BITCOIN_RESPONSE_LIMITS, true)
  end

  def test_local_limits_are_bound_to_generated_bitcoin_response_policy
    contract = ERPC.const_get(:RPC_NETWORK_CONTRACT, true)
    client = contract.fetch("clientContracts").find { |item| item.fetch("clientContractId") == "client-bitcoin-rpc" }
    policy = client.fetch("responsePolicy")
    generated = policy.fetch("limits")

    assert_equal "bitcoin-exact-json-v1", policy.fetch("policyId")
    assert_includes policy.fetch("limitApplicability"), "ruby"
    assert_equal generated.fetch("decodedEntityBytes"), limits.decoded_entity_bytes
    assert_equal generated.fetch("containerDepth"), limits.container_depth
    assert_equal generated.fetch("jsonTokens"), limits.json_tokens
    assert_equal generated.fetch("numericLexemeBytes"), limits.numeric_lexeme_bytes
    assert_equal generated.fetch("coefficientDigits"), limits.coefficient_digits
    assert_equal generated.fetch("explicitExponentMin"), limits.explicit_exponent_min
    assert_equal generated.fetch("explicitExponentMax"), limits.explicit_exponent_max
    assert_equal generated.fetch("canonicalExponentMin"), limits.canonical_exponent_min
    assert_equal generated.fetch("canonicalExponentMax"), limits.canonical_exponent_max
  end

  def test_codec_and_alias_are_private_root_implementation_details
    assert_raises(NameError) { ERPC::BitcoinCodec }
    assert_raises(NameError) { ERPC::BITCOIN_CODEC }
    assert_respond_to codec, :decode
  end

  def test_canonical_tuple_preserves_exact_approved_domain
    cases = {
      "0" => [0, "0", "0"],
      "-0" => [0, "0", "0"],
      "1.2300e+4" => [1, "123", "2"],
      "1e1000" => [1, "1", "1000"],
      "1e-1000" => [1, "1", "-1000"],
      "100000" => [1, "1", "5"]
    }
    cases.each do |token, expected|
      tuple = codec.canonicalize_number(token)
      assert_equal expected, [tuple.sign, tuple.coefficient, tuple.exponent10]
    end
  end

  def test_numeric_limits_and_grammar_fail_without_token_or_native_cause
    [
      "01",
      "1.",
      "1e",
      "1e10001",
      "1e-10001",
      "1#{'0' * limits.coefficient_digits}",
      "1#{'0' * limits.numeric_lexeme_bytes}"
    ].each do |token|
      error = assert_raises(ERPC::InvalidResponseError) do
        codec.canonicalize_number(token)
      end
      assert_nil error.cause
      refute_includes error.message, token
    end
  end

  def test_preflight_is_nonrecursive_and_counts_limits
    depth = limits.container_depth
    %i[array object alternating].each do |shape|
      result = codec.preflight(nested_container_json(shape, depth))
      assert_equal depth, result.max_depth
      assert_equal depth + 1, result.token_count if shape == :array

      assert_raises(ERPC::InvalidResponseError) do
        codec.preflight(nested_container_json(shape, depth + 1))
      end
    end
  end

  def test_duplicate_decoded_keys_are_last_wins_and_numbers_remain_bigdecimal
    response = <<~JSON.delete("\n")
      {"jsonrpc":"2.0","id":1,"result":1.20,
       "\\u0072esult":{"nested":{"x":5.60,"x":7.80},"tiny":1e-1000,"huge":1e1000}}
    JSON
    result = codec.decode(response, 1)
    assert_instance_of BigDecimal, result.fetch("nested").fetch("x")
    assert_equal BigDecimal("7.80"), result.fetch("nested").fetch("x")
    assert_equal BigDecimal("1e-1000"), result.fetch("tiny")
    assert_equal BigDecimal("1e1000"), result.fetch("huge")
  end

  def test_block_count_requires_unsigned_integer_token_and_u64_range
    ["0", "1", "18446744073709551615"].each do |token|
      value = codec.decode(
        %({"jsonrpc":"2.0","id":1,"result":#{token}}),
        1,
        projector: codec.method(:as_block_count)
      )
      assert_equal Integer(token), value
    end

    ["-0", "1.0", "1e0", "18446744073709551616"].each do |token|
      assert_raises(ERPC::InvalidResponseError) do
        codec.decode(
          %({"jsonrpc":"2.0","id":1,"result":#{token}}),
          1,
          projector: codec.method(:as_block_count)
        )
      end
    end
  end

  def test_error_precedence_redacts_credentials_without_rounding_bigdecimals
    response = <<~JSON.delete("\n")
      {"jsonrpc":"2.0","id":1,"result":"ignored",
       "error":{"code":-32001,"message":"token-secret",
       "data":{"token-secret":1e-1000,"nested":["token-secret",1e1000]}}}
    JSON
    error = assert_raises(ERPC::JsonRpcError) do
      codec.decode(response, 1, redactions: ["token-secret"])
    end
    assert_equal(-32001, error.code)
    refute_includes error.message, "token-secret"
    assert_equal BigDecimal("1e-1000"), error.data.fetch("[REDACTED]")
    assert_equal BigDecimal("1e1000"), error.data.fetch("nested").last
  end

  def test_parser_failures_are_safe
    error = assert_raises(ERPC::InvalidResponseError) do
      codec.decode('{"id":1,"result":', 1)
    end
    assert_nil error.cause
    refute_includes error.message, "result"
  end

  private

  def nested_container_json(shape, depth)
    value = "0"
    depth.times do |index|
      value = case shape
              when :array
                "[#{value}]"
              when :object
                %({"value":#{value}})
              when :alternating
                index.even? ? "[#{value}]" : %({"value":#{value}})
              else
                raise ArgumentError, "unknown shape"
              end
    end
    value
  end
end
