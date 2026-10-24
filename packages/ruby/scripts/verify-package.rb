# frozen_string_literal: true

require "open3"
require "rbconfig"
require "json"
require "rubygems/package"
require "tmpdir"
require "digest"

require_relative "../lib/erpc_sdk/version"

gem_path = File.expand_path("../pkg/erpc-sdk-#{ERPC::VERSION}.gem", __dir__)
raise "Missing packaged gem #{gem_path}" unless File.file?(gem_path)

expected_runtime_dependencies = {
  "base64" => Gem::Requirement.new("= 0.2.0"),
  "bigdecimal" => Gem::Requirement.new("= 4.1.3"),
  "digest-keccak" => Gem::Requirement.new("= 0.0.7")
}.freeze

package_spec = Gem::Package.new(gem_path).spec
runtime_dependencies = package_spec.runtime_dependencies.each_with_object({}) do |dependency, result|
  result[dependency.name] = dependency.requirement
end
unless runtime_dependencies == expected_runtime_dependencies
  raise "Unexpected runtime dependencies: #{runtime_dependencies.inspect}"
end

expected = Dir.chdir(File.expand_path("..", __dir__)) do
  Dir["lib/**/*.rb"].sort + %w[
    LICENSE README.md THIRD_PARTY_NOTICES.md
    LICENSES/Apache-2.0.txt LICENSES/BSD-3-Clause-Google-Protobuf.txt
  ]
end
actual = package_spec.files.sort
raise "Unexpected gem contents: #{actual.inspect}" unless actual == expected.sort
unless package_spec.licenses.sort == ["Apache-2.0", "BSD-3-Clause", "MIT"]
  raise "Unexpected gem license metadata: #{package_spec.licenses.inspect}"
end

def installed_dependency_context
  roots = Gem.path.dup
  expected_versions = {
    "base64" => "0.2.0",
    "bigdecimal" => "4.1.3",
    "digest-keccak" => "0.0.7"
  }
  specs = expected_versions.each_with_object({}) do |(name, version), result|
    result[name] = Gem::Specification.find_all_by_name(name, version).map(&:full_gem_path)
  end
  begin
    helper_code = <<~RUBY
      require "json"
      require "rubygems"
      puts JSON.generate(
        "roots" => Gem.path,
        "specs" => {
          "base64" => Gem::Specification.find_all_by_name("base64", "0.2.0").map(&:full_gem_path),
          "bigdecimal" => Gem::Specification.find_all_by_name("bigdecimal", "4.1.3").map(&:full_gem_path),
          "digest-keccak" => Gem::Specification.find_all_by_name("digest-keccak", "0.0.7").map(&:full_gem_path)
        }
      )
    RUBY
    output, _error_output, status = Open3.capture3(
      RbConfig.ruby,
      "-S",
      "bundle",
      "exec",
      RbConfig.ruby,
      "-rrubygems",
      "-e",
      helper_code,
      chdir: File.expand_path("..", __dir__)
    )
    if status.success?
      context = JSON.parse(output)
      roots.concat(Array(context["roots"]))
      context_specs = context["specs"] || {}
      expected_versions.each_key do |name|
        specs[name].concat(Array(context_specs[name]))
      end
    end
  rescue StandardError
    # Fall back to the current RubyGems view; the explicit missing-dependency
    # check below still fails rather than installing or guessing a dependency.
    nil
  end
  runtime_gem_root = File.expand_path("../gems/#{RbConfig::CONFIG.fetch("ruby_version")}", RbConfig::CONFIG.fetch("rubylibdir"))
  roots << runtime_gem_root if File.directory?(runtime_gem_root)
  roots << RbConfig::CONFIG.fetch("rubylibdir") if File.directory?(RbConfig::CONFIG.fetch("rubylibdir"))
  [roots, specs]
end

dependency_roots, dependency_specs = installed_dependency_context
missing_dependencies = dependency_specs.select { |_name, paths| paths.empty? }.keys
unless missing_dependencies.empty?
  raise "Missing installed runtime dependencies: #{missing_dependencies.join(", ")}"
end

dependency_roots.concat(dependency_specs.values.flatten.map do |full_gem_path|
  File.expand_path("../..", full_gem_path)
end)
dependency_roots = dependency_roots.map { |path| File.expand_path(path) }.select { |path| File.directory?(path) }.uniq
raise "No installed gem roots available for runtime dependencies" if dependency_roots.empty?

child_environment = ENV.to_h
child_environment["GEM_HOME"] = nil
child_environment["RUBYLIB"] = nil
child_environment["RUBYOPT"] = nil
child_environment.keys.grep(/\A(?:BUNDLE_|BUNDLER_ORIG_)/).each { |key| child_environment[key] = nil }
child_environment["GEM_PATH"] = dependency_roots.join(File::PATH_SEPARATOR)

Dir.mktmpdir("erpc-sdk-gem-") do |directory|
  Gem::Package.new(gem_path).extract_files(directory)
  library = File.join(directory, "lib")
  expected_license_files = {
    "LICENSES/Apache-2.0.txt" => "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
    "LICENSES/BSD-3-Clause-Google-Protobuf.txt" => "87a95acbb870e296243a71b67631984702e6e55e9057deaf01018f0bad4ca4e0"
  }
  expected_license_files.each do |relative, expected_digest|
    actual_path = File.join(directory, relative)
    abort "Missing packaged #{relative}" unless File.file?(actual_path)
    abort "Packaged #{relative} hash mismatch" unless Digest::SHA256.file(actual_path).hexdigest == expected_digest
  end
  sui_source = File.read(File.join(library, "erpc_sdk/sui_proto.rb"))
  abort "Sui source provenance pin missing" unless sui_source.include?("aa9ba2c13b2a9348059b38110e64af39849a0377")
  abort "Sui source SPDX attribution missing" unless sui_source.include?("Apache-2.0 AND BSD-3-Clause")
  abort "Google Timestamp attribution missing" unless sui_source.include?("Copyright 2008 Google Inc.")
  child_code = <<~RUBY
    gem "bigdecimal", "4.1.3"
    require "erpc_sdk"
    require "base64"
    require "bigdecimal"
    expected_origin = File.realpath(File.join(#{library.inspect}, "erpc_sdk.rb"))
    loaded_origin = $LOADED_FEATURES.map do |feature|
      begin
        File.realpath(feature)
      rescue Errno::ENOENT, TypeError
        nil
      end
    end.find do |feature|
      feature == expected_origin
    end
    abort "SDK origin is not the extracted package" unless loaded_origin
    abort "SDK version mismatch" unless ERPC::VERSION == #{ERPC::VERSION.inspect}
    expected_dependencies = {
      "base64" => "0.2.0",
      "bigdecimal" => "4.1.3",
      "digest-keccak" => "0.0.7"
    }
    dependency_roots = ENV.fetch("GEM_PATH").split(File::PATH_SEPARATOR).map do |path|
      File.realpath(path)
    rescue Errno::ENOENT
      nil
    end.compact
    expected_dependencies.each do |name, version|
      spec = Gem.loaded_specs[name]
      abort "Missing loaded \#{name} dependency" unless spec
      abort "Loaded \#{name} version mismatch" unless spec.version == Gem::Version.new(version)
      origin = if File.directory?(spec.full_gem_path)
        File.realpath(spec.full_gem_path)
      elsif spec.respond_to?(:default_gem?) && spec.default_gem?
        loaded_feature = $LOADED_FEATURES.map do |feature|
          begin
            File.realpath(feature)
          rescue Errno::ENOENT, TypeError
            nil
          end
        end.find { |feature| feature&.end_with?("/\#{name}.rb") }
        abort "Loaded \#{name} default gem has no load origin" unless loaded_feature
        loaded_feature
      else
        abort "Loaded \#{name} dependency has no installed path"
      end
      unless dependency_roots.any? { |root| origin == root || origin.start_with?("\#{root}\#{File::SEPARATOR}") }
        abort "Loaded \#{name} outside isolated dependency roots"
      end
    end
    bigdecimal_spec = Gem.loaded_specs.fetch("bigdecimal")
    abort "BigDecimal version mismatch" unless BigDecimal::VERSION == "4.1.3"
    abort "BigDecimal must load as the exact MRI ruby gem" unless bigdecimal_spec.platform.to_s == "ruby"
    abort "BigDecimal must not fall back to a default gem" if bigdecimal_spec.respond_to?(:default_gem?) && bigdecimal_spec.default_gem?
    bigdecimal_root = File.realpath(bigdecimal_spec.full_gem_path)
    abort "BigDecimal must load from an isolated gem root" unless dependency_roots.any? do |root|
      bigdecimal_root == root || bigdecimal_root.start_with?("\#{root}\#{File::SEPARATOR}")
    end
    loaded_bigdecimal = $LOADED_FEATURES.map do |feature|
      begin
        File.realpath(feature)
      rescue Errno::ENOENT, TypeError
        nil
      end
    end.compact.find do |feature|
      feature.start_with?("\#{bigdecimal_root}\#{File::SEPARATOR}") && feature.match?(/bigdecimal(?:\\.bundle|\\.so|\\.dylib|\\.dll|\\.rb)\\z/)
    end
    abort "BigDecimal native/load origin was not observed" unless loaded_bigdecimal
    encoded = Base64.strict_encode64("erpc-sdk")
    abort "Base64 round-trip failed" unless Base64.strict_decode64(encoded) == "erpc-sdk"
    catalog = ERPC::TokenCatalog
    chain = ERPC::TokenChainIDs::ETHEREUM_MAINNET
    abort "native token smoke check failed" unless catalog.get_native_token_deployment(chain)&.fetch(:symbol) == "ETH"
    abort "USDC token smoke check failed" unless catalog.find_token_deployments_by_symbol(chain, "USDC").any?
    abort "token list smoke check failed" unless catalog.list_token_deployments(chain_id: chain).any?
    rankings = ERPC::TokenRankings
    abort "ranking digest smoke check failed" unless rankings::TOKEN_RANKINGS_CONTENT_DIGEST == rankings::TOKEN_RANKINGS_METADATA.fetch(:content_digest)
    abort "ranking empty smoke check failed" unless rankings.list_token_rankings("").empty?
    abort "ranking freeze smoke check failed" unless rankings.list_token_rankings("").frozen?
  RUBY
  output, status = Open3.capture2e(
    child_environment,
    RbConfig.ruby,
    "-I#{library}",
    "-e",
    child_code,
    chdir: directory
  )
  raise "Packaged gem smoke test failed: #{output}" unless status.success?
end

puts "Verified erpc-sdk #{ERPC::VERSION} gem contents and load path."
