package erpc

import "testing"

func TestTronSealedReads(t *testing.T) {
	testLaterEVM(t, "tron", func(transport *c1HTTPTransport, facts c1EVMFacts) sealedEVMTestClient {
		return newTronClient(transport, facts).RPC
	})
}
