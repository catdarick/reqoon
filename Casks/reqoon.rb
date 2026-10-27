# Updated by .github/workflows/release.yml on every release.
cask "reqoon" do
  version "0.1.0"
  sha256 "368a08af5a0e5448b1d04b52732458623ade0e66af126401a0016e60687475b3"

  url "https://github.com/catdarick/reqoon/releases/download/v#{version}/Reqoon_#{version}_universal.dmg"
  name "Reqoon"
  desc "Local-first REST client built around OpenAPI specs"
  homepage "https://github.com/catdarick/reqoon"

  app "Reqoon.app"

  # The app isn't notarized; without this macOS refuses to open it.
  postflight do
    system_command "/usr/bin/xattr", args: ["-cr", "#{appdir}/Reqoon.app"]
  end

  zap trash: [
    "~/Library/Application Support/dev.reqoon.app",
    "~/Library/Caches/dev.reqoon.app",
    "~/Library/WebKit/dev.reqoon.app",
  ]
end
