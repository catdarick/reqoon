# Updated by .github/workflows/release.yml on every release.
cask "reqoon" do
  version "0.1.2"
  sha256 "78cd3090e47935ab5e79b8de9d987902c1abe128457c59712a3d5087c511f90d"

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
