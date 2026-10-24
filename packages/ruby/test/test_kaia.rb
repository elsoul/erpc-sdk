# frozen_string_literal: true

require_relative "test_helper"

class KaiaTest < Minitest::Test
  include SealedChainTestSupport

  def test_sealed_kaia_reads
    exercise_sealed_chain(contract_id: "client-kaia-rpc", client_class: ERPC::KaiaClient, rpc_client_name: "kaia")
  end
end
