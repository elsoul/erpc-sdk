# frozen_string_literal: true

require_relative "test_helper"

class BscTest < Minitest::Test
  include SealedChainTestSupport

  def test_sealed_bsc_reads
    exercise_sealed_chain(contract_id: "client-bsc-rpc", client_class: ERPC::BscClient, rpc_client_name: "bsc")
  end
end
