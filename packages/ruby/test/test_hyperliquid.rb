# frozen_string_literal: true

require_relative "test_helper"

class HyperliquidTest < Minitest::Test
  include SealedChainTestSupport

  def test_sealed_hyperliquid_reads
    exercise_sealed_chain(contract_id: "client-hyperliquid-rpc", client_class: ERPC::HyperliquidClient, rpc_client_name: "hyperliquid")
  end
end
