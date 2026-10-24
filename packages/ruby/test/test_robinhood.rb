# frozen_string_literal: true

require_relative "test_helper"

class RobinhoodTest < Minitest::Test
  include SealedChainTestSupport

  def test_sealed_robinhood_public_chain_reads
    exercise_sealed_chain(contract_id: "client-robinhood-rpc", client_class: ERPC::RobinhoodClient, rpc_client_name: "robinhood")
  end
end
