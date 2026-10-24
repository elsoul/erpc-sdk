# frozen_string_literal: true

require_relative "test_helper"

class TronTest < Minitest::Test
  include SealedChainTestSupport

  def test_sealed_tron_keeps_provider_root_without_suffix
    exercise_sealed_chain(contract_id: "client-tron-rpc", client_class: ERPC::TronClient, rpc_client_name: "tron")
  end
end
