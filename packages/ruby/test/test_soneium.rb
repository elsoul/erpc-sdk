# frozen_string_literal: true

require_relative "test_helper"

class SoneiumTest < Minitest::Test
  include SealedChainTestSupport

  def test_sealed_soneium_reads
    exercise_sealed_chain(contract_id: "client-soneium-rpc", client_class: ERPC::SoneiumClient, rpc_client_name: "soneium")
  end
end
