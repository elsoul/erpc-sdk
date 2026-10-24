package erpc

import (
	"context"
	"unicode/utf8"
)

type SuiClient struct{ GRPC *SuiGRPCWebClient }

type SuiGRPCWebClient struct{ transport *suiGRPCWebTransport }

func newSuiClient(transport *suiGRPCWebTransport) *SuiClient {
	return &SuiClient{GRPC: &SuiGRPCWebClient{transport: transport}}
}

func (client *SuiGRPCWebClient) Endpoint() string {
	if client == nil || client.transport == nil {
		return ""
	}
	return client.transport.publicEndpoint
}

func (client *SuiGRPCWebClient) GetServiceInfo(ctx context.Context) (SuiServiceInfo, error) {
	frame, err := encodeSuiRequest("GetServiceInfo", "", nil, "", "")
	if err != nil {
		return SuiServiceInfo{}, err
	}
	payload, err := client.transport.request(ctx, "GetServiceInfo", frame)
	if err != nil {
		return SuiServiceInfo{}, err
	}
	value := suiServiceInfo{}
	if err := decodeSuiServiceInfo(payload, &value, 0); err != nil {
		return SuiServiceInfo{}, err
	}
	return SuiServiceInfo{ChainID: value.chainID, Chain: value.chain, Epoch: value.epoch, CheckpointHeight: value.checkpoint,
		TimestampSeconds: value.timestamp.seconds, TimestampNanos: value.timestamp.nanos, LowestAvailableCheckpoint: value.lowest,
		LowestAvailableCheckpointObjects: value.lowestObjects, Server: value.server}, nil
}

func (client *SuiGRPCWebClient) GetObject(ctx context.Context, objectID string, version *uint64) (SuiObjectSummary, error) {
	if err := validateSuiInput(objectID); err != nil {
		return SuiObjectSummary{}, err
	}
	frame, err := encodeSuiRequest("GetObject", objectID, version, "", "")
	if err != nil {
		return SuiObjectSummary{}, err
	}
	payload, err := client.transport.request(ctx, "GetObject", frame)
	if err != nil {
		return SuiObjectSummary{}, err
	}
	return decodeSuiObjectResponse(payload)
}

func (client *SuiGRPCWebClient) GetBalance(ctx context.Context, owner, coinType string) (SuiBalance, error) {
	if err := validateSuiInput(owner); err != nil {
		return SuiBalance{}, err
	}
	if err := validateSuiInput(coinType); err != nil {
		return SuiBalance{}, err
	}
	frame, err := encodeSuiRequest("GetBalance", "", nil, owner, coinType)
	if err != nil {
		return SuiBalance{}, err
	}
	payload, err := client.transport.request(ctx, "GetBalance", frame)
	if err != nil {
		return SuiBalance{}, err
	}
	return decodeSuiBalanceResponse(payload)
}

func validateSuiInput(value string) error {
	if value == "" {
		return sdkError(ErrorConfig, "Sui request input must not be empty")
	}
	if !utf8.ValidString(value) {
		return sdkError(ErrorConfig, "Sui request input is not valid UTF-8")
	}
	for _, char := range value {
		if char < 0x20 || char == 0x7f {
			return sdkError(ErrorConfig, "Sui request input contains a control character")
		}
	}
	return nil
}
