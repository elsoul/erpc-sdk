# frozen_string_literal: true

require "open3"
require "rbconfig"
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

Dir.mktmpdir("erpc-sdk-gem-") do |directory|
  Gem::Package.new(gem_path).extract_files(directory)
  library = File.join(directory, "lib")
  output, status = Open3.capture2e(
    RbConfig.ruby,
    "-I#{library}",
    "-rerpc_sdk",
    "-e",
    "abort unless ERPC::VERSION == #{ERPC::VERSION.inspect}"
  )
  raise "Packaged gem smoke test failed: #{output}" unless status.success?
end

puts "Verified erpc-sdk #{ERPC::VERSION} gem contents and load path."
