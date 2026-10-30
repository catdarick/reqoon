# Updated by .github/workflows/release.yml on every release.
cask "reqoon" do
  version "0.1.4"
  sha256 "67ebb27c73e0635e7de2454b13ebb432bc8303b02e4c6fd2cfb7a03eecd4d88d"

  url "https://github.com/catdarick/reqoon/releases/download/v#{version}/Reqoon_#{version}_universal.dmg"
  name "Reqoon"
  desc "Local-first REST client built around OpenAPI specs"
  homepage "https://github.com/catdarick/reqoon"

  depends_on :macos

  app "Reqoon.app"

  # The app isn't notarized; without this macOS refuses to open it.
  postflight_steps do
    run "/usr/bin/xattr",
        args:           ["-cr", "{{appdir}}/Reqoon.app"],
        writable_paths: ["Reqoon.app"],
        writable_base:  :appdir
  end

  zap trash: [
    "~/Library/Application Support/dev.reqoon.app",
    "~/Library/Caches/dev.reqoon.app",
    "~/Library/WebKit/dev.reqoon.app",
  ]
end
