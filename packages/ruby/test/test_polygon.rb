# frozen_string_literal: true

require_relative "test_helper"

class PolygonTest < Minitest::Test
  include SealedChainTestSupport

  def test_sealed_polygon_reads
    exercise_sealed_chain(contract_id: "client-polygon-rpc", client_class: ERPC::PolygonClient, rpc_client_name: "polygon")
  end
end
