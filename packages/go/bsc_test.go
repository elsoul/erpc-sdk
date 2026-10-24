package erpc

import "testing"

func TestBscSealedReads(t *testing.T) {
	testLaterEVM(t, "bsc", func(transport *c1HTTPTransport, facts c1EVMFacts) sealedEVMTestClient {
		return newBscClient(transport, facts).RPC
	})
}
