package erpc

import "testing"

func TestOptimismSealedReads(t *testing.T) {
	testLaterEVM(t, "optimism", func(transport *c1HTTPTransport, facts c1EVMFacts) sealedEVMTestClient {
		return newOptimismClient(transport, facts).RPC
	})
}
