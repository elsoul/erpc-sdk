# frozen_string_literal: true

require_relative "test_helper"

class ArcTest < Minitest::Test
  include SealedChainTestSupport

  def test_sealed_arc_reads_preserve_raw_units
    exercise_sealed_chain(contract_id: "client-arc-rpc", client_class: ERPC::ArcClient, rpc_client_name: "arc")
  end
end
