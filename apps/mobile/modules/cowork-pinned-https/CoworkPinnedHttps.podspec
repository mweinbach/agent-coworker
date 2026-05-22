require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'CoworkPinnedHttps'
  s.version        = package['version']
  s.summary        = 'Pinned HTTPS transport for Cowork Mobile'
  s.description    = 'Pinned HTTPS transport for Cowork Mobile.'
  s.license        = { :type => 'UNLICENSED' }
  s.author         = { 'Cowork' => 'support@cowork.local' }
  s.homepage       = 'https://github.com/mweinbach/agent-coworker'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => 'https://github.com/mweinbach/agent-coworker.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = 'ios/**/*.{h,m,mm,swift}'
end
