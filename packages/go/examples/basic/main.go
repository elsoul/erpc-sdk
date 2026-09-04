package main

import (
	"context"
	"fmt"
	"os"

	erpc "github.com/elsoul/erpc-sdk/packages/go"
)

func main() {
	apiKey := os.Getenv("ERPC_API_KEY")
	if apiKey == "" {
		panic("ERPC_API_KEY is required")
	}
	client, err := erpc.NewClient(erpc.Config{APIKey: apiKey})
	if err != nil {
		panic(err)
	}
	defer client.Close()

	slot, err := client.Solana.RPC.GetSlot(context.Background())
	if err != nil {
		panic(err)
	}
	avalancheChainID, err := client.Avalanche.RPC.ChainID(context.Background())
	if err != nil {
		panic(err)
	}
	fmt.Println(slot, avalancheChainID)
}
