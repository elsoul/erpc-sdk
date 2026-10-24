# frozen_string_literal: true

# Copyright (c) Mysten Labs, Inc.
# Adapted handwritten bounded Sui schema projection.
#
# Source provenance: MystenLabs/sui-apis commit
# aa9ba2c13b2a9348059b38110e64af39849a0377; selected source paths are
# proto/sui/rpc/v2/ledger_service.proto, state_service.proto, object.proto,
# and proto/google/protobuf/timestamp.proto. This file implements only the
# three read-only unary messages used by this SDK; unrelated schema fields and
# general protobuf reflection/runtime support are intentionally omitted.
# SPDX-License-Identifier: Apache-2.0 AND BSD-3-Clause

module ERPC
  module SuiProto
    module_function

    MAX_U64 = 18_446_744_073_709_551_615
    MAX_I64 = 9_223_372_036_854_775_807
    MIN_I64 = -9_223_372_036_854_775_808
    MAX_REQUEST_BYTES = 1_048_576
    MAX_RESPONSE_BYTES = 8_388_608
    MAX_TRAILER_BYTES = 8_192
    MAX_RECURSION = 100

    def validate_u64(value, message = "Sui value must be a u64")
      unless value.is_a?(Integer) && !value.is_a?(TrueClass) && !value.is_a?(FalseClass) && value.between?(0, MAX_U64)
        raise ConfigError, message, cause: nil
      end
      value
    end

    def validate_input_string(value, label)
      unless value.is_a?(String)
        raise ConfigError, "#{label} must be a non-empty UTF-8 string", cause: nil
      end

      bytes = value.dup.force_encoding(Encoding::BINARY)
      utf8 = bytes.dup.force_encoding(Encoding::UTF_8)
      unless !bytes.empty? && utf8.valid_encoding? && !utf8.match?(/[\x00-\x1f\x7f]/)
        raise ConfigError, "#{label} must be a non-empty UTF-8 string", cause: nil
      end
      utf8
    end

    def encode_varint(value)
      validate_u64(value)
      output = +"".b
      loop do
        byte = value & 0x7f
        value >>= 7
        output << (value.zero? ? byte : byte | 0x80)
        break if value.zero?
      end
      output
    end

    def encode_key(field, wire)
      encode_varint((field << 3) | wire)
    end

    def encode_string(field, value)
      bytes = value.to_s.encode(Encoding::UTF_8).b
      encode_key(field, 2) + encode_varint(bytes.bytesize) + bytes
    end

    def encode_u64(field, value)
      encode_key(field, 0) + encode_varint(value)
    end

    def frame(payload)
      raise ConfigError, "Sui request exceeds the 1 MiB framed limit", cause: nil if payload.bytesize + 5 > MAX_REQUEST_BYTES
      "\x00".b + [payload.bytesize].pack("N") + payload
    end

    def service_info_request
      frame("".b)
    end

    def object_request(object_id, version = nil)
      object_id = validate_input_string(object_id, "object_id")
      payload = encode_string(1, object_id)
      payload << encode_u64(2, validate_u64(version, "version must be a u64")) unless version.nil?
      frame(payload)
    end

    def balance_request(owner, coin_type)
      payload = encode_string(1, validate_input_string(owner, "owner"))
      payload << encode_string(2, validate_input_string(coin_type, "coin_type"))
      frame(payload)
    end

    def decode_response(chunks)
      total = 0
      body = +"".b
      enum = if chunks.respond_to?(:each)
               chunks
             else
               raise InvalidResponseError.new("ERPC returned an invalid Sui response"), cause: nil
             end
      enum.each do |chunk|
        bytes = chunk.to_s.b
        raise InvalidResponseError.new("ERPC returned an invalid Sui response"), cause: nil if total + bytes.bytesize > MAX_RESPONSE_BYTES
        body << bytes
        total += bytes.bytesize
      end
      decode_frames(body)
    rescue InvalidResponseError
      raise
    rescue TransportError, TimeoutError
      raise
    rescue IOError, EOFError, SocketError, SystemCallError
      raise TransportError, "Unable to reach ERPC", cause: nil
    rescue ::Timeout::Error
      raise
    rescue StandardError
      raise InvalidResponseError.new("ERPC returned an invalid Sui response"), cause: nil
    end

    def decode_frames(body)
      cursor = 0
      data = nil
      trailer = nil
      until cursor == body.bytesize
        raise_invalid! if body.bytesize - cursor < 5
        marker = body.getbyte(cursor)
        length = body.byteslice(cursor + 1, 4).unpack1("N")
        cursor += 5
        raise_invalid! if length > body.bytesize - cursor
        payload = body.byteslice(cursor, length)
        cursor += length
        case marker
        when 0x00
          raise_invalid! unless data.nil? && trailer.nil?
          data = payload
        when 0x80
          raise_invalid! unless !data.nil? && trailer.nil?
          trailer = payload
        else
          raise_invalid!
        end
      end
      raise_invalid! unless data && trailer
      raise_invalid! if trailer.bytesize > MAX_TRAILER_BYTES
      validate_trailer(trailer)
      data
    end

    def validate_trailer(payload)
      text = payload.dup.force_encoding(Encoding::UTF_8)
      raise_invalid! unless text.valid_encoding? && text.end_with?("\r\n")
      statuses = []
      lines = text.split("\r\n", -1)
      lines.pop
      lines.each do |line|
        name, separator, value = line.partition(":")
        raise_invalid! if separator.empty? || name.empty? || !name.match?(/\A[a-z0-9!#\$%&'\*+\-.\^_`|~]+\z/)
        raise_invalid! if value.match?(/[\x00-\x08\x0a\x0b\x0c\x0d\x0e-\x1f\x7f]/)
        trimmed = value.sub(/\A[ \t]*/, "").sub(/[ \t]*\z/, "")
        statuses << trimmed if name == "grpc-status"
      end
      raise_invalid! unless statuses.length == 1 && statuses.first == "0"
      nil
    end

    def parse_service_info(payload)
      fields = parse_message(payload, 0, { 1 => 2, 2 => 2, 3 => 0, 4 => 0, 5 => 2, 6 => 0, 7 => 0, 8 => 2 },
                             repeated_fields: [5], string_fields: [1, 2, 8])
      required = [1, 2, 3, 4, 5, 6, 7]
      raise_invalid! unless required.all? { |field| fields.key?(field) }
      timestamp = parse_timestamp_fields(merge_embedded(fields.fetch(5), 1, { 1 => 0, 2 => 0 }))
      SuiServiceInfo.new(
        chain_id: string_field(fields.fetch(1)), chain: string_field(fields.fetch(2)), epoch: u64_field(fields.fetch(3)),
        checkpoint_height: u64_field(fields.fetch(4)), timestamp_seconds: timestamp.fetch(:seconds), timestamp_nanos: timestamp.fetch(:nanos),
        lowest_available_checkpoint: u64_field(fields.fetch(6)), lowest_available_checkpoint_objects: u64_field(fields.fetch(7)),
        server: fields.key?(8) ? string_field(fields.fetch(8)) : nil
      )
    end

    def parse_object_response(payload)
      outer = parse_message(payload, 0, { 1 => 2 }, repeated_fields: [1]); raise_invalid! unless outer.key?(1)
      fields = merge_embedded(outer.fetch(1), 1, { 2 => 2, 3 => 0, 4 => 2 }, string_fields: [2, 4])
      required = [2, 3, 4]; raise_invalid! unless required.all? { |field| fields.key?(field) }
      SuiObjectSummary.new(object_id: string_field(fields.fetch(2)), version: u64_field(fields.fetch(3)), digest: string_field(fields.fetch(4)))
    end

    def parse_balance_response(payload)
      outer = parse_message(payload, 0, { 1 => 2 }, repeated_fields: [1]); raise_invalid! unless outer.key?(1)
      fields = merge_embedded(outer.fetch(1), 1, { 1 => 2, 3 => 0, 4 => 0, 5 => 0 }, string_fields: [1])
      required = [1, 3, 4, 5]; raise_invalid! unless required.all? { |field| fields.key?(field) }
      balance = u64_field(fields.fetch(3)); address_balance = u64_field(fields.fetch(4)); coin_balance = u64_field(fields.fetch(5))
      raise_invalid! unless address_balance <= MAX_U64 - coin_balance && address_balance + coin_balance == balance
      SuiBalance.new(coin_type: string_field(fields.fetch(1)), balance: balance, address_balance: address_balance, coin_balance: coin_balance)
    end

    # Protocol Buffers - Google's data interchange format
    # Copyright 2008 Google Inc.  All rights reserved.
    # https://developers.google.com/protocol-buffers/
    #
    # Redistribution and use in source and binary forms, with or without
    # modification, are permitted provided that the following conditions are
    # met:
    #
    #     * Redistributions of source code must retain the above copyright
    # notice, this list of conditions and the following disclaimer.
    #     * Redistributions in binary form must reproduce the above
    # copyright notice, this list of conditions and the following disclaimer
    # in the documentation and/or other materials provided with the
    # distribution.
    #     * Neither the name of Google Inc. nor the names of its
    # contributors may be used to endorse or promote products derived from
    # this software without specific prior written permission.
    #
    # THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
    # "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
    # LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
    # A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
    # OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
    # SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
    # LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
    # DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
    # THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
    # (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
    # OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
    def parse_timestamp(payload, depth = 0)
      fields = parse_message(payload, depth, { 1 => 0, 2 => 0 })
      parse_timestamp_fields(fields)
    end

    def parse_timestamp_fields(fields)
      seconds = fields.key?(1) ? signed_i64(last_scalar(fields.fetch(1))) : 0
      nanos = fields.key?(2) ? signed_i32(last_scalar(fields.fetch(2))) : 0
      raise_invalid! unless nanos.between?(0, 999_999_999)
      { seconds: seconds, nanos: nanos }
    end

    def parse_message(payload, depth = 0, schema = nil, repeated_fields: [], string_fields: [])
      raise_invalid! if depth > MAX_RECURSION
      fields = {}
      index = 0
      while index < payload.bytesize
        key, index = read_varint(payload, index)
        field = key >> 3; wire = key & 0x07
        raise_invalid! if field.zero? || field > 536_870_911
        raise_invalid! if schema && schema.key?(field) && schema.fetch(field) != wire
        case wire
        when 0
          value, index = read_varint(payload, index); fields[field] = value
        when 1
          raise_invalid! if index + 8 > payload.bytesize
          index += 8
        when 2
          length, index = read_varint(payload, index); raise_invalid! if length > payload.bytesize - index
          value = payload.byteslice(index, length); index += length
          validate_utf8_fragment(value) if string_fields.include?(field)
          if repeated_fields.include?(field)
            fields[field] ||= []
            fields[field] << value
          else
            fields[field] = value
          end
        when 3
          index = skip_group(payload, index, field, depth + 1)
        when 4
          raise_invalid!
        when 5
          raise_invalid! if index + 4 > payload.bytesize
          index += 4
        else
          raise_invalid!
        end
      end
      fields
    end

    def merge_embedded(value, depth, schema, string_fields: [])
      fragments = value.is_a?(Array) ? value : [value]
      fragments.each_with_object({}) do |fragment, merged|
        parsed = parse_message(fragment, depth, schema, string_fields: string_fields)
        parsed.each { |field, field_value| merged[field] = field_value }
      end
    end

    def skip_group(payload, index, group_field, depth)
      raise_invalid! if depth > MAX_RECURSION
      while index < payload.bytesize
        key, index = read_varint(payload, index); field = key >> 3; wire = key & 0x07
        raise_invalid! if field.zero? || field > 536_870_911
        return index if wire == 4 && field == group_field
        case wire
        when 0 then _value, index = read_varint(payload, index)
        when 1 then raise_invalid! if index + 8 > payload.bytesize; index += 8
        when 2 then length, index = read_varint(payload, index); raise_invalid! if length > payload.bytesize - index; index += length
        when 3 then index = skip_group(payload, index, field, depth + 1)
        when 5 then raise_invalid! if index + 4 > payload.bytesize; index += 4
        else raise_invalid!
        end
      end
      raise_invalid!
    end

    def read_varint(payload, index)
      value = 0; shift = 0; count = 0
      loop do
        raise_invalid! if index >= payload.bytesize || count >= 10
        byte = payload.getbyte(index); index += 1; count += 1
        if count == 10 && (byte & 0x7e) != 0 then raise_invalid! end
        value |= (byte & 0x7f) << shift
        return [value, index] if (byte & 0x80).zero?
        shift += 7
      end
    end

    def signed_i64(value)
      value > MAX_I64 ? value - (1 << 64) : value
    end

    def signed_i32(value)
      raw = value & 0xffff_ffff
      raw >= 0x8000_0000 ? raw - (1 << 32) : raw
    end

    def string_field(value)
      value = last_scalar(value)
      text = value.dup.force_encoding(Encoding::UTF_8)
      raise_invalid! unless text.valid_encoding?
      text
    end

    def validate_utf8_fragment(value)
      text = value.dup.force_encoding(Encoding::UTF_8)
      raise_invalid! unless text.valid_encoding?
      value
    end

    def u64_field(value)
      value = last_scalar(value)
      raise_invalid! unless value.is_a?(Integer) && value.between?(0, MAX_U64)
      value
    end

    def last_scalar(value)
      value.is_a?(Array) ? value.last : value
    end

    def raise_invalid!
      raise InvalidResponseError.new("ERPC returned an invalid Sui response"), cause: nil
    end
    private_class_method :raise_invalid!
  end

  SUI_GRPC_WEB_CONTENT_TYPE = "application/grpc-web+proto".freeze

  SuiServiceInfo = Struct.new(:chain_id, :chain, :epoch, :checkpoint_height, :timestamp_seconds, :timestamp_nanos,
                              :lowest_available_checkpoint, :lowest_available_checkpoint_objects, :server, keyword_init: true) do
    def initialize(**values); super; freeze; end
  end
  class SuiObjectSummary
    attr_reader :version, :digest
    def initialize(object_id:, version:, digest:)
      @sui_object_id = object_id; @version = version; @digest = digest; freeze
    end
    def sui_object_id; @sui_object_id; end
  end
  SuiBalance = Struct.new(:coin_type, :balance, :address_balance, :coin_balance, keyword_init: true) do
    def initialize(**values); super; freeze; end
  end

  private_constant :SuiProto
end
