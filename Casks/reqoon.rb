# Updated by .github/workflows/release.yml on every release.
cask "reqoon" do
  version "0.1.3"
  sha256 "2289b2e3a270078cefc96b14a853c9da91edd4bc1cb41f3daf7509539eba4a2a"

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
