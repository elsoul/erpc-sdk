package erpc

import "testing"

func TestRobinhoodSealedReads(t *testing.T) {
	testLaterEVM(t, "robinhood", func(transport *c1HTTPTransport, facts c1EVMFacts) sealedEVMTestClient {
		return newRobinhoodClient(transport, facts).RPC
	})
}
