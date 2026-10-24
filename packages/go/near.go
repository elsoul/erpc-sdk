package erpc

import (
	"context"
	"encoding/json"
	"strconv"
)

type NearFinality string

const (
	NearFinal      NearFinality = "final"
	NearOptimistic NearFinality = "optimistic"
)

type NearBlockID struct {
	Height *uint64
	Hash   *string
}

type NearBlockReference struct {
	Finality *NearFinality
	BlockID  *NearBlockID
}

type NearStatus struct {
	ChainID               string
	GenesisHash           string
	LatestProtocolVersion uint64
	ProtocolVersion       uint64
	SyncInfo              NearSyncInfo
	Version               NearNodeVersion
	Additional            map[string]any
}

type NearSyncInfo struct {
	LatestBlockHash   string
	LatestBlockHeight uint64
	LatestBlockTime   string
	LatestStateRoot   string
	Syncing           bool
	Additional        map[string]any
}

type NearNodeVersion struct {
	Version      string
	Build        string
	RustcVersion *string
	Additional   map[string]any
}

type NearBlockView struct {
	Author     string
	Header     NearBlockHeader
	Chunks     []any
	Additional map[string]any
}

type NearBlockHeader struct {
	Hash             string
	Height           uint64
	PrevHash         string
	Timestamp        uint64
	TimestampNanosec string
	GasPrice         string
	TotalSupply      string
	Additional       map[string]any
}

type NearAccountView struct {
	Amount                  string
	Locked                  string
	CodeHash                string
	StorageUsage            uint64
	StoragePaidAt           *uint64
	BlockHeight             uint64
	BlockHash               string
	State                   *string
	BootstrapNonce          *uint64
	GlobalContractAccountID *string
	GlobalContractHash      *string
	Additional              map[string]any
}

type NearClient struct{ RPC *NearRPCClient }
type NearRPCClient struct {
	transport *c1HTTPTransport
	facts     c1EVMFacts
}

func newNearClient(transport *c1HTTPTransport, facts c1EVMFacts) *NearClient {
	return &NearClient{RPC: &NearRPCClient{transport: transport, facts: facts}}
}
func (client *NearRPCClient) Endpoint() string { return c1EVMEndpoint(client.transport) }

func (client *NearRPCClient) call(ctx context.Context, name string, params ...any) (any, error) {
	method, err := client.facts.wire(name)
	if err != nil {
		return nil, err
	}
	return client.transport.requestJSON(ctx, method, params)
}

func (client *NearRPCClient) callNamed(ctx context.Context, name string, params map[string]any) (any, error) {
	method, err := client.facts.wire(name)
	if err != nil {
		return nil, err
	}
	return client.transport.requestNamedJSON(ctx, method, params)
}

func (client *NearRPCClient) Status(ctx context.Context) (NearStatus, error) {
	value, err := client.call(ctx, "Status")
	if err != nil {
		return NearStatus{}, err
	}
	return decodeNearStatus(value)
}

func (client *NearRPCClient) Block(ctx context.Context, reference NearBlockReference) (NearBlockView, error) {
	selector, err := nearReferenceValue(reference)
	if err != nil {
		return NearBlockView{}, err
	}
	value, err := client.callNamed(ctx, "Block", selector)
	if err != nil {
		return NearBlockView{}, err
	}
	return decodeNearBlockView(value)
}

func (client *NearRPCClient) ViewAccount(ctx context.Context, accountID string, reference NearBlockReference) (NearAccountView, error) {
	selector, err := nearReferenceValue(reference)
	if err != nil {
		return NearAccountView{}, err
	}
	params := map[string]any{"request_type": "view_account", "account_id": accountID}
	for key, item := range selector {
		params[key] = item
	}
	value, err := client.callNamed(ctx, "ViewAccount", params)
	if err != nil {
		return NearAccountView{}, err
	}
	return decodeNearAccountView(value)
}

func nearReferenceValue(reference NearBlockReference) (map[string]any, error) {
	if (reference.Finality == nil) == (reference.BlockID == nil) {
		return nil, sdkError(ErrorConfig, "invalid NEAR block reference")
	}
	if reference.Finality != nil {
		if *reference.Finality != NearFinal && *reference.Finality != NearOptimistic {
			return nil, sdkError(ErrorConfig, "invalid NEAR block reference")
		}
		return map[string]any{"finality": string(*reference.Finality)}, nil
	}
	if reference.BlockID.Height != nil && reference.BlockID.Hash != nil || reference.BlockID.Height == nil && reference.BlockID.Hash == nil {
		return nil, sdkError(ErrorConfig, "invalid NEAR block reference")
	}
	if reference.BlockID.Height != nil {
		return map[string]any{"block_id": *reference.BlockID.Height}, nil
	}
	return map[string]any{"block_id": *reference.BlockID.Hash}, nil
}

func nearMap(value any) (map[string]any, error) {
	result, ok := value.(map[string]any)
	if !ok {
		return nil, bitcoinInvalidResponse()
	}
	return result, nil
}

func nearString(value map[string]any, key string) (string, error) {
	result, ok := value[key].(string)
	if !ok {
		return "", bitcoinInvalidResponse()
	}
	return result, nil
}

func nearUint64(value map[string]any, key string) (uint64, error) {
	return asBitcoinBlockCount(value[key])
}

func nearBool(value map[string]any, key string) (bool, error) {
	result, ok := value[key].(bool)
	if !ok {
		return false, bitcoinInvalidResponse()
	}
	return result, nil
}

func nearOptionalString(value map[string]any, key string) (*string, error) {
	item, ok := value[key]
	if !ok || item == nil {
		return nil, nil
	}
	result, ok := item.(string)
	if !ok {
		return nil, bitcoinInvalidResponse()
	}
	return &result, nil
}

func nearOptionalUint64(value map[string]any, key string) (*uint64, error) {
	item, ok := value[key]
	if !ok || item == nil {
		return nil, nil
	}
	result, ok := item.(json.Number)
	if !ok || !bitcoinUnsignedIntegerToken(result.String()) {
		return nil, bitcoinInvalidResponse()
	}
	parsed, err := parseNearUint64(result)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

func parseNearUint64(value json.Number) (uint64, error) {
	parsed, err := strconv.ParseUint(value.String(), 10, 64)
	if err != nil {
		return 0, bitcoinInvalidResponse()
	}
	return parsed, nil
}

func nearAdditional(value map[string]any, known ...string) map[string]any {
	set := make(map[string]struct{}, len(known))
	for _, key := range known {
		set[key] = struct{}{}
	}
	result := make(map[string]any)
	for key, item := range value {
		if _, ok := set[key]; !ok {
			result[key] = item
		}
	}
	return result
}

func decodeNearStatus(value any) (NearStatus, error) {
	root, err := nearMap(value)
	if err != nil {
		return NearStatus{}, err
	}
	syncValue, err := nearMap(root["sync_info"])
	if err != nil {
		return NearStatus{}, err
	}
	versionValue, err := nearMap(root["version"])
	if err != nil {
		return NearStatus{}, err
	}
	latestProtocol, err := nearUint64(root, "latest_protocol_version")
	if err != nil {
		return NearStatus{}, err
	}
	protocol, err := nearUint64(root, "protocol_version")
	if err != nil {
		return NearStatus{}, err
	}
	latestHeight, err := nearUint64(syncValue, "latest_block_height")
	if err != nil {
		return NearStatus{}, err
	}
	syncing, err := nearBool(syncValue, "syncing")
	if err != nil {
		return NearStatus{}, err
	}
	version, err := nearString(versionValue, "version")
	if err != nil {
		return NearStatus{}, err
	}
	build, err := nearString(versionValue, "build")
	if err != nil {
		return NearStatus{}, err
	}
	rustc, err := nearOptionalString(versionValue, "rustc_version")
	if err != nil {
		return NearStatus{}, err
	}
	latestHash, err := nearString(syncValue, "latest_block_hash")
	if err != nil {
		return NearStatus{}, err
	}
	latestTime, err := nearString(syncValue, "latest_block_time")
	if err != nil {
		return NearStatus{}, err
	}
	stateRoot, err := nearString(syncValue, "latest_state_root")
	if err != nil {
		return NearStatus{}, err
	}
	chain, err := nearString(root, "chain_id")
	if err != nil {
		return NearStatus{}, err
	}
	genesis, err := nearString(root, "genesis_hash")
	if err != nil {
		return NearStatus{}, err
	}
	return NearStatus{ChainID: chain, GenesisHash: genesis, LatestProtocolVersion: latestProtocol, ProtocolVersion: protocol,
		SyncInfo: NearSyncInfo{LatestBlockHash: latestHash, LatestBlockHeight: latestHeight, LatestBlockTime: latestTime, LatestStateRoot: stateRoot, Syncing: syncing,
			Additional: nearAdditional(syncValue, "latest_block_hash", "latest_block_height", "latest_block_time", "latest_state_root", "syncing")},
		Version:    NearNodeVersion{Version: version, Build: build, RustcVersion: rustc, Additional: nearAdditional(versionValue, "version", "build", "rustc_version")},
		Additional: nearAdditional(root, "chain_id", "genesis_hash", "latest_protocol_version", "protocol_version", "sync_info", "version")}, nil
}

func decodeNearBlockView(value any) (NearBlockView, error) {
	root, err := nearMap(value)
	if err != nil {
		return NearBlockView{}, err
	}
	header, err := nearMap(root["header"])
	if err != nil {
		return NearBlockView{}, err
	}
	author, err := nearString(root, "author")
	if err != nil {
		return NearBlockView{}, err
	}
	hash, err := nearString(header, "hash")
	if err != nil {
		return NearBlockView{}, err
	}
	height, err := nearUint64(header, "height")
	if err != nil {
		return NearBlockView{}, err
	}
	prev, err := nearString(header, "prev_hash")
	if err != nil {
		return NearBlockView{}, err
	}
	timestamp, err := nearUint64(header, "timestamp")
	if err != nil {
		return NearBlockView{}, err
	}
	timestampNano, err := nearString(header, "timestamp_nanosec")
	if err != nil {
		return NearBlockView{}, err
	}
	gas, err := nearString(header, "gas_price")
	if err != nil {
		return NearBlockView{}, err
	}
	supply, err := nearString(header, "total_supply")
	if err != nil {
		return NearBlockView{}, err
	}
	chunks, ok := root["chunks"].([]any)
	if !ok {
		return NearBlockView{}, bitcoinInvalidResponse()
	}
	return NearBlockView{Author: author, Header: NearBlockHeader{Hash: hash, Height: height, PrevHash: prev, Timestamp: timestamp, TimestampNanosec: timestampNano, GasPrice: gas, TotalSupply: supply,
		Additional: nearAdditional(header, "hash", "height", "prev_hash", "timestamp", "timestamp_nanosec", "gas_price", "total_supply")}, Chunks: chunks,
		Additional: nearAdditional(root, "author", "header", "chunks")}, nil
}

func decodeNearAccountView(value any) (NearAccountView, error) {
	root, err := nearMap(value)
	if err != nil {
		return NearAccountView{}, err
	}
	amount, err := nearString(root, "amount")
	if err != nil {
		return NearAccountView{}, err
	}
	locked, err := nearString(root, "locked")
	if err != nil {
		return NearAccountView{}, err
	}
	code, err := nearString(root, "code_hash")
	if err != nil {
		return NearAccountView{}, err
	}
	usage, err := nearUint64(root, "storage_usage")
	if err != nil {
		return NearAccountView{}, err
	}
	paid, err := nearOptionalUint64(root, "storage_paid_at")
	if err != nil {
		return NearAccountView{}, err
	}
	height, err := nearUint64(root, "block_height")
	if err != nil {
		return NearAccountView{}, err
	}
	hash, err := nearString(root, "block_hash")
	if err != nil {
		return NearAccountView{}, err
	}
	state, err := nearOptionalString(root, "state")
	if err != nil {
		return NearAccountView{}, err
	}
	nonce, err := nearOptionalUint64(root, "bootstrap_nonce")
	if err != nil {
		return NearAccountView{}, err
	}
	contractID, err := nearOptionalString(root, "global_contract_account_id")
	if err != nil {
		return NearAccountView{}, err
	}
	contractHash, err := nearOptionalString(root, "global_contract_hash")
	if err != nil {
		return NearAccountView{}, err
	}
	return NearAccountView{Amount: amount, Locked: locked, CodeHash: code, StorageUsage: usage, StoragePaidAt: paid, BlockHeight: height, BlockHash: hash, State: state, BootstrapNonce: nonce, GlobalContractAccountID: contractID, GlobalContractHash: contractHash,
		Additional: nearAdditional(root, "amount", "locked", "code_hash", "storage_usage", "storage_paid_at", "block_height", "block_hash", "state", "bootstrap_nonce", "global_contract_account_id", "global_contract_hash")}, nil
}
