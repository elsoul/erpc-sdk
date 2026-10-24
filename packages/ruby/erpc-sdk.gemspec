# frozen_string_literal: true

require_relative "lib/erpc_sdk/version"

Gem::Specification.new do |spec|
  spec.name = "erpc-sdk"
  spec.version = ERPC::VERSION
  spec.authors = ["ELSOUL LABO B.V."]
  spec.summary = "Multi-network Ruby SDK for ERPC"
  spec.description = "Ruby client for ERPC Solana, Ethereum, and Avalanche RPC, REST, streams, subscriptions, and Cloud reads."
  spec.homepage = "https://erpc.global"
  spec.licenses = ["MIT", "Apache-2.0", "BSD-3-Clause"]
  spec.required_ruby_version = ">= 3.1"

  spec.metadata = {
    "bug_tracker_uri" => "https://github.com/elsoul/erpc-sdk/issues",
    "changelog_uri" => "https://github.com/elsoul/erpc-sdk/blob/main/CHANGELOG.md",
    "documentation_uri" => "https://github.com/elsoul/erpc-sdk/tree/main/packages/ruby",
    "homepage_uri" => spec.homepage,
    "source_code_uri" => "https://github.com/elsoul/erpc-sdk",
    "rubygems_mfa_required" => "true"
  }

  spec.files = Dir.chdir(__dir__) do
    Dir["lib/**/*.rb"].sort + %w[
      LICENSE README.md THIRD_PARTY_NOTICES.md
      LICENSES/Apache-2.0.txt LICENSES/BSD-3-Clause-Google-Protobuf.txt
    ]
  end
  spec.require_paths = ["lib"]

  spec.add_runtime_dependency "base64", "= 0.2.0"
  spec.add_runtime_dependency "bigdecimal", "= 4.1.3"
  spec.add_runtime_dependency "digest-keccak", "= 0.0.7"

  spec.add_development_dependency "minitest", ">= 5.18", "< 6"
  spec.add_development_dependency "rake", ">= 13", "< 14"
end
