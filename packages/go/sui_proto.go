package erpc

// SPDX-License-Identifier: Apache-2.0 AND BSD-3-Clause
// Copyright (c) Mysten Labs, Inc.
//
// This file is a modified, handwritten, dependency-free bounded projection
// of the pinned MystenLabs Sui API schema at commit
// aa9ba2c13b2a9348059b38110e64af39849a0377. It retains only the nine message
// shapes required by the three read-only gRPC-Web methods.
// Pinned upstream schema paths:
// - proto/sui/rpc/v2/ledger_service.proto
// - proto/sui/rpc/v2/state_service.proto
// - proto/sui/rpc/v2/object.proto
// - proto/google/protobuf/timestamp.proto
// The component terms are also recorded in THIRD_PARTY_NOTICES.md.

import (
	"encoding/binary"
	"math"
	"unicode/utf8"
)

const (
	suiMaxRequestBytes  = 1_048_576
	suiMaxResponseBytes = 8_388_608
	suiMaxTrailerBytes  = 8_192
	suiMaxProtoDepth    = 100
)

type SuiServiceInfo struct {
	ChainID                          string
	Chain                            string
	Epoch                            uint64
	CheckpointHeight                 uint64
	TimestampSeconds                 int64
	TimestampNanos                   int32
	LowestAvailableCheckpoint        uint64
	LowestAvailableCheckpointObjects uint64
	Server                           *string
}

type SuiObjectSummary struct {
	ObjectID string
	Version  uint64
	Digest   string
}

type SuiBalance struct {
	CoinType       string
	Balance        uint64
	AddressBalance uint64
	CoinBalance    uint64
}

/*
 * Google Timestamp source-license header (retained in full for the adapted projection):
 * Protocol Buffers - Google's data interchange format
 * Copyright 2008 Google Inc.  All rights reserved.
 * https://developers.google.com/protocol-buffers/
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
type suiTimestamp struct {
	seconds    int64
	secondsSet bool
	nanos      int32
	nanosSet   bool
}

type suiServiceInfo struct {
	chainID          string
	chainIDSet       bool
	chain            string
	epoch            uint64
	epochSet         bool
	checkpoint       uint64
	checkpointSet    bool
	timestamp        suiTimestamp
	timestampSet     bool
	lowest           uint64
	lowestSet        bool
	lowestObjects    uint64
	lowestObjectsSet bool
	server           *string
	serverSet        bool
}

type suiObject struct {
	objectID    string
	objectIDSet bool
	version     uint64
	versionSet  bool
	digest      string
	digestSet   bool
}

type suiBalance struct {
	coinType          string
	coinTypeSet       bool
	balance           uint64
	balanceSet        bool
	addressBalance    uint64
	addressBalanceSet bool
	coinBalance       uint64
	coinBalanceSet    bool
}

type suiReader struct {
	data   []byte
	offset int
}

func (reader *suiReader) remaining() int { return len(reader.data) - reader.offset }

func (reader *suiReader) varint() (uint64, error) {
	var value uint64
	for index := 0; index < 10; index++ {
		if reader.offset >= len(reader.data) {
			return 0, bitcoinInvalidResponse()
		}
		byteValue := reader.data[reader.offset]
		reader.offset++
		if index == 9 && byteValue > 1 {
			return 0, bitcoinInvalidResponse()
		}
		value |= uint64(byteValue&0x7f) << (7 * index)
		if byteValue&0x80 == 0 {
			return value, nil
		}
	}
	return 0, bitcoinInvalidResponse()
}

func (reader *suiReader) key() (int, int, error) {
	value, err := reader.varint()
	if err != nil {
		return 0, 0, err
	}
	fieldValue := value >> 3
	wire := int(value & 7)
	if fieldValue == 0 || fieldValue > (1<<29)-1 || wire > 5 {
		return 0, 0, bitcoinInvalidResponse()
	}
	return int(fieldValue), wire, nil
}

func (reader *suiReader) bytesValue() ([]byte, error) {
	length, err := reader.varint()
	if err != nil {
		return nil, err
	}
	if length > uint64(reader.remaining()) || length > uint64(math.MaxInt) {
		return nil, bitcoinInvalidResponse()
	}
	start := reader.offset
	reader.offset += int(length)
	return reader.data[start:reader.offset], nil
}

func (reader *suiReader) stringValue() (string, error) {
	value, err := reader.bytesValue()
	if err != nil {
		return "", err
	}
	if !utf8.Valid(value) {
		return "", bitcoinInvalidResponse()
	}
	return string(value), nil
}

func (reader *suiReader) skip(field, wire int, depth int) error {
	if depth > suiMaxProtoDepth {
		return bitcoinInvalidResponse()
	}
	if wire == 3 && depth >= suiMaxProtoDepth {
		return bitcoinInvalidResponse()
	}
	switch wire {
	case 0:
		_, err := reader.varint()
		return err
	case 1:
		if reader.remaining() < 8 {
			return bitcoinInvalidResponse()
		}
		reader.offset += 8
		return nil
	case 2:
		_, err := reader.bytesValue()
		return err
	case 3:
		for {
			nestedField, nestedWire, err := reader.key()
			if err != nil {
				return err
			}
			if nestedWire == 4 {
				if nestedField != field {
					return bitcoinInvalidResponse()
				}
				return nil
			}
			if err := reader.skip(nestedField, nestedWire, depth+1); err != nil {
				return err
			}
		}
	case 5:
		if reader.remaining() < 4 {
			return bitcoinInvalidResponse()
		}
		reader.offset += 4
		return nil
	default:
		return bitcoinInvalidResponse()
	}
}

func suiRequireWire(actual, expected int) error {
	if actual != expected {
		return bitcoinInvalidResponse()
	}
	return nil
}

func decodeSuiTimestamp(data []byte, target *suiTimestamp, depth int) error {
	if depth > suiMaxProtoDepth {
		return bitcoinInvalidResponse()
	}
	reader := suiReader{data: data}
	for reader.remaining() > 0 {
		field, wire, err := reader.key()
		if err != nil {
			return err
		}
		switch field {
		case 1:
			if err := suiRequireWire(wire, 0); err != nil {
				return err
			}
			value, err := reader.varint()
			if err != nil {
				return err
			}
			target.seconds = int64(value)
			target.secondsSet = true
		case 2:
			if err := suiRequireWire(wire, 0); err != nil {
				return err
			}
			value, err := reader.varint()
			if err != nil {
				return err
			}
			target.nanos = int32(value)
			target.nanosSet = true
		default:
			if err := reader.skip(field, wire, depth); err != nil {
				return err
			}
		}
	}
	return nil
}

func decodeSuiServiceInfo(data []byte, target *suiServiceInfo, depth int) error {
	if depth > suiMaxProtoDepth {
		return bitcoinInvalidResponse()
	}
	reader := suiReader{data: data}
	for reader.remaining() > 0 {
		field, wire, err := reader.key()
		if err != nil {
			return err
		}
		switch field {
		case 1:
			if err := suiRequireWire(wire, 2); err != nil {
				return err
			}
			target.chainID, err = reader.stringValue()
			if err != nil {
				return err
			}
			target.chainIDSet = true
		case 2:
			if err := suiRequireWire(wire, 2); err != nil {
				return err
			}
			target.chain, err = reader.stringValue()
			if err != nil {
				return err
			}
		case 3:
			if err := suiRequireWire(wire, 0); err != nil {
				return err
			}
			target.epoch, err = reader.varint()
			if err != nil {
				return err
			}
			target.epochSet = true
		case 4:
			if err := suiRequireWire(wire, 0); err != nil {
				return err
			}
			target.checkpoint, err = reader.varint()
			if err != nil {
				return err
			}
			target.checkpointSet = true
		case 5:
			if err := suiRequireWire(wire, 2); err != nil {
				return err
			}
			payload, err := reader.bytesValue()
			if err != nil {
				return err
			}
			if err := decodeSuiTimestamp(payload, &target.timestamp, depth+1); err != nil {
				return err
			}
			target.timestampSet = true
		case 6:
			if err := suiRequireWire(wire, 0); err != nil {
				return err
			}
			target.lowest, err = reader.varint()
			if err != nil {
				return err
			}
			target.lowestSet = true
		case 7:
			if err := suiRequireWire(wire, 0); err != nil {
				return err
			}
			target.lowestObjects, err = reader.varint()
			if err != nil {
				return err
			}
			target.lowestObjectsSet = true
		case 8:
			if err := suiRequireWire(wire, 2); err != nil {
				return err
			}
			value, err := reader.stringValue()
			if err != nil {
				return err
			}
			target.server = &value
			target.serverSet = true
		default:
			if err := reader.skip(field, wire, depth); err != nil {
				return err
			}
		}
	}
	if !target.chainIDSet || !target.timestampSet || !target.epochSet || !target.checkpointSet || !target.lowestSet || !target.lowestObjectsSet || target.timestamp.nanos < 0 || target.timestamp.nanos >= 1_000_000_000 {
		return bitcoinInvalidResponse()
	}
	return nil
}

func decodeSuiObject(data []byte, target *suiObject, depth int) error {
	if depth > suiMaxProtoDepth {
		return bitcoinInvalidResponse()
	}
	reader := suiReader{data: data}
	for reader.remaining() > 0 {
		field, wire, err := reader.key()
		if err != nil {
			return err
		}
		switch field {
		case 2:
			if err := suiRequireWire(wire, 2); err != nil {
				return err
			}
			target.objectID, err = reader.stringValue()
			if err != nil {
				return err
			}
			target.objectIDSet = true
		case 3:
			if err := suiRequireWire(wire, 0); err != nil {
				return err
			}
			target.version, err = reader.varint()
			if err != nil {
				return err
			}
			target.versionSet = true
		case 4:
			if err := suiRequireWire(wire, 2); err != nil {
				return err
			}
			target.digest, err = reader.stringValue()
			if err != nil {
				return err
			}
			target.digestSet = true
		default:
			if err := reader.skip(field, wire, depth); err != nil {
				return err
			}
		}
	}
	return nil
}

func decodeSuiObjectResponse(data []byte) (SuiObjectSummary, error) {
	reader := suiReader{data: data}
	var object suiObject
	present := false
	for reader.remaining() > 0 {
		field, wire, err := reader.key()
		if err != nil {
			return SuiObjectSummary{}, err
		}
		if field == 1 {
			if err := suiRequireWire(wire, 2); err != nil {
				return SuiObjectSummary{}, err
			}
			payload, err := reader.bytesValue()
			if err != nil {
				return SuiObjectSummary{}, err
			}
			if err := decodeSuiObject(payload, &object, 1); err != nil {
				return SuiObjectSummary{}, err
			}
			present = true
		} else if err := reader.skip(field, wire, 0); err != nil {
			return SuiObjectSummary{}, err
		}
	}
	if !present || !object.objectIDSet || !object.versionSet || !object.digestSet {
		return SuiObjectSummary{}, bitcoinInvalidResponse()
	}
	return SuiObjectSummary{ObjectID: object.objectID, Version: object.version, Digest: object.digest}, nil
}

func decodeSuiBalance(data []byte, target *suiBalance, depth int) error {
	if depth > suiMaxProtoDepth {
		return bitcoinInvalidResponse()
	}
	reader := suiReader{data: data}
	for reader.remaining() > 0 {
		field, wire, err := reader.key()
		if err != nil {
			return err
		}
		switch field {
		case 1:
			if err := suiRequireWire(wire, 2); err != nil {
				return err
			}
			target.coinType, err = reader.stringValue()
			if err != nil {
				return err
			}
			target.coinTypeSet = true
		case 3:
			if err := suiRequireWire(wire, 0); err != nil {
				return err
			}
			target.balance, err = reader.varint()
			if err != nil {
				return err
			}
			target.balanceSet = true
		case 4:
			if err := suiRequireWire(wire, 0); err != nil {
				return err
			}
			target.addressBalance, err = reader.varint()
			if err != nil {
				return err
			}
			target.addressBalanceSet = true
		case 5:
			if err := suiRequireWire(wire, 0); err != nil {
				return err
			}
			target.coinBalance, err = reader.varint()
			if err != nil {
				return err
			}
			target.coinBalanceSet = true
		default:
			if err := reader.skip(field, wire, depth); err != nil {
				return err
			}
		}
	}
	return nil
}

func decodeSuiBalanceResponse(data []byte) (SuiBalance, error) {
	reader := suiReader{data: data}
	var balance suiBalance
	present := false
	for reader.remaining() > 0 {
		field, wire, err := reader.key()
		if err != nil {
			return SuiBalance{}, err
		}
		if field == 1 {
			if err := suiRequireWire(wire, 2); err != nil {
				return SuiBalance{}, err
			}
			payload, err := reader.bytesValue()
			if err != nil {
				return SuiBalance{}, err
			}
			if err := decodeSuiBalance(payload, &balance, 1); err != nil {
				return SuiBalance{}, err
			}
			present = true
		} else if err := reader.skip(field, wire, 0); err != nil {
			return SuiBalance{}, err
		}
	}
	if !present || !balance.coinTypeSet || !balance.balanceSet || !balance.addressBalanceSet || !balance.coinBalanceSet || balance.addressBalance > ^uint64(0)-balance.coinBalance || balance.addressBalance+balance.coinBalance != balance.balance {
		return SuiBalance{}, bitcoinInvalidResponse()
	}
	return SuiBalance{CoinType: balance.coinType, Balance: balance.balance, AddressBalance: balance.addressBalance, CoinBalance: balance.coinBalance}, nil
}

func hasSuiField(data []byte, wantedField, wantedWire int) bool {
	reader := suiReader{data: data}
	for reader.remaining() > 0 {
		field, wire, err := reader.key()
		if err != nil {
			return false
		}
		if field == wantedField && wire == wantedWire {
			return true
		}
		if reader.skip(field, wire, 0) != nil {
			return false
		}
	}
	return false
}

func encodeSuiVarint(value uint64, target *[]byte) {
	for value >= 0x80 {
		*target = append(*target, byte(value)|0x80)
		value >>= 7
	}
	*target = append(*target, byte(value))
}

func encodeSuiString(field int, value string, target *[]byte) {
	encodeSuiVarint(uint64(field<<3|2), target)
	encodeSuiVarint(uint64(len(value)), target)
	*target = append(*target, value...)
}

func encodeSuiRequest(kind string, objectID string, version *uint64, owner string, coinType string) ([]byte, error) {
	var payload []byte
	switch kind {
	case "GetServiceInfo":
	case "GetObject":
		encodeSuiString(1, objectID, &payload)
		if version != nil {
			encodeSuiVarint(uint64(2<<3), &payload)
			encodeSuiVarint(*version, &payload)
		}
	case "GetBalance":
		encodeSuiString(1, owner, &payload)
		encodeSuiString(2, coinType, &payload)
	default:
		return nil, bitcoinInvalidResponse()
	}
	if len(payload) > suiMaxRequestBytes-5 {
		return nil, sdkError(ErrorConfig, "Sui request exceeds the supported size")
	}
	frame := make([]byte, 5+len(payload))
	frame[0] = 0
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(payload)))
	copy(frame[5:], payload)
	return frame, nil
}
