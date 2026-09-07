package erpc

import (
	"context"
	"encoding/json"
	"strings"
)

// AvalancheRPCNamespace provides catalog-validated access to one native API.
// Public method names omit the wire prefix; Raw accepts an exact wire name.
type AvalancheRPCNamespace struct {
	*RPCNamespace
	methodPrefix string
	methods      map[string]struct{}
}

func newAvalancheRPCNamespace(
	transport *httpRPCTransport,
	methodPrefix string,
	methods []string,
) *AvalancheRPCNamespace {
	available := make(map[string]struct{}, len(methods))
	prefix := methodPrefix + "."
	for _, method := range methods {
		available[strings.TrimPrefix(method, prefix)] = struct{}{}
	}
	return &AvalancheRPCNamespace{
		RPCNamespace: &RPCNamespace{transport: transport, policy: batchUnsupported},
		methodPrefix: methodPrefix,
		methods:      available,
	}
}

// Request executes a catalog method after restoring its wire prefix.
func (n *AvalancheRPCNamespace) Request(ctx context.Context, method string, params any, result any) error {
	if _, ok := n.methods[method]; !ok {
		return sdkError(ErrorConfig, "method is not in this namespace; use Raw for forward-compatible methods")
	}
	return n.transport.request(ctx, n.methodPrefix+"."+method, params, result)
}

// Raw executes an exact, forward-compatible wire method.
func (n *AvalancheRPCNamespace) Raw(ctx context.Context, method string, params any, result any) error {
	return n.transport.request(ctx, method, params, result)
}

// Batch rejects native API batches locally. Only C-Chain EVM calls support batching.
func (n *AvalancheRPCNamespace) Batch(ctx context.Context, calls []BatchCall) ([]json.RawMessage, error) {
	if len(calls) != 0 {
		return nil, sdkError(ErrorBatchPolicy, "Avalanche native RPC methods do not support batching")
	}
	return n.transport.batch(ctx, calls)
}

// AvalancheIndexClient exposes each explicit chain/container Index API route.
type AvalancheIndexClient struct {
	CChainBlocks       *AvalancheRPCNamespace
	PChainBlocks       *AvalancheRPCNamespace
	XChainBlocks       *AvalancheRPCNamespace
	XChainTransactions *AvalancheRPCNamespace
}

// AvalancheClient groups C-Chain EVM, native-chain, Index, and subscription APIs.
type AvalancheClient struct {
	RPC           *EthereumRPCClient
	AVAX          *AvalancheRPCNamespace
	XChain        *AvalancheRPCNamespace
	PChain        *AvalancheRPCNamespace
	ProposerVM    *AvalancheRPCNamespace
	Info          *AvalancheRPCNamespace
	Index         *AvalancheIndexClient
	Subscriptions *EthereumSubscriptions
}

func newAvalancheClient(
	transport *httpRPCTransport,
	ws *webSocketTransport,
	index *AvalancheIndexClient,
) *AvalancheClient {
	return &AvalancheClient{
		RPC:           &EthereumRPCClient{RPCNamespace: &RPCNamespace{transport: transport, policy: batchAny}},
		AVAX:          newAvalancheRPCNamespace(transport, "avax", AvalancheAVAXMethods),
		XChain:        newAvalancheRPCNamespace(transport, "avm", AvalancheXChainMethods),
		PChain:        newAvalancheRPCNamespace(transport, "platform", AvalanchePChainMethods),
		ProposerVM:    newAvalancheRPCNamespace(transport, "proposervm", AvalancheProposerVMMethods),
		Info:          newAvalancheRPCNamespace(transport, "info", AvalancheInfoMethods),
		Index:         index,
		Subscriptions: &EthereumSubscriptions{transport: ws},
	}
}
