# frozen_string_literal: true

require_relative "test_helper"

class OptimismTest < Minitest::Test
  include SealedChainTestSupport

  def test_sealed_optimism_reads
    exercise_sealed_chain(contract_id: "client-optimism-rpc", client_class: ERPC::OptimismClient, rpc_client_name: "optimism")
  end
end
