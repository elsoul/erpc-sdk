package erpc

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/url"
	"strconv"
	"strings"
	"sync"
)

type PriceFeedMetadata struct {
	Attributes map[string]string `json:"attributes,omitempty"`
	ID         string            `json:"id"`
}

type PricePoint struct {
	Conf        string `json:"conf"`
	Expo        int32  `json:"expo"`
	Price       string `json:"price"`
	PublishTime int64  `json:"publish_time"`
}

type ParsedPriceUpdate struct {
	EMAPrice PricePoint       `json:"ema_price"`
	ID       string           `json:"id"`
	Metadata *json.RawMessage `json:"metadata,omitempty"`
	Price    PricePoint       `json:"price"`
}

type BinaryUpdate struct {
	Data     []string `json:"data"`
	Encoding string   `json:"encoding"`
}

type PriceUpdateResponse struct {
	Binary BinaryUpdate        `json:"binary"`
	Parsed []ParsedPriceUpdate `json:"parsed,omitempty"`
}

type PriceUpdateOptions struct {
	Encoding              string
	IDs                   []string
	IgnoreInvalidPriceIDs *bool
	Parsed                *bool
}

type PriceStreamOptions struct {
	PriceUpdateOptions
	AllowUnordered *bool
	BenchmarksOnly *bool
}

type PriceStreamEvent struct {
	Data  PriceUpdateResponse
	Event string
	ID    string
}

type PriceClient struct{ transport *restTransport }

func (c *PriceClient) GetPriceFeeds(ctx context.Context, queryText, assetType string) ([]PriceFeedMetadata, error) {
	query := url.Values{}
	if queryText != "" {
		query.Set("query", queryText)
	}
	if assetType != "" {
		query.Set("asset_type", assetType)
	}
	var result []PriceFeedMetadata
	err := c.transport.getJSON(ctx, "/v2/price_feeds", query, &result)
	return result, err
}

func (c *PriceClient) GetLatestPriceUpdates(ctx context.Context, options PriceUpdateOptions) (PriceUpdateResponse, error) {
	var result PriceUpdateResponse
	err := c.transport.getJSON(ctx, "/v2/updates/price/latest", priceQuery(options), &result)
	return result, err
}

func (c *PriceClient) GetPriceUpdatesAtTimestamp(ctx context.Context, publishTime int64, options PriceUpdateOptions) (PriceUpdateResponse, error) {
	var result PriceUpdateResponse
	path := "/v2/updates/price/" + strconv.FormatInt(publishTime, 10)
	err := c.transport.getJSON(ctx, path, priceQuery(options), &result)
	return result, err
}

func priceQuery(options PriceUpdateOptions) url.Values {
	query := url.Values{}
	for _, id := range options.IDs {
		query.Add("ids[]", id)
	}
	if options.Encoding != "" {
		query.Set("encoding", options.Encoding)
	}
	if options.Parsed != nil {
		query.Set("parsed", boolString(*options.Parsed))
	}
	if options.IgnoreInvalidPriceIDs != nil {
		query.Set("ignore_invalid_price_ids", boolString(*options.IgnoreInvalidPriceIDs))
	}
	return query
}

// PriceStream is a streaming SSE response. Call Close when abandoning it.
type PriceStream struct {
	body    io.ReadCloser
	scanner *bufio.Scanner
	mu      sync.Mutex
}

func (c *PriceClient) StreamPriceUpdates(ctx context.Context, options PriceStreamOptions) (*PriceStream, error) {
	query := priceQuery(options.PriceUpdateOptions)
	if options.AllowUnordered != nil {
		query.Set("allow_unordered", boolString(*options.AllowUnordered))
	}
	if options.BenchmarksOnly != nil {
		query.Set("benchmarks_only", boolString(*options.BenchmarksOnly))
	}
	response, err := c.transport.get(ctx, "/v2/updates/price/stream", query, "text/event-stream")
	if err != nil {
		return nil, err
	}
	return &PriceStream{body: response.Body, scanner: bufio.NewScanner(response.Body)}, nil
}

// Next blocks until the next data-bearing SSE event.
func (s *PriceStream) Next() (PriceStreamEvent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var data []string
	var event PriceStreamEvent
	for s.scanner.Scan() {
		line := strings.TrimSuffix(s.scanner.Text(), "\r")
		if line == "" {
			if len(data) == 0 {
				continue
			}
			if err := json.Unmarshal([]byte(strings.Join(data, "\n")), &event.Data); err != nil {
				return PriceStreamEvent{}, sdkError(ErrorInvalidResponse, "ERPC returned malformed stream data")
			}
			return event, nil
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, found := strings.Cut(line, ":")
		if !found {
			value = ""
		}
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "data":
			data = append(data, value)
		case "event":
			event.Event = value
		case "id":
			event.ID = value
		}
	}
	if err := s.scanner.Err(); err != nil {
		return PriceStreamEvent{}, sdkError(ErrorTransport, "unable to read ERPC stream")
	}
	return PriceStreamEvent{}, io.EOF
}

func (s *PriceStream) Close() error { return s.body.Close() }
