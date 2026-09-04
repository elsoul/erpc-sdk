# frozen_string_literal: true

require "erpc_sdk"

begin
  erpc = ERPC::Client.new(
    ERPC::ClientConfig.new(api_key: ENV.fetch("ERPC_API_KEY"))
  )

  slot = erpc.solana.rpc.get_slot.send
  chain_id = erpc.ethereum.rpc.eth_chain_id.send
  avalanche_chain_id = erpc.avalanche.rpc.eth_chain_id.send
  puts({ slot: slot, chain_id: chain_id, avalanche_chain_id: avalanche_chain_id })
ensure
  erpc&.close
end
