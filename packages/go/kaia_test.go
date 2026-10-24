package erpc

import "testing"

func TestKaiaSealedReads(t *testing.T) {
	testLaterEVM(t, "kaia", func(transport *c1HTTPTransport, facts c1EVMFacts) sealedEVMTestClient {
		return newKaiaClient(transport, facts).RPC
	})
}
