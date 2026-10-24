package erpc

import "testing"

func TestArcSealedReads(t *testing.T) {
	testLaterEVM(t, "arc", func(transport *c1HTTPTransport, facts c1EVMFacts) sealedEVMTestClient {
		return newArcClient(transport, facts).RPC
	})
}
