# frozen_string_literal: true

require "open3"
require "rbconfig"
require "json"
require "rubygems/package"
require "tmpdir"

require_relative "../lib/erpc_sdk/version"

gem_path = File.expand_path("../pkg/erpc-sdk-#{ERPC::VERSION}.gem", __dir__)
raise "Missing packaged gem #{gem_path}" unless File.file?(gem_path)

expected = Dir.chdir(File.expand_path("..", __dir__)) do
  Dir["lib/**/*.rb"].sort + %w[LICENSE README.md]
end
actual = Gem::Package.new(gem_path).spec.files.sort
raise "Unexpected gem contents: #{actual.inspect}" unless actual == expected.sort

def installed_dependency_context
  roots = Gem.path.dup
  specs = Gem::Specification.find_all_by_name("digest-keccak", "0.0.7").map(&:full_gem_path)
  begin
    helper_code = <<~RUBY
      require "json"
      require "rubygems"
      puts JSON.generate(
        "roots" => Gem.path,
        "specs" => Gem::Specification.find_all_by_name("digest-keccak", "0.0.7").map(&:full_gem_path)
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
      specs.concat(Array(context["specs"]))
    end
  rescue StandardError
    # Fall back to the current RubyGems view; the explicit missing-dependency
    # check below still fails rather than installing or guessing a dependency.
    nil
  end
  runtime_gem_root = File.expand_path("../gems/#{RbConfig::CONFIG.fetch("ruby_version")}", RbConfig::CONFIG.fetch("rubylibdir"))
  roots << runtime_gem_root if File.directory?(runtime_gem_root)
  [roots, specs]
end

dependency_roots, dependency_specs = installed_dependency_context
raise "Missing installed digest-keccak 0.0.7 dependency" if dependency_specs.empty?

dependency_roots.concat(dependency_specs.map do |full_gem_path|
  File.expand_path("../..", full_gem_path)
end)
dependency_roots = dependency_roots.map { |path| File.expand_path(path) }.select { |path| File.directory?(path) }.uniq
raise "No installed gem roots available for digest-keccak 0.0.7" if dependency_roots.empty?

child_environment = ENV.to_h
child_environment["GEM_HOME"] = nil
child_environment["RUBYLIB"] = nil
child_environment["RUBYOPT"] = nil
child_environment.keys.grep(/\ABUNDLE_/).each { |key| child_environment[key] = nil }
child_environment["GEM_PATH"] = dependency_roots.join(File::PATH_SEPARATOR)

Dir.mktmpdir("erpc-sdk-gem-") do |directory|
  Gem::Package.new(gem_path).extract_files(directory)
  library = File.join(directory, "lib")
  child_code = <<~RUBY
    require "erpc_sdk"
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
