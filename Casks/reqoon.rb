# Updated by .github/workflows/release.yml on every release.
cask "reqoon" do
  version "0.1.1"
  sha256 "3105a46105bc2b947cf8fd1980bebf44b7ed0a74e3bfba1868b64f27e714b924"

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
