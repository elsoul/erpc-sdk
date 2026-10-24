package erpc

import "testing"

func TestSoneiumSealedReads(t *testing.T) {
	testLaterEVM(t, "soneium", func(transport *c1HTTPTransport, facts c1EVMFacts) sealedEVMTestClient {
		return newSoneiumClient(transport, facts).RPC
	})
}
