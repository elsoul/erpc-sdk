# frozen_string_literal: true

require_relative "test_helper"

class MonadTest < Minitest::Test
  include SealedChainTestSupport

  def test_sealed_monad_reads
    exercise_sealed_chain(contract_id: "client-monad-rpc", client_class: ERPC::MonadClient, rpc_client_name: "monad")
  end
end
