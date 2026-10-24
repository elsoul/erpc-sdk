package erpc

import "testing"

func TestHyperliquidSealedReads(t *testing.T) {
	testLaterEVM(t, "hyperliquid", func(transport *c1HTTPTransport, facts c1EVMFacts) sealedEVMTestClient {
		return newHyperliquidClient(transport, facts).RPC
	})
}
