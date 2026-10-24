package erpc

import "testing"

func TestMonadSealedReads(t *testing.T) {
	testLaterEVM(t, "monad", func(transport *c1HTTPTransport, facts c1EVMFacts) sealedEVMTestClient {
		return newMonadClient(transport, facts).RPC
	})
}
